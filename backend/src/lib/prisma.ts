import { PrismaClient } from "@prisma/client";
import { getTenantId, isBypassingTenant } from "./async-context";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres?schema=public";

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
