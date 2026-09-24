/**
 * Tests for MigrationOrchestrator's dual-write deleteMany mirror.
 *
 * Uses an in-memory fake Prisma client holding the old and shadow tables,
 * so no live Postgres is needed.
 */

import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { MigrationOrchestrator } from "../migrationOrchestrator";

type Row = { id: string; status: string };
type Middleware = (params: any, next: (params: any) => Promise<any>) => Promise<any>;

function makeFakePrisma(seed: Row[]) {
  const oldTable = new Map<string, Row>(seed.map(r => [r.id, { ...r }]));
  const shadowTable = new Map<string, Row>();
  const middlewares: Middleware[] = [];

  const matches = (row: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => (row as any)[k] === v);

  const prisma = {
    $use: (mw: Middleware) => middlewares.push(mw),
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
      if (sql.startsWith("INSERT INTO")) {
        const [id, status] = values as [string, string];
        shadowTable.set(id, { id, status });
      } else if (sql.startsWith("DELETE FROM")) {
        shadowTable.delete(values[0] as string);
      }
      return 1;
    },
    $queryRawUnsafe: async (_sql: string, pk: string) => {
      const row = oldTable.get(pk);
      return row ? [{ ...row }] : [];
    },
    testRow: {
      findMany: async ({ where }: { where?: Record<string, unknown> }) =>
        [...oldTable.values()].filter(r => matches(r, where)).map(r => ({ id: r.id })),
    },
  };

  /** Runs a deleteMany through the installed middleware chain. */
  async function deleteMany(
    where: Record<string, unknown>,
    duringDelete?: () => void,
  ) {
    const params = { model: "TestRow", action: "deleteMany", args: { where } };
    const next = async () => {
      let count = 0;
      for (const [id, row] of oldTable) {
        if (matches(row, where)) {
          oldTable.delete(id);
          count++;
        }
      }
      duringDelete?.();
      return { count };
    };
    const chain = middlewares.reduceRight<(p: any) => Promise<any>>(
      (nxt, mw) => p => mw(p, nxt),
      next,
    );
    return chain(params);
  }

  return { prisma: prisma as unknown as PrismaClient, oldTable, shadowTable, deleteMany };
}

async function setup() {
  const seed: Row[] = [
    { id: "a1", status: "archived" },
    { id: "a2", status: "archived" },
    { id: "e1", status: "expired" },
    { id: "e2", status: "expired" },
    { id: "k1", status: "active" },
  ];
  const fake = makeFakePrisma(seed);
  const orchestrator = new MigrationOrchestrator(fake.prisma, {
    modelName: "TestRow",
    tableName: "TestRow",
    shadowTableName: "TestRow_shadow",
    viewName: "TestRow_view",
    primaryKeyColumn: "id",
    columns: ["id", "status"],
  });
  await orchestrator.startDualWrite();
  // Simulate a completed backfill.
  for (const row of seed) fake.shadowTable.set(row.id, { ...row });
  return fake;
}

describe("MigrationOrchestrator deleteMany mirror", () => {
  it("scopes each deleteMany's shadow deletion to its own predicate", async () => {
    const fake = await setup();

    await fake.deleteMany({ status: "archived" });
    expect([...fake.shadowTable.keys()].sort()).toEqual(["e1", "e2", "k1"]);

    await fake.deleteMany({ status: "expired" });
    expect([...fake.shadowTable.keys()].sort()).toEqual(["k1"]);
  });

  it("does not delete shadow rows removed from the old table by an unrelated concurrent operation", async () => {
    const fake = await setup();

    // While the "archived" deleteMany is in flight, a different operation
    // (another deleteMany / manual cleanup) removes the "expired" rows.
    await fake.deleteMany({ status: "archived" }, () => {
      fake.oldTable.delete("e1");
      fake.oldTable.delete("e2");
    });

    const remaining = [...fake.shadowTable.keys()].sort();
    expect(remaining).not.toContain("a1");
    expect(remaining).not.toContain("a2");
    // The other operation's rows were never this call's to mirror.
    expect(remaining).toEqual(["e1", "e2", "k1"]);
  });
});
