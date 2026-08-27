/**
 * Tests for streamMetadataService (Issue #1765 — payment streaming/vesting).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    paymentStreamMetadata: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

import { prisma } from "../lib/prisma";
import {
  getStreamMetadata,
  listStreamMetadataByCreator,
  listStreamMetadataByRecipient,
  upsertStreamMetadata,
  StreamMetadataAuthError,
} from "./streamMetadataService";

describe("streamMetadataService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getStreamMetadata", () => {
    it("looks up by streamId", async () => {
      const record = { streamId: 1n, creator: "G1" };
      (prisma.paymentStreamMetadata.findUnique as any).mockResolvedValue(
        record
      );

      const result = await getStreamMetadata(1n);

      expect(result).toBe(record);
      expect(prisma.paymentStreamMetadata.findUnique).toHaveBeenCalledWith({
        where: { streamId: 1n },
      });
    });
  });

  describe("listStreamMetadataByCreator / listStreamMetadataByRecipient", () => {
    it("filters by creator, newest first", async () => {
      (prisma.paymentStreamMetadata.findMany as any).mockResolvedValue([]);
      await listStreamMetadataByCreator("G1");
      expect(prisma.paymentStreamMetadata.findMany).toHaveBeenCalledWith({
        where: { creator: "G1" },
        orderBy: { createdAt: "desc" },
      });
    });

    it("filters by recipient, newest first", async () => {
      (prisma.paymentStreamMetadata.findMany as any).mockResolvedValue([]);
      await listStreamMetadataByRecipient("G2");
      expect(prisma.paymentStreamMetadata.findMany).toHaveBeenCalledWith({
        where: { recipient: "G2" },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("upsertStreamMetadata", () => {
    it("creates a new record when none exists", async () => {
      (prisma.paymentStreamMetadata.findUnique as any).mockResolvedValue(null);
      const created = {
        streamId: 1n,
        creator: "G1",
        recipient: "G2",
        title: "Grant",
      };
      (prisma.paymentStreamMetadata.upsert as any).mockResolvedValue(created);

      const result = await upsertStreamMetadata({
        streamId: 1n,
        creator: "G1",
        recipient: "G2",
        title: "Grant",
      });

      expect(result).toBe(created);
      expect(prisma.paymentStreamMetadata.upsert).toHaveBeenCalledWith({
        where: { streamId: 1n },
        create: {
          streamId: 1n,
          creator: "G1",
          recipient: "G2",
          title: "Grant",
          description: null,
          tags: [],
        },
        update: { title: "Grant", description: null, tags: [] },
      });
    });

    it("updates an existing record when the creator matches", async () => {
      (prisma.paymentStreamMetadata.findUnique as any).mockResolvedValue({
        streamId: 1n,
        creator: "G1",
        recipient: "G2",
      });
      (prisma.paymentStreamMetadata.upsert as any).mockResolvedValue({
        streamId: 1n,
        title: "Updated",
      });

      await upsertStreamMetadata({
        streamId: 1n,
        creator: "G1",
        recipient: "G2",
        title: "Updated",
      });

      expect(prisma.paymentStreamMetadata.upsert).toHaveBeenCalled();
    });

    it("throws StreamMetadataAuthError when the creator does not match", async () => {
      (prisma.paymentStreamMetadata.findUnique as any).mockResolvedValue({
        streamId: 1n,
        creator: "G1",
        recipient: "G2",
      });

      await expect(
        upsertStreamMetadata({
          streamId: 1n,
          creator: "ATTACKER",
          recipient: "G2",
        })
      ).rejects.toThrow(StreamMetadataAuthError);
      expect(prisma.paymentStreamMetadata.upsert).not.toHaveBeenCalled();
    });
  });
});
