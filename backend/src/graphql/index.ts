/**
 * Mounts the GraphQL endpoint on an Express router.
 *
 * Endpoint: POST /api/graphql
 *
 * Uses `graphql-http` (spec-compliant, no Apollo overhead).
 * Introspection is disabled in production to reduce attack surface.
 *
 * Security:
 *  - Depth limit: rejects queries nested deeper than MAX_DEPTH (default 6,
 *    configurable via GRAPHQL_MAX_DEPTH env var)
 *  - Complexity limit: rejects queries whose cost score exceeds MAX_COMPLEXITY
 *    (default 100, configurable via GRAPHQL_MAX_COMPLEXITY env var). Scoring
 *    is computed with the `graphql-query-complexity` library using
 *    `simpleEstimator({ defaultComplexity: 1 })` (every scalar/object field
 *    costs 1) plus a custom estimator that scores fields in LIST_FIELDS at
 *    LIST_FIELD_COST (default 10, configurable via GRAPHQL_LIST_FIELD_COST)
 *    to account for N-row fan-out, summed with child complexity per level.
 *    This guards against N+1 resolver abuse from deeply nested list queries.
 *    Queries over budget are rejected with HTTP 400 and a `QUERY_TOO_COMPLEX`
 *    error code in `errors[0].extensions.code`. The computed score is always
 *    echoed back in the top-level response `extensions.complexity` /
 *    `extensions.maxComplexity`, on both accepted and rejected queries, to
 *    aid client-side debugging.
 *  - No mutations exposed — all writes go through the existing REST layer
 *  - Rate limiting is inherited from the global Express rate limiter in index.ts
 *
 * Example complexity scores (budget 100, LIST_FIELD_COST 10) computed by the
 * estimator below, against the schema in `./schema.ts`:
 *
 *   query { tokens(limit: 10) { id address name symbol } }
 *     -> 14  (10 for `tokens` + 4 scalar selections, accepted)
 *
 *   query { token(address: "x") { id address name } }
 *     -> 4   (non-list field, 1 per scalar selection, accepted)
 *
 *   query {
 *     tokens(limit: 10) {
 *       id name
 *       burnRecords(limit: 10) { id amount }
 *     }
 *   }
 *     -> 24  (10 for `tokens` + 2 scalars + 10 for nested `burnRecords` + 2
 *             scalars, accepted)
 *
 *   query {
 *     a: tokens { burnRecords { id } }
 *     b: tokens { burnRecords { id } }
 *     c: tokens { burnRecords { id } }
 *     d: tokens { burnRecords { id } }
 *     e: tokens { burnRecords { id } }
 *   }
 *     -> 105 (5 aliased `tokens -> burnRecords` trees at 21 each, REJECTED:
 *             exceeds the 100 budget with QUERY_TOO_COMPLEX)
 */

import { Router } from "express";
import { createHandler } from "graphql-http/lib/use/express";
import type { Response as GraphqlHttpResponse } from "graphql-http";
import {
  buildSchema,
  execute,
  subscribe,
  getOperationAST,
  GraphQLError,
  parse,
  validate,
} from "graphql";
import {
  getComplexity,
  simpleEstimator,
  type ComplexityEstimator,
} from "graphql-query-complexity";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/use/ws";
import type { Server } from "http";
import { typeDefs } from "./schema";
import { resolvers } from "./resolvers";
import {
  extractTenantFromJwt,
  type TenantContext,
} from "../middleware/tenancy";
import {
  SLOW_CONSUMER_THRESHOLD,
  createSubscriptionMetrics,
} from "./subscriptions";
import { tenantComplexityBudgetService } from "../services/tenantComplexityBudgetService";

const MAX_DEPTH = parseInt(process.env.GRAPHQL_MAX_DEPTH ?? "6", 10);
const MAX_COMPLEXITY = parseInt(
  process.env.GRAPHQL_MAX_COMPLEXITY ?? "100",
  10
);
// Fields returning lists are more expensive due to N-row fan-out.
const LIST_FIELD_COST = parseInt(
  process.env.GRAPHQL_LIST_FIELD_COST ?? "10",
  10
);

/** Fields known to return lists (fan-out multiplier applied). */
const LIST_FIELDS = new Set([
  "tokens",
  "burnRecords",
  "streams",
  "proposals",
  "votes",
]);

function maxQueryDepth(node: any, depth = 0): number {
  if (!node || typeof node !== "object") return depth;
  if (node.selectionSet?.selections) {
    return Math.max(
      ...node.selectionSet.selections.map((s: any) =>
        maxQueryDepth(s, depth + 1)
      )
    );
  }
  return depth;
}

