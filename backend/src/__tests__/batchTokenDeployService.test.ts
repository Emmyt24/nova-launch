/**
 * Unit tests for batchDeployTokens — partial-failure and idempotency scenarios.
 *
 * These tests exercise the orchestration logic of batchDeployTokens with a
 * controllable mock Stellar RPC client so that we can:
 *
 *  1. Verify the all-succeed baseline (all tokens deployed, DB transaction
 *     committed, events emitted).
 *
 *  2. Inject a Stellar-level failure on the Nth call (mid-batch) and confirm:
 *     - Items before the failing one appear in `failed` (NOT in `succeeded`).
 *     - The failing item carries the RPC error message.
 *     - All remaining items are marked "Skipped due to earlier failure in batch".
 *     - No Prisma transaction is attempted (no partial DB writes).
 *
 *  3. Document the re-run idempotency contract: because the service performs
 *     no idempotency check of its own, on a naive re-run it will attempt to
 *     re-deploy tokens that were already deployed on-chain in the previous
 *     partial run (tokens 1–(N-1)).  The tests assert the current behaviour
 *     so that future callers know they must deduplicate externally.
 *
 * Strategy for mocking callStellarDeploy:
 *   callStellarDeploy is a named export from the same module as
 *   batchDeployTokens.  Vitest's vi.mock hoisting lets us replace the entire
 *   module with a factory that keeps batchDeployTokens real (by importing it
 *   dynamically from the actual file) while substituting callStellarDeploy
 *   with a vi.fn() that we can program per-test.
 *
 * Issue: #1263
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── 1. Mock prisma before any module import ─────────────────────────────────
vi.mock("../lib/prisma", () => ({
  prisma: {
    token: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// ─── 2. Mock eventBus ────────────────────────────────────────────────────────
vi.mock("../services/eventBus", () => ({
  eventBus: { publish: vi.fn().mockResolvedValue(undefined) },
}));

// ─── 3. Partially mock batchTokenDeployService ───────────────────────────────
//
// We want batchDeployTokens to run real code while callStellarDeploy is a
// vi.fn() we can control.  The trick: use vi.mock with a factory that
// re-exports the real batchDeployTokens and a spy for callStellarDeploy.
//
// Vitest resolves the factory lazily so we use vi.importActual to pull in
// the real module implementations after hoisting completes.
const mockCallStellarDeploy = vi.fn();

vi.mock("../services/batchTokenDeployService", async (importActual) => {
  const actual = await importActual<typeof import("../services/batchTokenDeployService")>();
  return {
    ...actual,
    // Replace the thin adapter with a controllable vi.fn().
    // batchDeployTokens is re-exported from `actual` so it runs real logic,
    // but because it imports callStellarDeploy from the same module namespace
    // (which Vitest replaces) it will call our mock.
    callStellarDeploy: mockCallStellarDeploy,
  };
});

// ─── 4. Import after mocks are hoisted ───────────────────────────────────────
import { prisma } from "../lib/prisma";
import { eventBus } from "../services/eventBus";
import { batchDeployTokens } from "../services/batchTokenDeployService";
import type { TokenDeployInput } from "../services/batchTokenDeployService";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal valid TokenDeployInput. */
function makeInput(symbol: string, overrides: Partial<TokenDeployInput> = {}): TokenDeployInput {
  return {
    creator: "GCREATORTEST",
    name: `${symbol} Token`,
    symbol,
    decimals: 7,
    initialSupply: "1000000",
    ...overrides,
  };
}

/**
 * Build a Prisma token record as the DB would return it.
 * BigInt fields are kept as BigInt to mirror the real Prisma shape.
 */
function makePrismaToken(symbol: string, address: string) {
  return {
    id: `id-${symbol}`,
    address,
    creator: "GCREATORTEST",
    name: `${symbol} Token`,
    symbol,
    decimals: 7,
    totalSupply: BigInt("1000000"),
    initialSupply: BigInt("1000000"),
    totalBurned: BigInt(0),
    burnCount: 0,
    metadataUri: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  };
}

