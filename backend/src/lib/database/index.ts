import { PrismaClient } from "@prisma/client";

const DEV_FALLBACK_URL =
  "postgresql://postgres:postgres@localhost:5432/postgres?schema=public";

function resolveConnectionString(): string {
  const configured = process.env.DATABASE_URL;
  if (configured) {
    return configured;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is not set. Refusing to start in production without an explicit database connection string."
    );
  }

  console.warn(
    "[database] DATABASE_URL is not set; falling back to the local development connection string. This fallback is disabled in production."
  );
  return DEV_FALLBACK_URL;
}

const connectionString = resolveConnectionString();

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
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

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