/**
 * Custom `graphql-query-complexity` estimator: fields in LIST_FIELDS are
 * scored at LIST_FIELD_COST plus the complexity of their child selections,
 * to account for the N-row fan-out that nested list fields incur (the N+1
 * resolver pattern this whole module guards against). Returning `undefined`
 * defers to the next estimator in the chain (`simpleEstimator`), which scores
 * every other field at 1.
 */
const listFieldEstimator: ComplexityEstimator = ({ field, childComplexity }) =>
  LIST_FIELDS.has(field.name) ? LIST_FIELD_COST + childComplexity : undefined;

export const schema = buildSchema(typeDefs);

// `buildSchema` produces a schema with no executable resolvers. Queries are
// served via `rootValue` (graphql-http, below), but subscription fields need
// their `subscribe`/`resolve` functions attached directly to the schema so the
// graphql-ws transport can drive them.
const subscriptionType = schema.getSubscriptionType();
if (subscriptionType) {
  const fields = subscriptionType.getFields();
  for (const [name, def] of Object.entries(resolvers.Subscription)) {
    const field = fields[name];
    if (field) {
      (field as any).subscribe = def.subscribe;
      (field as any).resolve = def.resolve;
    }
  }
}

/** Flat rootValue merging all resolver namespaces for graphql-http. */
const rootValue = {
  ...resolvers.Query,
  // Field resolvers for nested types are handled inside the Query resolvers
  // by fetching relations lazily (see resolvers.ts Token.burnRecords etc.)
};

// ---------------------------------------------------------------------------
// GraphQL-WS subscription transport
// ---------------------------------------------------------------------------

/** Max concurrent subscription operations per WebSocket connection — guards
 *  against subscription amplification from a single client. */
const MAX_SUBSCRIPTIONS_PER_CONNECTION = parseInt(
  process.env.GRAPHQL_MAX_SUBSCRIPTIONS_PER_CONNECTION ?? "10",
  10
);

interface ConnectionExtra {
  tenant?: TenantContext;
  /** IDs of in-flight subscription operations counted toward the cap. */
  activeSubscriptionIds: Set<string>;
  /** Running count of messages queued but not yet delivered (backpressure). */
  queueDepth: number;
}

/**
 * Resolve the tenant from graphql-ws `connection_init` payload using the same
 * JWT validation as the REST tenancy middleware. Accepts the token via an
 * `authorization` / `Authorization` ("Bearer <jwt>") field or a bare
 * `authToken` field. Returns null when no valid tenant can be derived.
 */
function resolveTenantFromConnectionParams(
  params: Record<string, unknown> | undefined
): TenantContext | null {
  if (!params) return null;
  const secret = process.env.JWT_SECRET ?? "dev-secret-key";

  const raw = params.authorization ?? params.Authorization ?? params.authToken;
  if (typeof raw !== "string" || raw.length === 0) return null;

  const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
  return extractTenantFromJwt(token, secret);
}

/** True when the incoming operation is a `subscription` (vs query/mutation). */
function isSubscriptionOperation(
  query: string,
  operationName?: string | null
): boolean {
  try {
    const op = getOperationAST(parse(query), operationName ?? undefined);
    return op?.operation === "subscription";
  } catch {
    return false;
  }
}

/**
 * Attach the graphql-ws subscription server to the existing HTTP server on the
 * `/graphql` WebSocket path. Authentication + tenant resolution happen on the
 * `connection_init` handshake; unauthenticated connections are rejected.
 */
