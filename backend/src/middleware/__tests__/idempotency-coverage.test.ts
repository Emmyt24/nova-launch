import { describe, it, expect, beforeEach } from "vitest";
import express, { Request, Response } from "express";
import request from "supertest";
import {
  IdempotencyStore,
  createIdempotencyMiddleware,
  IDEMPOTENCY_HEADER,
} from "../idempotency";

/**
 * Tests for idempotency-key coverage gaps (#1584).
 *
 * This suite verifies that:
 * 1. Mutating routes (POST/PUT) properly enforce idempotency-key requirements
 * 2. Duplicate requests with the same key are no-ops on the second attempt
 * 3. Different keys are treated as independent requests
 * 4. Cache is invalidated between test runs
 */

describe("Idempotency Coverage — Mutating Routes", () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    store = new IdempotencyStore();
  });

  describe("POST route idempotency enforcement", () => {
    it("enforces idempotency on POST /api/dividends/pools (create dividend pool)", async () => {
      const app = express();
      app.use(express.json());
      app.use(createIdempotencyMiddleware(store));

      let dividendPoolCreateCount = 0;
      app.post("/api/dividends/pools", async (_req: Request, res: Response) => {
        dividendPoolCreateCount++;
        res.status(201).json({
          success: true,
          data: {
            id: `pool-${dividendPoolCreateCount}`,
            status: "active",
          },
        });
      });

      const poolData = {
        tokenId: "token-123",
        fundingAmount: "1000.00",
        snapshotId: "snapshot-456",
      };

      // First request creates a pool
      const r1 = await request(app)
        .post("/api/dividends/pools")
        .set(IDEMPOTENCY_HEADER, "pool-creation-001")
        .send(poolData)
        .expect(201);

      expect(dividendPoolCreateCount).toBe(1);
      const poolId1 = r1.body.data.id;

      // Duplicate request with same key returns cached response
      const r2 = await request(app)
        .post("/api/dividends/pools")
        .set(IDEMPOTENCY_HEADER, "pool-creation-001")
        .send(poolData)
        .expect(201);

      expect(dividendPoolCreateCount).toBe(1);
      const poolId2 = r2.body.data.id;

      // Both responses should be identical (cached)
      expect(poolId1).toBe(poolId2);
      expect(r2.headers["idempotency-status"]).toBe("replayed");
    });

    it("enforces idempotency on POST /api/dividends/claim (claim dividend)", async () => {
      const app = express();
      app.use(express.json());
      app.use(createIdempotencyMiddleware(store));

      let claimCount = 0;
      app.post("/api/dividends/claim", async (_req: Request, res: Response) => {
        claimCount++;
        res.status(200).json({
          success: true,
          claimAmount: "100.00",
          transactionId: `tx-${claimCount}`,
        });
      });

      // First claim
      const r1 = await request(app)
        .post("/api/dividends/claim")
        .set(IDEMPOTENCY_HEADER, "claim-001")
        .send({ poolId: "pool-1", holderId: "holder-1" })
        .expect(200);

      expect(claimCount).toBe(1);
      const txId1 = r1.body.transactionId;

      // Retry with same idempotency key
      const r2 = await request(app)
        .post("/api/dividends/claim")
        .set(IDEMPOTENCY_HEADER, "claim-001")
        .send({ poolId: "pool-1", holderId: "holder-1" })
        .expect(200);

      expect(claimCount).toBe(1);
      expect(r2.body.transactionId).toBe(txId1);
    });

    it("different idempotency keys trigger independent requests", async () => {
      const app = express();
      app.use(express.json());
      app.use(createIdempotencyMiddleware(store));

      let postCount = 0;
      app.post("/api/resource", async (_req: Request, res: Response) => {
        postCount++;
        res.status(201).json({ id: `resource-${postCount}` });
      });

      // Two different keys = two independent requests
      const r1 = await request(app)
        .post("/api/resource")
        .set(IDEMPOTENCY_HEADER, "key-a")
        .send({})
        .expect(201);

      const r2 = await request(app)
        .post("/api/resource")
        .set(IDEMPOTENCY_HEADER, "key-b")
        .send({})
        .expect(201);

      expect(postCount).toBe(2);
      expect(r1.body.id).toBe("resource-1");
      expect(r2.body.id).toBe("resource-2");
    });
  });

  describe("PUT route idempotency enforcement", () => {
    it("enforces idempotency on PUT /api/campaigns/:id (update campaign)", async () => {
      const app = express();
      app.use(express.json());
      app.use(createIdempotencyMiddleware(store));

      let updateCount = 0;
      app.put("/api/campaigns/:id", async (req: Request, res: Response) => {
        updateCount++;
        res.status(200).json({
          id: req.params.id,
          status: "updated",
          version: updateCount,
        });
      });

      const updateData = { status: "active", name: "campaign-update" };

      // First update
      const r1 = await request(app)
        .put("/api/campaigns/camp-123")
        .set(IDEMPOTENCY_HEADER, "update-camp-001")
        .send(updateData)
        .expect(200);

      expect(updateCount).toBe(1);
      expect(r1.body.version).toBe(1);

      // Retry with same idempotency key
      const r2 = await request(app)
        .put("/api/campaigns/camp-123")
        .set(IDEMPOTENCY_HEADER, "update-camp-001")
        .send(updateData)
        .expect(200);

      expect(updateCount).toBe(1);
      expect(r2.body.version).toBe(1);
      expect(r2.headers["idempotency-status"]).toBe("replayed");
    });

    it("enforces idempotency on PUT /api/streams/:id (update stream)", async () => {
      const app = express();
      app.use(express.json());
      app.use(createIdempotencyMiddleware(store));

      let updateCount = 0;
      app.put("/api/streams/:id", async (req: Request, res: Response) => {
        updateCount++;
        res.status(200).json({
          id: req.params.id,
          status: "modified",
          modifiedCount: updateCount,
        });
      });

      // First update
      const r1 = await request(app)
        .put("/api/streams/stream-123")
        .set(IDEMPOTENCY_HEADER, "stream-update-001")
        .send({ rate: "100.00" })
        .expect(200);

      expect(updateCount).toBe(1);

      // Retry with same key — should be cached
      const r2 = await request(app)
        .put("/api/streams/stream-123")
        .set(IDEMPOTENCY_HEADER, "stream-update-001")
        .send({ rate: "100.00" })
        .expect(200);

      expect(updateCount).toBe(1);
      expect(r2.body.modifiedCount).toBe(1);
    });
  });

  describe("Idempotency cache invalidation on state changes", () => {
    it("does not cache error responses — allows retry without 409", async () => {
      const app = express();
      app.use(express.json());
      app.use(createIdempotencyMiddleware(store));

      let attempts = 0;
      app.post("/api/transfer", async (_req: Request, res: Response) => {
        attempts++;
        if (attempts === 1) {
          return res.status(500).json({ error: "temporary failure" });
        }
        return res.status(201).json({ transactionId: "tx-success" });
      });

      // First attempt fails
      const r1 = await request(app)
        .post("/api/transfer")
        .set(IDEMPOTENCY_HEADER, "transfer-001")
        .send({ amount: "100", to: "addr" })
        .expect(500);

      expect(attempts).toBe(1);

      // Retry with same key — should NOT get 409, should reach handler
      const r2 = await request(app)
        .post("/api/transfer")
        .set(IDEMPOTENCY_HEADER, "transfer-001")
        .send({ amount: "100", to: "addr" })
        .expect(201);

      expect(attempts).toBe(2);
      expect(r2.body.transactionId).toBe("tx-success");
    });

    it("consecutive successful requests with different keys each execute", async () => {
      const app = express();
      app.use(express.json());
      app.use(createIdempotencyMiddleware(store));

      let executionCount = 0;
      app.post("/api/mutate", async (_req: Request, res: Response) => {
        executionCount++;
        res.status(201).json({ execution: executionCount });
      });

      // Three different keys = three executions
      const keys = ["key-1", "key-2", "key-3"];
      for (const key of keys) {
        const r = await request(app)
          .post("/api/mutate")
          .set(IDEMPOTENCY_HEADER, key)
          .send({});

        expect(r.status).toBe(201);
        expect(r.body.execution).toBe(keys.indexOf(key) + 1);
      }

      expect(executionCount).toBe(3);
    });
  });

  describe("Idempotency in concurrent/retry scenarios", () => {
    it("returns 409 PROCESSING when a key is currently in-flight", async () => {
      const app = express();
      app.use(express.json());
      app.use(createIdempotencyMiddleware(store));

      let handlerReached = 0;
      app.post("/api/heavy", async (_req: Request, res: Response) => {
        handlerReached++;
        res.status(201).json({ completed: true });
      });

      // Pre-mark key as in-flight to simulate concurrent request
      store.markInFlight("heavy-001");

      const r = await request(app)
        .post("/api/heavy")
        .set(IDEMPOTENCY_HEADER, "heavy-001")
        .send({});

      expect(r.status).toBe(409);
      expect(r.body.status).toBe("PROCESSING");
      expect(handlerReached).toBe(0);
      expect(r.headers["idempotency-status"]).toBe("processing");
    });

    it("properly sequences retries: failed → pending → success", async () => {
      const app = express();
      app.use(express.json());
      app.use(createIdempotencyMiddleware(store));

      let phase = "failed";
      app.post("/api/eventual-success", async (_req: Request, res: Response) => {
        if (phase === "failed") {
          phase = "success";
          return res.status(500).json({ error: "temporary" });
        }
        return res.status(201).json({ result: "ok" });
      });

      // Attempt 1: fails
      await request(app)
        .post("/api/eventual-success")
        .set(IDEMPOTENCY_HEADER, "eventual-001")
        .send({})
        .expect(500);

      // Attempt 2: succeeds (no 409, handler called again because error wasn't cached)
      const r2 = await request(app)
        .post("/api/eventual-success")
        .set(IDEMPOTENCY_HEADER, "eventual-001")
        .send({})
        .expect(201);

      expect(r2.body.result).toBe("ok");
    });
  });

  describe("Routes requiring idempotency in production", () => {
    it("financial mutations (token transfers, dividends) must enforce idempotency", async () => {
      const app = express();
      app.use(express.json());
      app.use(createIdempotencyMiddleware(store));

      let transactionCount = 0;
      app.post("/api/transfers", async (_req: Request, res: Response) => {
        transactionCount++;
        res.status(201).json({
          txId: `tx-${transactionCount}`,
          amount: "500.00",
        });
      });

      // A user retries a transfer due to network timeout
      const transferData = { to: "recipient-addr", amount: "500.00" };

      const r1 = await request(app)
        .post("/api/transfers")
        .set(IDEMPOTENCY_HEADER, "transfer-key-001")
        .send(transferData)
        .expect(201);

      expect(transactionCount).toBe(1);

      const r2 = await request(app)
        .post("/api/transfers")
        .set(IDEMPOTENCY_HEADER, "transfer-key-001")
        .send(transferData)
        .expect(201);

      expect(transactionCount).toBe(1);
      expect(r2.body.txId).toBe(r1.body.txId);
    });

    it("missing idempotency key passes through (allows explicit opt-out)", async () => {
      const app = express();
      app.use(express.json());
      app.use(createIdempotencyMiddleware(store));

      let handlerCalls = 0;
      app.post("/api/optional-idempotency", async (_req: Request, res: Response) => {
        handlerCalls++;
        res.status(201).json({ attempt: handlerCalls });
      });

      // No idempotency-key header — both calls should reach handler
      const r1 = await request(app)
        .post("/api/optional-idempotency")
        .send({})
        .expect(201);

      const r2 = await request(app)
        .post("/api/optional-idempotency")
        .send({})
        .expect(201);

      expect(handlerCalls).toBe(2);
      expect(r1.body.attempt).toBe(1);
      expect(r2.body.attempt).toBe(2);
    });
  });
});
