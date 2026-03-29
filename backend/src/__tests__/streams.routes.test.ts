import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { PrismaClient, StreamStatus } from "@prisma/client";
import streamRoutes from "../routes/streams";

const prisma = new PrismaClient();

const app = express();
app.use(express.json());
app.use("/api/streams", streamRoutes);

// Seed helpers
async function seedStream(overrides: Partial<{
  streamId: number; creator: string; recipient: string;
  amount: bigint; status: StreamStatus; txHash: string;
}> = {}) {
  return prisma.stream.create({
    data: {
      streamId: overrides.streamId ?? Math.floor(Math.random() * 1_000_000),
      creator: overrides.creator ?? "GCREATOR_DEFAULT",
      recipient: overrides.recipient ?? "GRECIPIENT_DEFAULT",
      amount: overrides.amount ?? BigInt("5000000000"),
      status: overrides.status ?? StreamStatus.CREATED,
      txHash: overrides.txHash ?? `tx-${Math.random().toString(36).slice(2)}`,
    },
  });
}

describe("Stream Routes", () => {
  beforeEach(async () => {
    await prisma.stream.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // GET /api/streams/:id
  // -------------------------------------------------------------------------

  describe("GET /api/streams/:id", () => {
    it("returns a stream by id", async () => {
      const s = await seedStream({ streamId: 42 });
      const res = await request(app).get("/api/streams/42");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.streamId).toBe(42);
      expect(res.body.data.amount).toBe(s.amount.toString()); // BigInt as string
    });

    it("returns 404 for unknown id", async () => {
      const res = await request(app).get("/api/streams/99999");
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-numeric id", async () => {
      const res = await request(app).get("/api/streams/abc");
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/streams/creator/:address
  // -------------------------------------------------------------------------

  describe("GET /api/streams/creator/:address", () => {
    it("returns streams for creator", async () => {
      await seedStream({ creator: "GCREATOR_A", streamId: 1, txHash: "tx-1" });
      await seedStream({ creator: "GCREATOR_A", streamId: 2, txHash: "tx-2" });
      await seedStream({ creator: "GCREATOR_B", streamId: 3, txHash: "tx-3" });

      const res = await request(app).get("/api/streams/creator/GCREATOR_A");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.every((s: any) => s.creator === "GCREATOR_A")).toBe(true);
    });

    it("filters by status", async () => {
      await seedStream({ creator: "GCREATOR_A", streamId: 10, txHash: "tx-10", status: StreamStatus.CREATED });
      await seedStream({ creator: "GCREATOR_A", streamId: 11, txHash: "tx-11", status: StreamStatus.CLAIMED });

      const res = await request(app).get("/api/streams/creator/GCREATOR_A?status=CLAIMED");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe("CLAIMED");
    });

    it("returns 400 for invalid status", async () => {
      const res = await request(app).get("/api/streams/creator/GCREATOR_A?status=INVALID");
      expect(res.status).toBe(400);
    });

    it("respects limit and offset pagination", async () => {
      for (let i = 20; i < 25; i++) {
        await seedStream({ creator: "GCREATOR_PAGE", streamId: i, txHash: `tx-page-${i}` });
      }
      const res = await request(app).get("/api/streams/creator/GCREATOR_PAGE?limit=2&offset=0");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it("returns empty array for unknown creator", async () => {
      const res = await request(app).get("/api/streams/creator/GUNKNOWN");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/streams/recipient/:address
  // -------------------------------------------------------------------------

  describe("GET /api/streams/recipient/:address", () => {
    it("returns streams for recipient", async () => {
      await seedStream({ recipient: "GRECIPIENT_A", streamId: 30, txHash: "tx-30" });
      await seedStream({ recipient: "GRECIPIENT_B", streamId: 31, txHash: "tx-31" });

      const res = await request(app).get("/api/streams/recipient/GRECIPIENT_A");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].recipient).toBe("GRECIPIENT_A");
    });

    it("filters by status for recipient", async () => {
      await seedStream({ recipient: "GRECIPIENT_A", streamId: 40, txHash: "tx-40", status: StreamStatus.CANCELLED });
      await seedStream({ recipient: "GRECIPIENT_A", streamId: 41, txHash: "tx-41", status: StreamStatus.CREATED });

      const res = await request(app).get("/api/streams/recipient/GRECIPIENT_A?status=CANCELLED");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe("CANCELLED");
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/streams/stats/:address?
  // -------------------------------------------------------------------------

  describe("GET /api/streams/stats/:address?", () => {
    it("returns global stats", async () => {
      await seedStream({ streamId: 50, txHash: "tx-50", status: StreamStatus.CLAIMED, amount: BigInt("1000") });
      await seedStream({ streamId: 51, txHash: "tx-51", status: StreamStatus.CREATED, amount: BigInt("2000") });

      const res = await request(app).get("/api/streams/stats");
      expect(res.status).toBe(200);
      expect(res.body.data.totalStreams).toBe(2);
      expect(res.body.data.activeStreams).toBe(1);
      expect(res.body.data.claimedVolume).toBe("1000");
    });

    it("returns address-scoped stats", async () => {
      await seedStream({ creator: "GSCOPED", streamId: 60, txHash: "tx-60", status: StreamStatus.CLAIMED, amount: BigInt("500") });
      await seedStream({ creator: "GOTHER", streamId: 61, txHash: "tx-61", status: StreamStatus.CLAIMED, amount: BigInt("999") });

      const res = await request(app).get("/api/streams/stats/GSCOPED");
      expect(res.status).toBe(200);
      expect(res.body.data.totalStreams).toBe(1);
      expect(res.body.data.claimedVolume).toBe("500");
    });
  });

  // -------------------------------------------------------------------------
  // BigInt serialization safety
  // -------------------------------------------------------------------------

  describe("BigInt serialization", () => {
    it("serializes large amounts as strings", async () => {
      const large = BigInt("9007199254740993"); // > Number.MAX_SAFE_INTEGER
      await seedStream({ streamId: 70, txHash: "tx-70", amount: large });

      const res = await request(app).get("/api/streams/70");
      expect(res.status).toBe(200);
      expect(res.body.data.amount).toBe("9007199254740993");
      expect(typeof res.body.data.amount).toBe("string");
    });
  });
});