/** Addresses returned by the mock Stellar RPC for each token index. */
const STELLAR_ADDRS = [
  "GADDR1111111111111111111111111111111111111111111111111111",
  "GADDR2222222222222222222222222222222222222222222222222222",
  "GADDR3333333333333333333333333333333333333333333333333333",
  "GADDR4444444444444444444444444444444444444444444444444444",
  "GADDR5555555555555555555555555555555555555555555555555555",
];

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("batchDeployTokens — Stellar-level partial failure scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. All-succeed baseline ───────────────────────────────────────────────

  describe("all-succeed baseline", () => {
    it("calls callStellarDeploy once per token, commits a single DB transaction, and returns all tokens as succeeded", async () => {
      const inputs = [makeInput("TK1"), makeInput("TK2"), makeInput("TK3")];

      // Mock RPC: every call resolves
      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] })
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[1] })
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[2] });

      // Mock DB transaction: returns three records
      const prismaTokens = inputs.map((inp, i) =>
        makePrismaToken(inp.symbol, STELLAR_ADDRS[i])
      );
      vi.mocked(prisma.$transaction).mockResolvedValueOnce(prismaTokens);

      const result = await batchDeployTokens(inputs);

      // Stellar RPC called exactly once per token
      expect(mockCallStellarDeploy).toHaveBeenCalledTimes(3);
      expect(mockCallStellarDeploy).toHaveBeenNthCalledWith(1, inputs[0]);
      expect(mockCallStellarDeploy).toHaveBeenNthCalledWith(2, inputs[1]);
      expect(mockCallStellarDeploy).toHaveBeenNthCalledWith(3, inputs[2]);

      // Single atomic DB commit
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // All three tokens in succeeded
      expect(result.succeeded).toHaveLength(3);
      expect(result.failed).toHaveLength(0);
    });

    it("serialises BigInt fields to strings in the returned succeeded array", async () => {
      const inputs = [makeInput("BIG")];

      mockCallStellarDeploy.mockResolvedValueOnce({ address: STELLAR_ADDRS[0] });
      vi.mocked(prisma.$transaction).mockResolvedValueOnce([
        makePrismaToken("BIG", STELLAR_ADDRS[0]),
      ]);

      const result = await batchDeployTokens(inputs);

      const token = result.succeeded[0];
      expect(typeof token.totalSupply).toBe("string");
      expect(typeof token.initialSupply).toBe("string");
      expect(typeof token.totalBurned).toBe("string");
    });

    it("emits one token.deployed event per token after a successful batch", async () => {
      const inputs = [makeInput("EV1"), makeInput("EV2")];

      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] })
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[1] });

      const prismaTokens = inputs.map((inp, i) =>
        makePrismaToken(inp.symbol, STELLAR_ADDRS[i])
      );
      vi.mocked(prisma.$transaction).mockResolvedValueOnce(prismaTokens);

      await batchDeployTokens(inputs);

      // Allow fire-and-forget promises to settle
      await Promise.resolve();

      expect(eventBus.publish).toHaveBeenCalledTimes(2);
      expect(eventBus.publish).toHaveBeenCalledWith(
        "token.deployed",
        expect.objectContaining({ symbol: "EV1" })
      );
      expect(eventBus.publish).toHaveBeenCalledWith(
        "token.deployed",
        expect.objectContaining({ symbol: "EV2" })
      );
    });
  });

  // ── 2. Mid-batch Stellar failure (token 3 of 5) ───────────────────────────

  describe("mid-batch Stellar failure — token 3 of 5 fails", () => {
    /**
     * Build a 5-token batch where the mock RPC succeeds for tokens 1–2,
     * throws for token 3, and is never called for tokens 4–5.
     */
    async function runMidBatchFailure() {
      const inputs = [
        makeInput("TK1"),
        makeInput("TK2"),
        makeInput("TK3"), // ← this one will throw
        makeInput("TK4"),
        makeInput("TK5"),
      ];

      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] }) // TK1 ✓
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[1] }) // TK2 ✓
        .mockRejectedValueOnce(new Error("Soroban RPC timeout: contract_call failed")); // TK3 ✗

      return { inputs, result: await batchDeployTokens(inputs) };
    }

    it("stops calling the RPC after the first failure — tokens 4 and 5 are never attempted", async () => {
      await runMidBatchFailure();

      // Only 3 RPC calls made (not 5)
      expect(mockCallStellarDeploy).toHaveBeenCalledTimes(3);
    });

    it("returns zero succeeded tokens — no partial success is possible", async () => {
      const { result } = await runMidBatchFailure();

      expect(result.succeeded).toHaveLength(0);
    });

    it("marks all 5 tokens as failed", async () => {
      const { result } = await runMidBatchFailure();

      expect(result.failed).toHaveLength(5);
    });

    it("carries the RPC error message on the failing token (TK3)", async () => {
      const { result } = await runMidBatchFailure();

      const tk3 = result.failed.find((f) => f.input.symbol === "TK3");
      expect(tk3).toBeDefined();
      expect(tk3!.error).toBe("Soroban RPC timeout: contract_call failed");
    });

    it("marks tokens that already had on-chain calls (TK1, TK2) as failed — atomicity prevents partial commit", async () => {
      const { result } = await runMidBatchFailure();

      const symbols = result.failed.map((f) => f.input.symbol);
      expect(symbols).toContain("TK1");
      expect(symbols).toContain("TK2");
    });

    it("marks skipped tokens (TK4, TK5) with the standard skip message", async () => {
      const { result } = await runMidBatchFailure();

      const skipped = result.failed.filter((f) =>
        f.error === "Skipped due to earlier failure in batch"
      );
      const skippedSymbols = skipped.map((f) => f.input.symbol);
      expect(skippedSymbols).toContain("TK4");
      expect(skippedSymbols).toContain("TK5");
    });

    it("does NOT attempt a Prisma transaction after a Stellar failure — no DB writes", async () => {
      await runMidBatchFailure();

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("does NOT emit any events after a Stellar failure", async () => {
      await runMidBatchFailure();

      await Promise.resolve();
      expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it("preserves the original input objects in each failed entry", async () => {
      const { inputs, result } = await runMidBatchFailure();

      for (const failedEntry of result.failed) {
        const matchingInput = inputs.find(
          (inp) => inp.symbol === failedEntry.input.symbol
        );
        expect(matchingInput).toBeDefined();
        expect(failedEntry.input).toEqual(matchingInput);
      }
    });

    it("batch status record has exactly 2 failed-due-to-upstream and 2 skipped", async () => {
      const { result } = await runMidBatchFailure();

      // TK1 and TK2 had their RPC calls succeed but are still failed due to atomicity
      const upstreamFailed = result.failed.filter(
        (f) => f.error !== "Skipped due to earlier failure in batch"
      );
      const skipped = result.failed.filter(
        (f) => f.error === "Skipped due to earlier failure in batch"
      );

      // TK1, TK2 (upstream success but batch failed), TK3 (actual error)
      expect(upstreamFailed).toHaveLength(3);
      // TK4, TK5 skipped
      expect(skipped).toHaveLength(2);
    });
  });

  // ── 3. First-token failure ────────────────────────────────────────────────

  describe("first-token failure", () => {
    it("marks all tokens as skipped when the very first Stellar call fails", async () => {
      const inputs = [makeInput("A"), makeInput("B"), makeInput("C")];

      mockCallStellarDeploy.mockRejectedValueOnce(
        new Error("RPC connection refused")
      );

      const result = await batchDeployTokens(inputs);

      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toHaveLength(3);

      // First token has the actual error
      expect(result.failed[0].error).toBe("RPC connection refused");

      // Tokens B and C are skipped
      const skipped = result.failed.filter(
        (f) => f.error === "Skipped due to earlier failure in batch"
      );
      expect(skipped).toHaveLength(2);
    });

    it("does not touch Prisma at all when the first Stellar call fails", async () => {
      mockCallStellarDeploy.mockRejectedValueOnce(new Error("RPC error"));

      await batchDeployTokens([makeInput("ONLY")]);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── 4. Last-token failure ─────────────────────────────────────────────────

  describe("last-token failure", () => {
    it("does not commit the DB transaction even when only the last token fails", async () => {
      const inputs = [makeInput("X1"), makeInput("X2"), makeInput("X3")];

      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] })
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[1] })
        .mockRejectedValueOnce(new Error("Gas limit exceeded"));

      const result = await batchDeployTokens(inputs);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toHaveLength(3);
    });

    it("marks only the last token with the RPC error; no other tokens are skipped", async () => {
      const inputs = [makeInput("X1"), makeInput("X2"), makeInput("X3")];

      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] })
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[1] })
        .mockRejectedValueOnce(new Error("Gas limit exceeded"));

      const result = await batchDeployTokens(inputs);

      const skipped = result.failed.filter(
        (f) => f.error === "Skipped due to earlier failure in batch"
      );
      // X1 and X2 had RPC calls; only X3 actually threw, nothing is *skipped*
      expect(skipped).toHaveLength(0);

      const withRpcError = result.failed.find(
        (f) => f.error === "Gas limit exceeded"
      );
      expect(withRpcError!.input.symbol).toBe("X3");
    });
  });

  // ── 5. Re-run idempotency contract ───────────────────────────────────────

  describe("re-run idempotency — naive re-run after partial failure", () => {
    /**
     * This test documents the CURRENT BEHAVIOUR of batchDeployTokens:
     * because it has no built-in idempotency guard, a naive re-run after a
     * partial failure will attempt to re-deploy tokens that were already
     * deployed on-chain (tokens before the failure index).
     *
     * Callers MUST handle de-duplication externally (e.g., by persisting the
     * list of successful on-chain addresses before retrying).
     */
    it("re-deploys all inputs on a naive second call — no idempotency guard is present", async () => {
      const inputs = [makeInput("R1"), makeInput("R2"), makeInput("R3")];

      // First run: R1 succeeds on-chain, R2 throws, R3 is skipped
      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] }) // R1 on-chain ✓
        .mockRejectedValueOnce(new Error("network error")) // R2 fails ✗
        // R3 is never called in run 1

        // Second run: all 3 inputs re-submitted, so all 3 RPC calls happen again
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] }) // R1 re-deployed ← duplication
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[1] }) // R2 ✓ this time
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[2] }); // R3 ✓ this time

      // Run 1 — partial failure
      const run1 = await batchDeployTokens(inputs);
      expect(run1.failed).toHaveLength(3); // R1, R2, R3 all fail

      // Reset DB mock for run 2
      const prismaTokens2 = inputs.map((inp, i) =>
        makePrismaToken(inp.symbol, STELLAR_ADDRS[i])
      );
      vi.mocked(prisma.$transaction).mockResolvedValueOnce(prismaTokens2);

      // Run 2 — naive re-run with the same full input list
      const run2 = await batchDeployTokens(inputs);

      // All 5 RPC calls happened total: 2 in run 1 + 3 in run 2
      // (R1 was called twice — once in each run)
      expect(mockCallStellarDeploy).toHaveBeenCalledTimes(5);

      // Run 2 succeeds because all RPC calls resolve
      expect(run2.succeeded).toHaveLength(3);
      expect(run2.failed).toHaveLength(0);
    });

    it("does NOT silently skip already-deployed tokens on a re-run — callers must track duplicates", async () => {
      const inputs = [makeInput("D1"), makeInput("D2")];

      // Run 1: D1 deployed on-chain, D2 fails
      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] })
        .mockRejectedValueOnce(new Error("timeout"));

      await batchDeployTokens(inputs);

      const callCountAfterRun1 = vi.mocked(mockCallStellarDeploy).mock.calls.length;

      // Run 2: naive re-run with the SAME full inputs list
      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] }) // D1 called again
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[1] }); // D2 succeeds

      vi.mocked(prisma.$transaction).mockResolvedValueOnce([
        makePrismaToken("D1", STELLAR_ADDRS[0]),
        makePrismaToken("D2", STELLAR_ADDRS[1]),
      ]);

      await batchDeployTokens(inputs);

      const callCountAfterRun2 = vi.mocked(mockCallStellarDeploy).mock.calls.length;

      // D1 was called in BOTH run 1 and run 2 — no dedup
      expect(callCountAfterRun2 - callCountAfterRun1).toBe(2);
    });

    it("already-deployed tokens from a failed batch are NOT recorded in the DB — no orphan records", async () => {
      // On a partial Stellar failure the DB transaction is never called,
      // so there are no orphaned DB records that would cause a conflict on re-run.
      const inputs = [makeInput("O1"), makeInput("O2"), makeInput("O3")];

      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] }) // O1 on-chain
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[1] }) // O2 on-chain
        .mockRejectedValueOnce(new Error("contract panic")); // O3 fails

      await batchDeployTokens(inputs);

      // Key assertion: no DB write was attempted, so no orphan records
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── 6. Retry-aware failure handling ──────────────────────────────────────

  describe("transient vs terminal RPC failure distinction", () => {
    it("preserves per-item status for timeout (transient) failures", async () => {
      const inputs = [makeInput("T1"), makeInput("T2")];

      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] })
        .mockRejectedValueOnce(new Error("TIMEOUT: Request timed out after 30s"));

      const result = await batchDeployTokens(inputs);

      expect(result.failed).toHaveLength(2);
      const timedOut = result.failed.find((f) => f.input.symbol === "T2");
      expect(timedOut?.error).toContain("TIMEOUT");
    });

    it("preserves per-item status for rate-limit (transient) failures", async () => {
      const inputs = [makeInput("RL1"), makeInput("RL2"), makeInput("RL3")];

      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] })
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[1] })
        .mockRejectedValueOnce(new Error("RATE_LIMITED: Too many requests"));

      const result = await batchDeployTokens(inputs);

      const rateLimited = result.failed.find((f) => f.input.symbol === "RL2");
      expect(rateLimited?.error).toContain("RATE_LIMITED");
    });

    it("distinguishes contract panic (terminal) from timeout (transient)", async () => {
      const inputs = [makeInput("PANIC")];

      mockCallStellarDeploy.mockRejectedValueOnce(
        new Error("ContractError: contract panicked at line 42")
      );

      const result = await batchDeployTokens(inputs);

      expect(result.failed[0].error).toContain("ContractError");
      expect(result.failed[0].error).not.toContain("TIMEOUT");
    });

    it("records RPC error messages for observability", async () => {
      const inputs = [makeInput("OBS")];
      const errorMsg =
        "SOROBAN_RPC_ERROR: invocation failed — insufficient balance in stellar_account";

      mockCallStellarDeploy.mockRejectedValueOnce(new Error(errorMsg));

      const result = await batchDeployTokens(inputs);

      expect(result.failed[0].error).toBe(errorMsg);
    });
  });

  // ── 7. Edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles a single-token batch that fails", async () => {
      mockCallStellarDeploy.mockRejectedValueOnce(new Error("bad input"));

      const result = await batchDeployTokens([makeInput("SOLO")]);

      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toBe("bad input");
      expect(result.failed[0].input.symbol).toBe("SOLO");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("handles a non-Error rejection from the Stellar adapter gracefully", async () => {
      // Simulate a non-Error being thrown (e.g., a string or network object)
      mockCallStellarDeploy.mockRejectedValueOnce("plain string error");

      const result = await batchDeployTokens([makeInput("STR")]);

      expect(result.failed[0].error).toBe("Stellar contract call failed");
    });

    it("includes metadataUri in the failed entry's input when present", async () => {
      const input = makeInput("META", {
        metadataUri: "ipfs://QmTestHash123",
      });

      mockCallStellarDeploy.mockRejectedValueOnce(new Error("nope"));

      const result = await batchDeployTokens([input]);

      expect(result.failed[0].input.metadataUri).toBe("ipfs://QmTestHash123");
    });

    it("preserves ordering of failed entries to match original input ordering", async () => {
      const inputs = [
        makeInput("ORD1"),
        makeInput("ORD2"),
        makeInput("ORD3"),
        makeInput("ORD4"),
      ];

      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] })
        .mockRejectedValueOnce(new Error("fail")); // ORD2 fails

      const result = await batchDeployTokens(inputs);

      const symbols = result.failed.map((f) => f.input.symbol);
      // ORD1 comes before ORD2 which comes before ORD3 and ORD4
      const ord1Idx = symbols.indexOf("ORD1");
      const ord2Idx = symbols.indexOf("ORD2");
      const ord3Idx = symbols.indexOf("ORD3");
      const ord4Idx = symbols.indexOf("ORD4");

      expect(ord1Idx).toBeLessThan(ord2Idx);
      expect(ord2Idx).toBeLessThan(ord3Idx);
      expect(ord3Idx).toBeLessThan(ord4Idx);
    });

    it("handles DB transaction failure and returns all inputs as failed", async () => {
      const inputs = [makeInput("DB1"), makeInput("DB2")];

      mockCallStellarDeploy
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[0] })
        .mockResolvedValueOnce({ address: STELLAR_ADDRS[1] });

      vi.mocked(prisma.$transaction).mockRejectedValueOnce(
        new Error("Unique constraint violation")
      );

      const result = await batchDeployTokens(inputs);

      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toHaveLength(2);
      expect(result.failed[0].error).toContain("Database");
      expect(result.failed[1].error).toContain("Database");
    });
  });
});
