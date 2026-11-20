import { PrismaClient } from "@prisma/client";
import { getTenantId, isBypassingTenant } from "./async-context";

/**
 * Appends Prisma connection-pool query parameters derived from the
 * DB_POOL_MAX / DB_CONNECT_TIMEOUT_MS env vars (see lib/db.ts) onto `baseUrl`:
 *   DB_POOL_MAX           -> connection_limit
 *   DB_CONNECT_TIMEOUT_MS -> pool_timeout (Prisma expects seconds, rounded up)
 *
 * Parameters the operator already set on DATABASE_URL always win and are
 * never overwritten. Malformed or non-positive env values are ignored.
 */
export function buildConnectionString(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  let existing: URLSearchParams;
  try {
    existing = new URL(baseUrl).searchParams;
  } catch {
    return baseUrl;
  }

  const positiveInt = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const additions = new URLSearchParams();
  const addIfAbsent = (param: string, value: number | null) => {
    if (value === null || existing.has(param)) return;
    additions.set(param, String(value));
  };

  addIfAbsent("connection_limit", positiveInt(env.DB_POOL_MAX));

  const timeoutMs = positiveInt(env.DB_CONNECT_TIMEOUT_MS);
  addIfAbsent("pool_timeout", timeoutMs === null ? null : Math.ceil(timeoutMs / 1000));

  const suffix = additions.toString();
  if (!suffix) return baseUrl;

  // Append rather than re-serialize so the operator's existing parameters
  // keep their exact original encoding.
  const hashIndex = baseUrl.indexOf("#");
  const beforeHash = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : baseUrl.slice(hashIndex);

  let sep = "&";
  if (!beforeHash.includes("?")) sep = "?";
  else if (beforeHash.endsWith("?") || beforeHash.endsWith("&")) sep = "";

  return `${beforeHash}${sep}${suffix}${hash}`;
}

/**
 * Local-only fallback used when DATABASE_URL is unset. This is intentionally
 * restricted to development/test: in production a missing DATABASE_URL is a
 * misconfiguration and must fail fast rather than silently connecting to a
 * default-credential database.
 */
const DEV_FALLBACK_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/postgres?schema=public";

/**
 * Resolves the base DATABASE_URL for the Prisma client.
 *
 * - In `NODE_ENV=production`, a missing DATABASE_URL throws a clear error so
 *   the process fails fast instead of falling back to default credentials.
 * - In `development` / `test` (or any non-production env), the local fallback
 *   above is used for convenience and a log line notes the dev fallback.
 */
export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string {
  const url = env.DATABASE_URL;
  if (url && url.length > 0) return url;

  if (env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is not set. Refusing to start in production without an " +
        "explicit database connection string (no default-credential fallback)."
    );
  }

  console.warn(
    "[db] DATABASE_URL is not set; using local development fallback " +
      "(postgres:postgres@localhost). This fallback is disabled in production."
  );

  return DEV_FALLBACK_DATABASE_URL;
}

const connectionString = buildConnectionString(resolveDatabaseUrl());

const globalForPrisma = globalThis as unknown as {
  _baseprisma: PrismaClient | undefined;
};

const TENANT_SCOPED_MODELS = new Set([
  "WebhookSubscription",
  "BuybackCampaign",
  "DividendPool",
]);

const TENANT_FILTERED_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "updateMany",
  "deleteMany",
]);

const baseClient =
  globalForPrisma._baseprisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
    datasources: {
      db: {
        url: connectionString,
      },
    },
  });

const extendedClient = baseClient.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }: any) {
        if (
          model &&
          TENANT_SCOPED_MODELS.has(model) &&
          TENANT_FILTERED_OPS.has(operation)
        ) {
          const tenantId = getTenantId();
          const bypass = isBypassingTenant();
          if (!bypass && tenantId) {
            args = {
              ...args,
              where: { ...((args as any).where ?? {}), tenantId },
            };
          }
        }
        return query(args);
      },
    },
  },
});

export type ExtendedPrismaClient = typeof extendedClient;

/**
 * The tenant-scoped client, typed as the plain `PrismaClient` it wraps so it
 * remains a drop-in replacement everywhere `PrismaClient` is already the
 * expected parameter type. `$extends()` returns a structurally different
 * type that's missing `$on`/`$use` — callers that genuinely need those
 * (query middleware, event listeners) should use `baseClient` instead.
 */
export const prisma = extendedClient as unknown as PrismaClient;

/**
 * The un-extended, non-tenant-scoped client. Use only for infrastructure
 * that hooks into `$on`/`$use` (connection-pool metrics, query tracing) —
 * application code should use `prisma`.
 */
export { baseClient };

if (process.env.NODE_ENV !== "production") {
  globalForPrisma._baseprisma = baseClient;
}

export default prisma;
