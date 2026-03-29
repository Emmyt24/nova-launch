import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { PrismaClient, StreamStatus } from "@prisma/client";
import vaultRoutes from "../routes/vaults";

const prisma = new PrismaClient();

const app = express();
app.use(express.json());
app.use("/api/vaults", vaultRoutes);

async function seedVault(overrides: Partial<{
  streamId: number; creator: string; recipient: string;
  amount: bigint; status: StreamStatus; txHash: string;
}> = {}) {
  return prisma.stream.create({
    data: {
      streamId: overrides.streamId ?? Math.floor(Math.random() * 1_000_000),
      creator: overrides.creator ?? "GCREATOR_VAULT",
      recipient: overrides.recipient ?? "GBENEFICIARY_VAULT",
      amount: overrides.amount ?? BigInt("8000000000"),
      status: overrides.status ?? StreamStatus.CREATED,
      txHash: overrides.txHash ?? `tx-v-${Math.random().toString(36).slice(2)}`,
    },
  });
}

describe("Vault Routes", () => {
  beforeEach(async () => {
    await prisma.stream.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // GET /api/vaults/:id
  // -------------------------------------------------------------------------

  describe("GET /api/vaults/:id", () => {
    it("returns a vault by id", async () => {
      const v = await seedVault({ streamId: 200 });
      const res = await request(app).get("/api/vaults/200");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.streamId).toBe(200);
      expect(res.body.data.amount).toBe(v.amount.toString());
    });

    it("returns 404 for unknown vault", async () => {
      const res = await request(app).get("/api/vaults/99999");
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-numeric id", async () => {
      const res = await request(app).get("/api/vaults/xyz");
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/vaults/creator/:address
  // -------------------------------------------------------------------------

  describe("GET /api/vaults/creator/:address", () => {
    it("returns vaults for creator", async () => {
      await seedVault({ creator: "GCREATOR_V1", streamId: 210, txHash: "tx-v-210" });
      await seedVault({ creator: "GCREATOR_V1", streamId: 211, txHash: "tx-v-211" });
      await seedVault({ creator: "GCREATOR_V2", streamId: 212, txHash: "tx-v-212" });

      const res = await request(app).get("/api/vaults/creator/GCREATOR_V1");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.every((v: any) => v.creator === "GCREATOR_V1")).toBe(true);
    });

    it("filters by status", async () => {
      await seedVault({ creator: "GCREATOR_V1", streamId: 220, txHash: "tx-v-220", status: StreamStatus.CLAIMED });
      await seedVault({ creator: "GCREATOR_V1", streamId: 221, txHash: "tx-v-221", status: StreamStatus.CREATED });

      const res = await request(app).get("/api/vaults/creator/GCREATOR_V1?status=CLAIMED");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe("CLAIMED");
    });

    it("returns 400 for invalid status", async () => {
      const res = await request(app).get("/api/vaults/creator/GCREATOR_V1?status=BOGUS");
      expect(res.status).toBe(400);
    });

    it("respects pagination", async () => {
      for (let i = 230; i < 235; i++) {
        await seedVault({ creator: "GCREATOR_PAGE", streamId: i, txHash: `tx-v-${i}` });
      }
      const res = await request(app).get("/api/vaults/creator/GCREATOR_PAGE?limit=3&offset=0");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/vaults/beneficiary/:address
  // -------------------------------------------------------------------------

  describe("GET /api/vaults/beneficiary/:address", () => {
    it("returns vaults for beneficiary", async () => {
      await seedVault({ recipient: "GBENEFICIARY_A", streamId: 240, txHash: "tx-v-240" });
      await seedVault({ recipient: "GBENEFICIARY_B", streamId: 241, txHash: "tx-v-241" });

      const res = await request(app).get("/api/vaults/beneficiary/GBENEFICIARY_A");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].recipient).toBe("GBENEFICIARY_A");
    });

    it("filters beneficiary vaults by status", async () => {
      await seedVault({ recipient: "GBENEFICIARY_A", streamId: 250, txHash: "tx-v-250", status: StreamStatus.CANCELLED });
      await seedVault({ recipient: "GBENEFICIARY_A", streamId: 251, txHash: "tx-v-251", status: StreamStatus.CREATED });

      const res = await request(app).get("/api/vaults/beneficiary/GBENEFICIARY_A?status=CANCELLED");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe("CANCELLED");
    });

    it("returns empty array for unknown beneficiary", async () => {
      const res = await request(app).get("/api/vaults/beneficiary/GUNKNOWN");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // BigInt serialization safety
  // -------------------------------------------------------------------------

  describe("BigInt serialization", () => {
    it("serializes large vault amounts as strings", async () => {
      const large = BigInt("18446744073709551615"); // u64::MAX
      await seedVault({ streamId: 260, txHash: "tx-v-260", amount: large });

      const res = await request(app).get("/api/vaults/260");
      expect(res.status).toBe(200);
      expect(res.body.data.amount).toBe("18446744073709551615");
      expect(typeof res.body.data.amount).toBe("string");
    });
  });
});
