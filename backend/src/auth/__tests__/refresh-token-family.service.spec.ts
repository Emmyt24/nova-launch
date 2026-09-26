/**
 * Integration tests for refresh token family invalidation (#1345).
 * Prisma is mocked — no live database required.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma transaction and client
// ---------------------------------------------------------------------------

const mockTx = {
  refreshToken: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
};

const mockPrisma = {
  refreshToken: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
    fn(mockTx)
  ),
};

vi.mock("../../lib/prisma", () => ({ default: mockPrisma, prisma: mockPrisma }));

import {
  createTokenFamily,
  rotateTokenFamily,
  invalidateFamily,
  pruneExpiredFamilies,
  TokenFamilyError,
} from "../refresh-token-family.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(
  overrides: Partial<{
    id: string;
    familyId: string;
    token: string;
    used: boolean;
    expiresAt: Date;
  }> = {}
) {
  return {
    id: "rec-1",
    familyId: "family-1",
    token: "tok-current",
    used: false,
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createTokenFamily
// ---------------------------------------------------------------------------

describe("createTokenFamily", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a DB record and returns a new familyId", async () => {
    mockPrisma.refreshToken.create.mockResolvedValue({});
    const { familyId } = await createTokenFamily("tok-1", new Date());
    expect(typeof familyId).toBe("string");
    expect(familyId.length).toBeGreaterThan(0);
  });

  it("stores the token in the created record", async () => {
    mockPrisma.refreshToken.create.mockResolvedValue({});
    await createTokenFamily("tok-abc", new Date());
    expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ token: "tok-abc" }),
      })
    );
  });

  it("propagates persistence failures", async () => {
    mockPrisma.refreshToken.create.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(createTokenFamily("tok-abc", new Date())).rejects.toThrow("database unavailable");
  });

  it("each call generates a unique familyId", async () => {
    mockPrisma.refreshToken.create.mockResolvedValue({});
    const { familyId: id1 } = await createTokenFamily("tok-1", new Date());
    const { familyId: id2 } = await createTokenFamily("tok-2", new Date());
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// rotateTokenFamily — normal rotation
// ---------------------------------------------------------------------------

describe("rotateTokenFamily — normal rotation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks the current token as used", async () => {
    mockTx.refreshToken.findUnique.mockResolvedValue(makeRecord());
    mockTx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    mockTx.refreshToken.create.mockResolvedValue({});

    await rotateTokenFamily("tok-current", "tok-next", new Date());

    expect(mockTx.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { token: "tok-current", used: false },
        data: { used: true },
      })
    );
  });

  it("creates the next token in the same family", async () => {
    const record = makeRecord();
    mockTx.refreshToken.findUnique.mockResolvedValue(record);
    mockTx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    mockTx.refreshToken.create.mockResolvedValue({});

    const result = await rotateTokenFamily("tok-current", "tok-next", new Date());

    expect(result.familyId).toBe("family-1");
    expect(mockTx.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          familyId: "family-1",
          token: "tok-next",
        }),
      })
    );
  });

  it("wraps all operations in a single DB transaction", async () => {
    mockTx.refreshToken.findUnique.mockResolvedValue(makeRecord());
    mockTx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    mockTx.refreshToken.create.mockResolvedValue({});

    await rotateTokenFamily("tok-current", "tok-next", new Date());

    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// rotateTokenFamily — reuse detection
// ---------------------------------------------------------------------------

describe("rotateTokenFamily — reuse detection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws TokenFamilyError with code REUSE_DETECTED when a used token is presented", async () => {
    mockTx.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    mockTx.refreshToken.findUnique.mockResolvedValue(makeRecord({ used: true }));
    mockTx.refreshToken.deleteMany.mockResolvedValue({ count: 2 });

    const err = await rotateTokenFamily(
      "tok-current",
      "tok-next",
      new Date()
    ).catch((e) => e);

    expect(err).toBeInstanceOf(TokenFamilyError);
    expect(err.code).toBe("REUSE_DETECTED");
  });

  it("deletes all tokens in the family on reuse detection", async () => {
    mockTx.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    mockTx.refreshToken.findUnique.mockResolvedValue(makeRecord({ used: true }));
    mockTx.refreshToken.deleteMany.mockResolvedValue({ count: 3 });

    await rotateTokenFamily("tok-current", "tok-next", new Date()).catch(() => {});

    expect(mockTx.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { familyId: "family-1" },
    });
  });

  it("throws TokenFamilyError with code INVALID_TOKEN when token is not found", async () => {
    mockTx.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    mockTx.refreshToken.findUnique.mockResolvedValue(null);

    const err = await rotateTokenFamily(
      "tok-unknown",
      "tok-next",
      new Date()
    ).catch((e) => e);

    expect(err).toBeInstanceOf(TokenFamilyError);
    expect(err.code).toBe("INVALID_TOKEN");
  });

  it("does not create a new token record when reuse is detected", async () => {
    mockTx.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    mockTx.refreshToken.findUnique.mockResolvedValue(makeRecord({ used: true }));
    mockTx.refreshToken.deleteMany.mockResolvedValue({ count: 1 });

    await rotateTokenFamily("tok-current", "tok-next", new Date()).catch(() => {});

    expect(mockTx.refreshToken.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// invalidateFamily
// ---------------------------------------------------------------------------

describe("invalidateFamily", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes all tokens with the given familyId", async () => {
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 3 });
    await invalidateFamily("family-xyz");
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { familyId: "family-xyz" },
    });
  });

  it("propagates deletion failures", async () => {
    mockPrisma.refreshToken.deleteMany.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(invalidateFamily("family-xyz")).rejects.toThrow("database unavailable");
  });
});

// ---------------------------------------------------------------------------
// pruneExpiredFamilies
// ---------------------------------------------------------------------------

describe("pruneExpiredFamilies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the number of deleted records", async () => {
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 7 });
    const result = await pruneExpiredFamilies();
    expect(result.deleted).toBe(7);
  });

  it("filters by expiresAt older than 30 days", async () => {
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
    await pruneExpiredFamilies();
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          expiresAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      })
    );

    const callArgs = mockPrisma.refreshToken.deleteMany.mock.calls[0][0];
    const cutoff: Date = callArgs.where.expiresAt.lt;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - thirtyDaysAgo)).toBeLessThan(5000);
  });

  it("propagates pruning failures", async () => {
    mockPrisma.refreshToken.deleteMany.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(pruneExpiredFamilies()).rejects.toThrow("database unavailable");
  });
});

// ---------------------------------------------------------------------------
// TokenFamilyError
// ---------------------------------------------------------------------------

describe("TokenFamilyError", () => {
  it("is an instance of Error", () => {
    const err = new TokenFamilyError("REUSE_DETECTED", "msg");
    expect(err).toBeInstanceOf(Error);
  });

  it("has the correct code and message", () => {
    const err = new TokenFamilyError("INVALID_TOKEN", "not found");
    expect(err.code).toBe("INVALID_TOKEN");
    expect(err.message).toBe("not found");
    expect(err.name).toBe("TokenFamilyError");
  });
});
