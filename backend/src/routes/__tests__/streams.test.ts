/**
 * Tests for the streams route (Issue #1765 — payment streaming/vesting).
 *
 * Covers:
 *  - GET  /:streamId/metadata (found, not found, invalid id)
 *  - PUT  /:streamId/metadata (create, update, validation error, auth error)
 *  - GET  /creator/:address
 *  - GET  /recipient/:address
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import streamsRoutes from "../streams";

vi.mock("../../services/streamMetadataService", () => ({
  getStreamMetadata: vi.fn(),
  listStreamMetadataByCreator: vi.fn(),
  listStreamMetadataByRecipient: vi.fn(),
  upsertStreamMetadata: vi.fn(),
  StreamMetadataAuthError: class StreamMetadataAuthError extends Error {
    constructor() {
      super("Only the stream's creator may update its metadata");
      this.name = "StreamMetadataAuthError";
    }
  },
}));

import {
  getStreamMetadata,
  listStreamMetadataByCreator,
  listStreamMetadataByRecipient,
  upsertStreamMetadata,
  StreamMetadataAuthError,
} from "../../services/streamMetadataService";

const app = express();
app.use(express.json());
app.use("/api/streams", streamsRoutes);

describe("streams route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /:streamId/metadata", () => {
    it("returns 400 for a non-numeric stream id", async () => {
      const res = await request(app).get("/api/streams/not-a-number/metadata");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_INPUT");
    });

    it("returns metadata when found", async () => {
      const record = {
        streamId: "1",
        creator: "GCREATOR",
        recipient: "GRECIPIENT",
        title: "Grant",
      };
      (getStreamMetadata as any).mockResolvedValue(record);

      const res = await request(app).get("/api/streams/1/metadata");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(record);
      expect(getStreamMetadata).toHaveBeenCalledWith(1n);
    });

    it("returns null data when no metadata has been set", async () => {
      (getStreamMetadata as any).mockResolvedValue(null);
      const res = await request(app).get("/api/streams/42/metadata");
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it("returns 500 on service error", async () => {
      (getStreamMetadata as any).mockRejectedValue(new Error("db down"));
      const res = await request(app).get("/api/streams/1/metadata");
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    });
  });

  describe("PUT /:streamId/metadata", () => {
    it("returns 400 for a non-numeric stream id", async () => {
      const res = await request(app)
        .put("/api/streams/nope/metadata")
        .send({ creator: "G1", recipient: "G2" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_INPUT");
    });

    it("returns 400 when creator/recipient are missing", async () => {
      const res = await request(app).put("/api/streams/1/metadata").send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("creates/updates metadata and returns it", async () => {
      const record = {
        streamId: "1",
        creator: "G1",
        recipient: "G2",
        title: "Payroll",
      };
      (upsertStreamMetadata as any).mockResolvedValue(record);

      const res = await request(app)
        .put("/api/streams/1/metadata")
        .send({ creator: "G1", recipient: "G2", title: "Payroll" });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(record);
      expect(upsertStreamMetadata).toHaveBeenCalledWith({
        streamId: 1n,
        creator: "G1",
        recipient: "G2",
        title: "Payroll",
      });
    });

    it("returns 403 when a non-creator attempts to update", async () => {
      (upsertStreamMetadata as any).mockRejectedValue(
        new StreamMetadataAuthError()
      );

      const res = await request(app)
        .put("/api/streams/1/metadata")
        .send({ creator: "ATTACKER", recipient: "G2" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("rejects a tags array over the max length", async () => {
      const res = await request(app)
        .put("/api/streams/1/metadata")
        .send({
          creator: "G1",
          recipient: "G2",
          tags: Array.from({ length: 21 }, (_, i) => `tag${i}`),
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /creator/:address", () => {
    it("returns streams created by the address", async () => {
      const records = [{ streamId: "1", creator: "G1" }];
      (listStreamMetadataByCreator as any).mockResolvedValue(records);

      const res = await request(app).get("/api/streams/creator/G1");

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(records);
      expect(listStreamMetadataByCreator).toHaveBeenCalledWith("G1");
    });
  });

  describe("GET /recipient/:address", () => {
    it("returns streams where the address is the recipient", async () => {
      const records = [{ streamId: "1", recipient: "G2" }];
      (listStreamMetadataByRecipient as any).mockResolvedValue(records);

      const res = await request(app).get("/api/streams/recipient/G2");

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(records);
      expect(listStreamMetadataByRecipient).toHaveBeenCalledWith("G2");
    });
  });
});