export function attachGraphqlSubscriptions(
  httpServer: Server
): WebSocketServer {
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/graphql",
  });

  const subMetrics = createSubscriptionMetrics();

  useServer(
    {
      schema,
      execute,
      subscribe,
      roots: { query: rootValue, mutation: rootValue, subscription: rootValue },

      // Validate the JWT on the connection_init handshake and stash the tenant.
      onConnect: (ctx) => {
        const tenant = resolveTenantFromConnectionParams(
          ctx.connectionParams as Record<string, unknown> | undefined
        );
        if (!tenant) return false; // reject handshake → 4403 Forbidden close

        const extra = ctx.extra as unknown as ConnectionExtra;
        extra.tenant = tenant;
        extra.activeSubscriptionIds = new Set();
        extra.queueDepth = 0;
        return true;
      },

      // Expose the resolved tenant to subscription resolvers.
      context: (ctx) => ({
        tenant: (ctx.extra as unknown as ConnectionExtra)?.tenant,
      }),

      // Enforce the per-connection concurrent-subscription cap.
      onSubscribe: (ctx, id, payload) => {
        if (
          !isSubscriptionOperation(payload.query, payload.operationName)
        ) {
          return undefined; // queries/mutations don't count toward the cap
        }
        const extra = ctx.extra as unknown as ConnectionExtra;
        if (
          extra.activeSubscriptionIds.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION
        ) {
          return [
            new GraphQLError(
              `Subscription limit of ${MAX_SUBSCRIPTIONS_PER_CONNECTION} concurrent subscriptions per connection exceeded`
            ),
          ];
        }
        extra.activeSubscriptionIds.add(id);
        return undefined;
      },

      // Track outbound message queue depth; disconnect slow consumers.
      onNext: (ctx, _id, _payload, _args, result) => {
        const extra = ctx.extra as unknown as ConnectionExtra;
        extra.queueDepth = (extra.queueDepth ?? 0) + 1;

        if (extra.queueDepth > SLOW_CONSUMER_THRESHOLD) {
          subMetrics.slowConsumerDisconnected.inc();
          // Close the raw WebSocket — graphql-ws provides it via ctx.extra.socket
          const socket = (ctx.extra as any).socket;
          if (socket) {
            socket.close(1008, "Policy Violation: slow consumer");
          }
          return result; // return as-is; the socket close suppresses actual delivery
        }

        return result;
      },

      // Decrement depth when a message is acknowledged (onComplete of a subscribe op).
      onComplete: (ctx, id) => {
        const extra = ctx.extra as unknown as ConnectionExtra;
        extra?.activeSubscriptionIds?.delete(id);
        if (extra?.queueDepth !== undefined && extra.queueDepth > 0) {
          extra.queueDepth -= 1;
        }
      },

      onError: (ctx, id) => {
        (
          ctx.extra as unknown as ConnectionExtra
        )?.activeSubscriptionIds?.delete(id);
      },
    },
    wsServer
  );

  console.log("[GraphQL-WS] Subscription server attached at /graphql");
  return wsServer;
}

const router = Router();

/**
 * Tracks both the computed complexity score and the budget for the in-flight request
 * so they can be attached to the response `extensions` from `onOperation`.
 * Keyed by the `graphql-http` request object reference, which is identical
 * across both hooks for a single HTTP call; entries are removed once read so
 * the map can't grow unbounded.
 */
interface RequestComplexityInfo {
  complexity: number;
  budget: number;
}

const complexityByRequest = new WeakMap<object, RequestComplexityInfo>();

/** Builds the `400 Bad Request` response body/init tuple graphql-http expects
 *  when returned directly from `onSubscribe`, guaranteeing the HTTP status is
 *  400 regardless of the request's `Accept` header (unlike returning a plain
 *  `GraphQLError[]`, whose status depends on content negotiation). */
function tooComplexResponse(
  complexity: number,
  maxComplexity: number
): GraphqlHttpResponse {
  const message = `Query complexity ${complexity} exceeds maximum allowed budget of ${maxComplexity}`;
  return [
    JSON.stringify({
      errors: [
        {
          message,
          extensions: {
            code: "QUERY_TOO_COMPLEX",
            complexity,
            maxComplexity,
          },
        },
      ],
      extensions: { complexity, maxComplexity },
    }),
    {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  ];
}

router.all(
  "/",
  createHandler({
    schema,
    rootValue,
    async onSubscribe(req, params) {
      // Disable introspection in production
      if (
        process.env.NODE_ENV === "production" &&
        typeof params.query === "string" &&
        params.query.includes("__schema")
      ) {
        return [new GraphQLError("Introspection is disabled in production")];
      }

      if (typeof params.query === "string") {
        try {
          const doc = parse(params.query);
          const errors = validate(schema, doc);
          if (errors.length) return errors;

          const depth = Math.max(
            ...doc.definitions.map((def: any) => maxQueryDepth(def))
          );
          if (depth > MAX_DEPTH) {
            return [
              new GraphQLError(
                `Query depth ${depth} exceeds maximum allowed depth of ${MAX_DEPTH}`
              ),
            ];
          }

          const complexity = getComplexity({
            schema,
            query: doc,
            operationName: params.operationName ?? undefined,
            variables: (params.variables as Record<string, unknown>) ?? {},
            estimators: [
              listFieldEstimator,
              simpleEstimator({ defaultComplexity: 1 }),
            ],
          });

          // Get tenant-specific complexity budget
          const tenant = (req as any).tenant as TenantContext | undefined;
          const budget = await tenantComplexityBudgetService.getBudgetForTenant(tenant);

          if (complexity > budget) {
            return tooComplexResponse(complexity, budget);
          }

          // Stash the score and budget so onOperation can echo them back in `extensions`
          // for accepted queries too.
          complexityByRequest.set(req, { complexity, budget });
        } catch {
          return [new GraphQLError("Failed to parse query")];
        }
      }

      return undefined;
    },
    onOperation(req, _args, result) {
      const info = complexityByRequest.get(req);
      if (info === undefined) return undefined;
      complexityByRequest.delete(req);

      return {
        ...result,
        extensions: {
          ...result.extensions,
          complexity: info.complexity,
          maxComplexity: info.budget,
        },
      };
    },
  })
);

export default router;
