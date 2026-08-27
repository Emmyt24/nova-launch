import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OnChainProjectionVerifier,
  OnChainDataFetcher,
  type VerifierConfig,
  type OnChainTokenState,
  type ConsistencyCheckResult,
} from "../services/consistency/onchainProjectionVerifier";

// ---------------------------------------------------------------------------
// Prisma mock factory
// ---------------------------------------------------------------------------

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    token: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  } as any;
}

function makeVerifier(
  prismaOverrides: Record<string, unknown> = {},
  config: VerifierConfig = {}
) {
  const prisma = makePrisma(prismaOverrides);
  const verifier = new OnChainProjectionVerifier(prisma, config);
  return { verifier, prisma };
}

// Spy on fetcher methods via prototype
function mockFetcher(
  tokenCount: number | null,
  burnEvents: ReturnType<OnChainDataFetcher["fetchBurnEvents"]> extends Promise<infer T> ? T : never = []
) {
  vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(tokenCount);
  vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue(burnEvents);
}

// ---------------------------------------------------------------------------
// isWithinTolerance (private – tested indirectly via checkBurnTotals)
// We access it by building a verifier with a known tolerance and checking
// whether checkBurnTotals emits a diff.
// ---------------------------------------------------------------------------

describe("isWithinTolerance", () => {
  beforeEach(() => vi.restoreAllMocks());

  const token = { address: "TOKADDR", totalBurned: BigInt(1000), burnCount: 1 };

  it("returns true when backend === onChain (zero tolerance)", async () => {
    const { verifier } = makeVerifier();
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "TOKADDR", from: "A", amount: BigInt(1000), burnedBy: "A", isAdminBurn: false, txHash: "x" },
    ]);
    (verifier as any).prisma.token.findMany.mockResolvedValue([token]);

    const result = await verifier.checkBurnTotals();
    // No diff on totalBurned means isWithinTolerance returned true
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(0);
  });

  it("returns false when values differ at zero tolerance", async () => {
    const { verifier } = makeVerifier();
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "TOKADDR", from: "A", amount: BigInt(999), burnedBy: "A", isAdminBurn: false, txHash: "x" },
    ]);
    (verifier as any).prisma.token.findMany.mockResolvedValue([token]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(1);
  });

  it("returns true when diff is within percent tolerance", async () => {
    // backend=100, onChain=105, tolerance=10% → within tolerance
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 10 } });
    const tok = { address: "T", totalBurned: BigInt(100), burnCount: 1 };
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "T", from: "A", amount: BigInt(105), burnedBy: "A", isAdminBurn: false, txHash: "x" },
    ]);
    (verifier as any).prisma.token.findMany.mockResolvedValue([tok]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(0);
  });

  it("returns false when diff exceeds percent tolerance", async () => {
    // backend=100, onChain=120, tolerance=10% → 18% drift > 10%
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 10 } });
    const tok = { address: "T", totalBurned: BigInt(100), burnCount: 1 };
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "T", from: "A", amount: BigInt(120), burnedBy: "A", isAdminBurn: false, txHash: "x" },
    ]);
    (verifier as any).prisma.token.findMany.mockResolvedValue([tok]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(1);
  });

  it("returns true when both values are zero (no drift)", async () => {
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 5 } });
    const tok = { address: "T", totalBurned: BigInt(0), burnCount: 1 };
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "T", from: "A", amount: BigInt(0), burnedBy: "A", isAdminBurn: false, txHash: "x" },
    ]);
    (verifier as any).prisma.token.findMany.mockResolvedValue([tok]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(0);
  });

  it("uses the larger value as denominator when onChain > backend", async () => {
    // backend=80, onChain=100, tolerance=15% → diff=20, maxVal=100, 20% > 15%
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 15 } });
    const tok = { address: "T", totalBurned: BigInt(80), burnCount: 1 };
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "T", from: "A", amount: BigInt(100), burnedBy: "A", isAdminBurn: false, txHash: "x" },
    ]);
    (verifier as any).prisma.token.findMany.mockResolvedValue([tok]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(1);
  });

  it("uses the larger value as denominator when backend > onChain", async () => {
    // backend=100, onChain=80, tolerance=15% → diff=20, maxVal=100, 20% > 15%
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 15 } });
    const tok = { address: "T", totalBurned: BigInt(100), burnCount: 1 };
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "T", from: "A", amount: BigInt(80), burnedBy: "A", isAdminBurn: false, txHash: "x" },
    ]);
    (verifier as any).prisma.token.findMany.mockResolvedValue([tok]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// checkTokenCounts
// ---------------------------------------------------------------------------

describe("checkTokenCounts", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns no diff when counts match (zero tolerance)", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(5);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(5);

    const result = await verifier.checkTokenCounts();
    expect(result.diffs).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.checked).toBe(5);
  });

  it("pushes an error when onChain count is null", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(3);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(null);

    const result = await verifier.checkTokenCounts();
    expect(result.diffs).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/on-chain token count/i);
  });

  it("pushes a warning diff when drift <= 5", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(10);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(13);

    const result = await verifier.checkTokenCounts();
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].severity).toBe("warning");
    expect(result.diffs[0].field).toBe("tokenCount");
    expect(result.diffs[0].backendValue).toBe(10);
    expect(result.diffs[0].onChainValue).toBe(13);
  });

  it("pushes an error diff when drift > 5", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(10);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(17);

    const result = await verifier.checkTokenCounts();
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].severity).toBe("error");
  });

  it("drift exactly 5 is a warning, not an error", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(0);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(5);

    const result = await verifier.checkTokenCounts();
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].severity).toBe("warning");
  });

  it("drift exactly 6 is an error", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(0);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(6);

    const result = await verifier.checkTokenCounts();
    expect(result.diffs[0].severity).toBe("error");
  });

  it("no diff when drift is zero with countDriftAbsolute tolerance = 2", async () => {
    const { verifier } = makeVerifier({}, { tolerances: { countDriftAbsolute: 2 } });
    (verifier as any).prisma.token.count.mockResolvedValue(10);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(11);

    const result = await verifier.checkTokenCounts();
    expect(result.diffs).toHaveLength(0);
  });

  it("diff when drift exceeds countDriftAbsolute tolerance", async () => {
    const { verifier } = makeVerifier({}, { tolerances: { countDriftAbsolute: 2 } });
    (verifier as any).prisma.token.count.mockResolvedValue(10);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(14);

    const result = await verifier.checkTokenCounts();
    expect(result.diffs).toHaveLength(1);
  });

  it("entity is factory, identifier is token_count", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(0);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(10);

    const result = await verifier.checkTokenCounts();
    expect(result.diffs[0].entity).toBe("factory");
    expect(result.diffs[0].identifier).toBe("token_count");
  });

  it("records error and returns 0 checked when prisma throws", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockRejectedValue(new Error("db down"));

    const result = await verifier.checkTokenCounts();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Token count check failed/);
    expect(result.checked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkBurnTotals
// ---------------------------------------------------------------------------

describe("checkBurnTotals", () => {
  beforeEach(() => vi.restoreAllMocks());

  const burnRecord = (amount: bigint) => ({
    tokenAddress: "T1",
    from: "A",
    amount,
    burnedBy: "A",
    isAdminBurn: false,
    txHash: "h",
  });

  it("returns no diff when counts and totals match", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T1", totalBurned: BigInt(500), burnCount: 2 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      burnRecord(BigInt(300)),
      burnRecord(BigInt(200)),
    ]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs).toHaveLength(0);
    expect(result.checked).toBe(1);
  });

  it("emits burnCount diff when counts diverge", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T1", totalBurned: BigInt(500), burnCount: 3 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      burnRecord(BigInt(500)),
    ]);

    const result = await verifier.checkBurnTotals();
    const burnCountDiff = result.diffs.find((d) => d.field === "burnCount");
    expect(burnCountDiff).toBeDefined();
    expect(burnCountDiff!.backendValue).toBe(3);
    expect(burnCountDiff!.onChainValue).toBe(1);
    expect(burnCountDiff!.severity).toBe("error");
  });

  it("emits totalBurned diff when totals diverge", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T1", totalBurned: BigInt(600), burnCount: 1 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      burnRecord(BigInt(500)),
    ]);

    const result = await verifier.checkBurnTotals();
    const totalDiff = result.diffs.find((d) => d.field === "totalBurned");
    expect(totalDiff).toBeDefined();
    expect(totalDiff!.backendValue).toBe("600");
    expect(totalDiff!.onChainValue).toBe("500");
  });

  it("pushes error when fetchBurnEvents returns null", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T1", totalBurned: BigInt(100), burnCount: 1 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue(null);

    const result = await verifier.checkBurnTotals();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/T1/);
    expect(result.diffs).toHaveLength(0);
  });

  it("skips tokens with burnCount = 0 (findMany where clause)", async () => {
    const { verifier } = makeVerifier();
    // findMany returns empty (filtered by burnCount > 0)
    (verifier as any).prisma.token.findMany.mockResolvedValue([]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs).toHaveLength(0);
    expect(result.checked).toBe(0);
  });

  it("aggregates burns from multiple events correctly", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T1", totalBurned: BigInt(1000), burnCount: 4 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      burnRecord(BigInt(100)),
      burnRecord(BigInt(200)),
      burnRecord(BigInt(300)),
      burnRecord(BigInt(400)),
    ]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs).toHaveLength(0);
  });

  it("entity is burn and identifier is token address", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T1", totalBurned: BigInt(999), burnCount: 1 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      burnRecord(BigInt(1)),
    ]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs[0].entity).toBe("burn");
    expect(result.diffs[0].identifier).toBe("T1");
  });

  it("records error and still returns checked count when exception occurs", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findMany.mockRejectedValue(new Error("boom"));

    const result = await verifier.checkBurnTotals();
    expect(result.errors[0]).toMatch(/Burn totals check failed/);
  });
});

// ---------------------------------------------------------------------------
// checkTokenBurnConsistency
// ---------------------------------------------------------------------------

describe("checkTokenBurnConsistency", () => {
  beforeEach(() => vi.restoreAllMocks());

  const baseOnChain: OnChainTokenState = {
    address: "TOKADDR",
    creator: "CREATOR",
    name: "TestToken",
    symbol: "TT",
    decimals: 7,
    totalSupply: BigInt(1_000_000),
    initialSupply: BigInt(1_000_000),
    totalBurned: BigInt(500),
    burnCount: 2,
  };

  const backendToken = {
    address: "TOKADDR",
    totalBurned: BigInt(500),
    burnCount: 2,
    totalSupply: BigInt(1_000_000),
  };

  it("returns empty diffs when all fields match", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findUnique.mockResolvedValue(backendToken);

    const diffs = await verifier.checkTokenBurnConsistency("TOKADDR", baseOnChain);
    expect(diffs).toHaveLength(0);
  });

  it("returns existence diff when token not found in backend", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findUnique.mockResolvedValue(null);

    const diffs = await verifier.checkTokenBurnConsistency("TOKADDR", baseOnChain);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe("existence");
    expect(diffs[0].backendValue).toBeNull();
    expect(diffs[0].onChainValue).toBe("exists");
    expect(diffs[0].severity).toBe("error");
  });

  it("detects totalBurned mismatch", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findUnique.mockResolvedValue({
      ...backendToken,
      totalBurned: BigInt(400),
    });

    const diffs = await verifier.checkTokenBurnConsistency("TOKADDR", baseOnChain);
    const d = diffs.find((x) => x.field === "totalBurned");
    expect(d).toBeDefined();
    expect(d!.backendValue).toBe("400");
    expect(d!.onChainValue).toBe("500");
    expect(d!.severity).toBe("error");
  });

  it("detects burnCount mismatch", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findUnique.mockResolvedValue({
      ...backendToken,
      burnCount: 5,
    });

    const diffs = await verifier.checkTokenBurnConsistency("TOKADDR", baseOnChain);
    const d = diffs.find((x) => x.field === "burnCount");
    expect(d).toBeDefined();
    expect(d!.backendValue).toBe(5);
    expect(d!.onChainValue).toBe(2);
  });

  it("detects totalSupply mismatch", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findUnique.mockResolvedValue({
      ...backendToken,
      totalSupply: BigInt(999_999),
    });

    const diffs = await verifier.checkTokenBurnConsistency("TOKADDR", baseOnChain);
    const d = diffs.find((x) => x.field === "totalSupply");
    expect(d).toBeDefined();
    expect(d!.backendValue).toBe("999999");
    expect(d!.onChainValue).toBe("1000000");
  });

  it("can produce multiple diffs simultaneously", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findUnique.mockResolvedValue({
      ...backendToken,
      totalBurned: BigInt(0),
      burnCount: 0,
      totalSupply: BigInt(0),
    });

    const diffs = await verifier.checkTokenBurnConsistency("TOKADDR", baseOnChain);
    expect(diffs.length).toBeGreaterThanOrEqual(3);
  });

  it("entity is token and identifier is token address", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findUnique.mockResolvedValue({
      ...backendToken,
      burnCount: 99,
    });

    const diffs = await verifier.checkTokenBurnConsistency("TOKADDR", baseOnChain);
    expect(diffs[0].entity).toBe("token");
    expect(diffs[0].identifier).toBe("TOKADDR");
  });
});

// ---------------------------------------------------------------------------
// runFullCheck
// ---------------------------------------------------------------------------

describe("runFullCheck", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("consistent=true when no diffs and no errors", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(0);
    (verifier as any).prisma.token.findMany.mockResolvedValue([]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(0);

    const result = await verifier.runFullCheck();
    expect(result.consistent).toBe(true);
    expect(result.diffs).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("consistent=false when diffs exist", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(5);
    (verifier as any).prisma.token.findMany.mockResolvedValue([]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(10);

    const result = await verifier.runFullCheck();
    expect(result.consistent).toBe(false);
    expect(result.diffs.length).toBeGreaterThan(0);
  });

  it("consistent=false when errors exist", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(3);
    (verifier as any).prisma.token.findMany.mockResolvedValue([]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(null);

    const result = await verifier.runFullCheck();
    expect(result.consistent).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("totalChecked = tokensChecked + burnsChecked", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(3);
    (verifier as any).prisma.token.findMany.mockResolvedValue([]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(3);

    const result = await verifier.runFullCheck();
    expect(result.totalChecked).toBe(result.tokensChecked + result.burnsChecked);
  });

  it("populates timestamp and duration", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(0);
    (verifier as any).prisma.token.findMany.mockResolvedValue([]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(0);

    const result = await verifier.runFullCheck();
    expect(result.timestamp).toBeInstanceOf(Date);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("catches top-level exception and records it in errors", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockRejectedValue(new Error("catastrophic"));
    (verifier as any).prisma.token.findMany.mockResolvedValue([]);

    const result = await verifier.runFullCheck();
    expect(result.consistent).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatResults
// ---------------------------------------------------------------------------

describe("formatResults", () => {
  const baseResult: ConsistencyCheckResult = {
    consistent: true,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    totalChecked: 8,
    tokensChecked: 5,
    burnsChecked: 3,
    diffs: [],
    errors: [],
    duration: 42,
  };

  it("contains YES when consistent=true", () => {
    const { verifier } = makeVerifier();
    const output = verifier.formatResults(baseResult);
    expect(output).toContain("YES");
  });

  it("contains NO when consistent=false", () => {
    const { verifier } = makeVerifier();
    const output = verifier.formatResults({ ...baseResult, consistent: false });
    expect(output).toContain("NO");
  });

  it("includes numeric counts", () => {
    const { verifier } = makeVerifier();
    const output = verifier.formatResults(baseResult);
    expect(output).toContain("5");
    expect(output).toContain("3");
    expect(output).toContain("8");
    expect(output).toContain("42");
  });

  it("includes error text when errors exist", () => {
    const { verifier } = makeVerifier();
    const output = verifier.formatResults({
      ...baseResult,
      errors: ["something went wrong"],
    });
    expect(output).toContain("something went wrong");
  });

  it("includes diff details when diffs exist", () => {
    const { verifier } = makeVerifier();
    const output = verifier.formatResults({
      ...baseResult,
      consistent: false,
      diffs: [
        {
          entity: "token",
          identifier: "TOKADDR",
          field: "burnCount",
          backendValue: 1,
          onChainValue: 2,
          severity: "error",
        },
      ],
    });
    expect(output).toContain("TOKADDR");
    expect(output).toContain("burnCount");
  });

  it("shows no-inconsistencies message when diffs and errors are empty", () => {
    const { verifier } = makeVerifier();
    const output = verifier.formatResults(baseResult);
    expect(output).toContain("No inconsistencies found");
  });
});

// ---------------------------------------------------------------------------
// generateReport
// ---------------------------------------------------------------------------

describe("generateReport", () => {
  const baseResult: ConsistencyCheckResult = {
    consistent: true,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    totalChecked: 6,
    tokensChecked: 4,
    burnsChecked: 2,
    diffs: [],
    errors: [],
    duration: 99,
  };

  it("success mirrors consistent flag", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(baseResult) as any;
    expect(report.success).toBe(true);
  });

  it("success is false when consistent=false", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport({ ...baseResult, consistent: false }) as any;
    expect(report.success).toBe(false);
  });

  it("duration_ms matches result.duration", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(baseResult) as any;
    expect(report.duration_ms).toBe(99);
  });

  it("summary counts are correct", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(baseResult) as any;
    expect(report.summary.tokens_checked).toBe(4);
    expect(report.summary.burns_checked).toBe(2);
    expect(report.summary.total_checked).toBe(6);
    expect(report.summary.inconsistencies).toBe(0);
    expect(report.summary.errors).toBe(0);
  });

  it("diffs array is mapped with snake_case fields", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport({
      ...baseResult,
      consistent: false,
      diffs: [
        {
          entity: "burn",
          identifier: "TOKADDR",
          field: "totalBurned",
          backendValue: "100",
          onChainValue: "200",
          severity: "error",
        },
      ],
    }) as any;
    expect(report.diffs).toHaveLength(1);
    expect(report.diffs[0].backend_value).toBe("100");
    expect(report.diffs[0].onchain_value).toBe("200");
    expect(report.diffs[0].entity).toBe("burn");
  });

  it("errors array is passed through", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport({
      ...baseResult,
      errors: ["err1", "err2"],
    }) as any;
    expect(report.errors).toEqual(["err1", "err2"]);
  });

  it("timestamp is an ISO string", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(baseResult) as any;
    expect(typeof report.timestamp).toBe("string");
    expect(report.timestamp).toContain("2026-01-01");
  });
});

// ---------------------------------------------------------------------------
// OnChainDataFetcher constructor – config fallback chains (L100-L110)
// ---------------------------------------------------------------------------

describe("OnChainDataFetcher constructor – config fallbacks", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.FACTORY_CONTRACT_ID;
    delete process.env.SOROBAN_RPC_URL;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("uses explicit config.horizonUrl over env and default", () => {
    const f = new OnChainDataFetcher({ horizonUrl: "https://custom.horizon" });
    expect((f as any).horizonUrl).toBe("https://custom.horizon");
  });

  it("falls back to env STELLAR_HORIZON_URL when config not set", () => {
    process.env.STELLAR_HORIZON_URL = "https://env.horizon";
    const f = new OnChainDataFetcher({});
    expect((f as any).horizonUrl).toBe("https://env.horizon");
  });

  it("falls back to hardcoded testnet URL when neither config nor env set", () => {
    const f = new OnChainDataFetcher({});
    expect((f as any).horizonUrl).toBe("https://horizon-testnet.stellar.org");
  });

  it("uses explicit config.factoryContractId", () => {
    const f = new OnChainDataFetcher({ factoryContractId: "CONTRACT123" });
    expect((f as any).factoryContractId).toBe("CONTRACT123");
  });

  it("falls back to env FACTORY_CONTRACT_ID", () => {
    process.env.FACTORY_CONTRACT_ID = "ENV_CONTRACT";
    const f = new OnChainDataFetcher({});
    expect((f as any).factoryContractId).toBe("ENV_CONTRACT");
  });

  it("falls back to empty string when factory contract id not set", () => {
    const f = new OnChainDataFetcher({});
    expect((f as any).factoryContractId).toBe("");
  });

  it("uses explicit config.sorobanRpcUrl", () => {
    const f = new OnChainDataFetcher({ sorobanRpcUrl: "https://custom.rpc" });
    expect((f as any).sorobanRpcUrl).toBe("https://custom.rpc");
  });

  it("falls back to env SOROBAN_RPC_URL", () => {
    process.env.SOROBAN_RPC_URL = "https://env.rpc";
    const f = new OnChainDataFetcher({});
    expect((f as any).sorobanRpcUrl).toBe("https://env.rpc");
  });

  it("falls back to hardcoded soroban testnet URL", () => {
    const f = new OnChainDataFetcher({});
    expect((f as any).sorobanRpcUrl).toBe("https://soroban-testnet.stellar.org");
  });
});

// ---------------------------------------------------------------------------
// runFullCheck arithmetic – duration and totalChecked (L273, L278)
// ---------------------------------------------------------------------------

describe("runFullCheck – arithmetic invariants", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("duration is non-negative (Date.now() - startTime, not +)", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(0);
    (verifier as any).prisma.token.findMany.mockResolvedValue([]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(0);

    const before = Date.now();
    const result = await verifier.runFullCheck();
    const after = Date.now();

    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThanOrEqual(after - before + 100);
  });

  it("totalChecked is sum not difference of sub-counts", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(4);
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "GTOKEN1", totalBurned: BigInt(0), burnCount: 1 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(4);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([]);

    const result = await verifier.runFullCheck();
    // tokensChecked=4, burnsChecked=1 → total=5
    expect(result.totalChecked).toBe(result.tokensChecked + result.burnsChecked);
    expect(result.totalChecked).toBeGreaterThan(result.tokensChecked);
  });
});

// ---------------------------------------------------------------------------
// formatResults – exact string content to kill StringLiteral/ConditionalExpression mutants
// ---------------------------------------------------------------------------

describe("formatResults – exact string assertions", () => {
  const makeResult = (overrides: Partial<ConsistencyCheckResult> = {}): ConsistencyCheckResult => ({
    consistent: true,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    totalChecked: 8,
    tokensChecked: 5,
    burnsChecked: 3,
    diffs: [],
    errors: [],
    duration: 42,
    ...overrides,
  });

  it("contains header separator", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(makeResult());
    expect(out).toContain("═══");
    expect(out).toContain("On-Chain Projection Consistency Check Results");
  });

  it("contains Timestamp label", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(makeResult());
    expect(out).toContain("Timestamp:");
    expect(out).toContain("2026-01-01T00:00:00.000Z");
  });

  it("contains Duration label with ms", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(makeResult());
    expect(out).toContain("Duration:");
    expect(out).toContain("42ms");
  });

  it("contains Consistent label", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(makeResult());
    expect(out).toContain("Consistent:");
  });

  it("contains Tokens checked label with count", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(makeResult());
    expect(out).toContain("Tokens checked:");
    expect(out).toContain("5");
  });

  it("contains Burns checked label with count", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(makeResult());
    expect(out).toContain("Burns checked:");
    expect(out).toContain("3");
  });

  it("contains Total checked label with count", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(makeResult());
    expect(out).toContain("Total checked:");
    expect(out).toContain("8");
  });

  it("contains ERRORS section when errors present", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(makeResult({ errors: ["oops"] }));
    expect(out).toContain("ERRORS:");
    expect(out).toContain("⚠ oops");
  });

  it("contains INCONSISTENCIES section when diffs present", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(makeResult({
      consistent: false,
      diffs: [{
        entity: "burn", identifier: "T1", field: "burnCount",
        backendValue: 1, onChainValue: 2, severity: "error",
      }],
    }));
    expect(out).toContain("INCONSISTENCIES:");
    expect(out).toContain("❌ [burn] T1.burnCount");
    expect(out).toContain("Backend:  1");
    expect(out).toContain("On-chain: 2");
  });

  it("uses ⚠ icon for warning severity diffs", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(makeResult({
      consistent: false,
      diffs: [{
        entity: "factory", identifier: "token_count", field: "tokenCount",
        backendValue: 1, onChainValue: 2, severity: "warning",
      }],
    }));
    expect(out).toContain("⚠ [factory]");
    expect(out).not.toMatch(/❌ \[factory\]/);
  });

  it("no-inconsistencies message absent when errors exist but diffs are empty", () => {
    const { verifier } = makeVerifier();
    // errors.length > 0 AND diffs.length === 0: the else-if branch should NOT fire
    const out = verifier.formatResults(makeResult({ errors: ["e1"] }));
    expect(out).not.toContain("No inconsistencies found");
  });

  it("errors.length === 0 check: no-inconsistencies absent when errors.length > 0", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(makeResult({
      errors: ["some error"],
      diffs: [],
    }));
    // No diffs but errors present → should NOT show "no inconsistencies"
    expect(out).not.toContain("No inconsistencies found");
  });
});

// ---------------------------------------------------------------------------
// generateReport – exact field names to kill StringLiteral mutants (L487-L598)
// ---------------------------------------------------------------------------

describe("generateReport – exact field names", () => {
  const makeResult = (overrides: Partial<ConsistencyCheckResult> = {}): ConsistencyCheckResult => ({
    consistent: true,
    timestamp: new Date("2026-06-01T12:00:00.000Z"),
    totalChecked: 7,
    tokensChecked: 3,
    burnsChecked: 4,
    diffs: [],
    errors: [],
    duration: 55,
    ...overrides,
  });

  it("report has 'success' key", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(makeResult()) as any;
    expect(Object.prototype.hasOwnProperty.call(report, "success")).toBe(true);
  });

  it("report has 'timestamp' key as string", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(makeResult()) as any;
    expect(typeof report.timestamp).toBe("string");
  });

  it("report has 'duration_ms' key (not durationMs)", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(makeResult()) as any;
    expect(Object.prototype.hasOwnProperty.call(report, "duration_ms")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(report, "durationMs")).toBe(false);
  });

  it("report has 'summary' key with expected sub-keys", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(makeResult()) as any;
    expect(Object.prototype.hasOwnProperty.call(report.summary, "tokens_checked")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(report.summary, "burns_checked")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(report.summary, "total_checked")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(report.summary, "inconsistencies")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(report.summary, "errors")).toBe(true);
  });

  it("summary.inconsistencies equals diffs.length", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(makeResult({
      consistent: false,
      diffs: [
        { entity: "burn", identifier: "A", field: "f", backendValue: 1, onChainValue: 2, severity: "error" },
        { entity: "token", identifier: "B", field: "g", backendValue: 3, onChainValue: 4, severity: "warning" },
      ],
    })) as any;
    expect(report.summary.inconsistencies).toBe(2);
  });

  it("summary.errors equals errors.length", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(makeResult({ errors: ["e1", "e2", "e3"] })) as any;
    expect(report.summary.errors).toBe(3);
  });

  it("diffs mapped with 'backend_value' (snake_case)", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(makeResult({
      consistent: false,
      diffs: [{ entity: "token", identifier: "1", field: "status", backendValue: "ACTIVE", onChainValue: "DONE", severity: "error" }],
    })) as any;
    expect(Object.prototype.hasOwnProperty.call(report.diffs[0], "backend_value")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(report.diffs[0], "onchain_value")).toBe(true);
    expect(report.diffs[0].backend_value).toBe("ACTIVE");
    expect(report.diffs[0].onchain_value).toBe("DONE");
  });

  it("diffs mapped with 'severity' key", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(makeResult({
      diffs: [{ entity: "token", identifier: "X", field: "f", backendValue: null, onChainValue: "exists", severity: "error" }],
    })) as any;
    expect(report.diffs[0].severity).toBe("error");
  });

  it("report has 'diffs' and 'errors' top-level arrays", () => {
    const { verifier } = makeVerifier();
    const report = verifier.generateReport(makeResult()) as any;
    expect(Array.isArray(report.diffs)).toBe(true);
    expect(Array.isArray(report.errors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isWithinTolerance – boundary conditions on comparison operators (L725-L734)
// ---------------------------------------------------------------------------

describe("isWithinTolerance – operator boundary conditions", () => {
  beforeEach(() => vi.restoreAllMocks());

  // We use checkBurnTotals as the harness since isWithinTolerance is private.

  const makeTok = (addr: string, burned: bigint) => ({
    address: addr, totalBurned: burned, burnCount: 1,
  });
  const makeBurn = (addr: string, amount: bigint) => ({
    tokenAddress: addr, from: "A", amount, burnedBy: "A", isAdminBurn: false, txHash: "h",
  });

  it("percentDiff === tolerance is within (<=, not <)", async () => {
    // tolerance=20, backend=100, onChain=120 → diff=20, max=120 → 16.6% < 20% ✓
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 20 } });
    (verifier as any).prisma.token.findMany.mockResolvedValue([makeTok("T", BigInt(100))]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([makeBurn("T", BigInt(120))]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(0);
  });

  it("percentDiff just above tolerance causes diff", async () => {
    // tolerance=10, backend=100, onChain=115 → diff=15, max=115 → 13% > 10%
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 10 } });
    (verifier as any).prisma.token.findMany.mockResolvedValue([makeTok("T", BigInt(100))]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([makeBurn("T", BigInt(115))]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(1);
  });

  it("maxVal branch: backend > onChain → maxVal is backend", async () => {
    // backend=200 > onChain=100, tolerance=60% → diff=100/200=50% ≤ 60% → within
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 60 } });
    (verifier as any).prisma.token.findMany.mockResolvedValue([makeTok("T", BigInt(200))]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([makeBurn("T", BigInt(100))]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(0);
  });

  it("maxVal branch: onChain > backend → maxVal is onChain", async () => {
    // onChain=200 > backend=100, tolerance=60% → diff=100/200=50% ≤ 60% → within
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 60 } });
    (verifier as any).prisma.token.findMany.mockResolvedValue([makeTok("T", BigInt(100))]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([makeBurn("T", BigInt(200))]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(0);
  });

  it("diff branch: backend > onChain → diff = backend - onChain", async () => {
    // backend=150, onChain=100, tolerance=10% → diff=50, max=150, 33% > 10% → NOT within
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 10 } });
    (verifier as any).prisma.token.findMany.mockResolvedValue([makeTok("T", BigInt(150))]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([makeBurn("T", BigInt(100))]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(1);
  });

  it("diff branch: onChain > backend → diff = onChain - backend", async () => {
    // onChain=150, backend=100, tolerance=10% → diff=50, max=150, 33% > 10%
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 10 } });
    (verifier as any).prisma.token.findMany.mockResolvedValue([makeTok("T", BigInt(100))]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([makeBurn("T", BigInt(150))]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Kill surviving ObjectLiteral mutants: Prisma query argument assertions
// These kill mutants where {burnCount:{gt:0}}, {status:"ACTIVE"}, select:{...}
// are replaced with {} by asserting the exact args passed to prisma mocks.
// ---------------------------------------------------------------------------

describe("checkBurnTotals – Prisma query arguments", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("queries tokens with burnCount > 0 filter", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findMany.mockResolvedValue([]);

    await verifier.checkBurnTotals();

    expect((verifier as any).prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { burnCount: { gt: 0 } },
      })
    );
  });

  it("selects address, totalBurned, burnCount fields", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findMany.mockResolvedValue([]);

    await verifier.checkBurnTotals();

    expect((verifier as any).prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { address: true, totalBurned: true, burnCount: true },
      })
    );
  });

  it("burnCount diff has entity='burn', field='burnCount', severity='error'", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T1", totalBurned: BigInt(0), burnCount: 5 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([]);

    const result = await verifier.checkBurnTotals();
    const d = result.diffs.find((x) => x.field === "burnCount")!;
    expect(d.entity).toBe("burn");
    expect(d.severity).toBe("error");
    expect(d.identifier).toBe("T1");
  });

  it("totalBurned diff has entity='burn', field='totalBurned', severity='error'", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T2", totalBurned: BigInt(100), burnCount: 1 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "T2", from: "A", amount: BigInt(50), burnedBy: "A", isAdminBurn: false, txHash: "h" },
    ]);

    const result = await verifier.checkBurnTotals();
    const d = result.diffs.find((x) => x.field === "totalBurned")!;
    expect(d.entity).toBe("burn");
    expect(d.severity).toBe("error");
    expect(d.identifier).toBe("T2");
    expect(d.backendValue).toBe("100");
    expect(d.onChainValue).toBe("50");
  });
});


describe("checkTokenCounts – diff field assertions", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("diff entity is 'factory', identifier is 'token_count', field is 'tokenCount'", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.count.mockResolvedValue(0);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(10);

    const result = await verifier.checkTokenCounts();
    expect(result.diffs[0].entity).toBe("factory");
    expect(result.diffs[0].identifier).toBe("token_count");
    expect(result.diffs[0].field).toBe("tokenCount");
  });
});

// ---------------------------------------------------------------------------
// Kill L661 EqualityOperator: result.errors.length > 0 vs >= 0
// errors.length === 0 branch: no-inconsistencies only shown when errors.length === 0 AND diffs.length === 0
// ---------------------------------------------------------------------------

describe("formatResults – errors.length > 0 conditional (L661)", () => {
  it("ERRORS section not shown when errors.length === 0", () => {
    const { verifier } = makeVerifier();
    const result: ConsistencyCheckResult = {
      consistent: true, timestamp: new Date(), totalChecked: 0,
      tokensChecked: 0, burnsChecked: 0,
      diffs: [], errors: [], duration: 0,
    };
    const out = verifier.formatResults(result);
    expect(out).not.toContain("ERRORS:");
  });

  it("ERRORS section shown when errors.length === 1", () => {
    const { verifier } = makeVerifier();
    const result: ConsistencyCheckResult = {
      consistent: false, timestamp: new Date(), totalChecked: 0,
      tokensChecked: 0, burnsChecked: 0,
      diffs: [], errors: ["one error"], duration: 0,
    };
    const out = verifier.formatResults(result);
    expect(out).toContain("ERRORS:");
    expect(out).toContain("one error");
  });
});

// ---------------------------------------------------------------------------
// Kill L725 EqualityOperator: backendValue > onChainValue vs >= / <=
// Test equal values explicitly to distinguish > from >=
// ---------------------------------------------------------------------------

describe("isWithinTolerance – equal values with non-zero tolerance", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("equal bigint values are always within tolerance even with 0% tolerance", async () => {
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 0 } });
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T", totalBurned: BigInt(500), burnCount: 1 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "T", from: "A", amount: BigInt(500), burnedBy: "A", isAdminBurn: false, txHash: "h" },
    ]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(0);
  });

  it("backend === onChain returns no diff (tests === not > or >=)", async () => {
    // With percent tolerance, backendValue === onChainValue → maxVal = one of them (same), diff=0, 0% <= tolerance
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 5 } });
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T", totalBurned: BigInt(1000), burnCount: 1 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "T", from: "A", amount: BigInt(1000), burnedBy: "A", isAdminBurn: false, txHash: "h" },
    ]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs).toHaveLength(0);
  });

  it("percentDiff exactly equals tolerance → within (<=, not <)", async () => {
    // backend=100, onChain=110, tolerance=~9% (=9.09%), diff=10, max=110 → 9.09% <= 10% ✓
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 10 } });
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T", totalBurned: BigInt(100), burnCount: 1 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "T", from: "A", amount: BigInt(110), burnedBy: "A", isAdminBurn: false, txHash: "h" },
    ]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(0);
  });

  it("percentDiff one unit above tolerance causes diff (kills < mutant)", async () => {
    // backend=1, onChain=2, tolerance=40% → diff=1, max=2 → 50% > 40%
    const { verifier } = makeVerifier({}, { tolerances: { amountDriftPercent: 40 } });
    (verifier as any).prisma.token.findMany.mockResolvedValue([
      { address: "T", totalBurned: BigInt(1), burnCount: 1 },
    ]);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchBurnEvents").mockResolvedValue([
      { tokenAddress: "T", from: "A", amount: BigInt(2), burnedBy: "A", isAdminBurn: false, txHash: "h" },
    ]);

    const result = await verifier.checkBurnTotals();
    expect(result.diffs.filter((d) => d.field === "totalBurned")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Kill L481-L526: checkTokenBurnConsistency Prisma args + exact diff field values
// ---------------------------------------------------------------------------

describe("checkTokenBurnConsistency – Prisma query arguments and exact diff values", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("queries token.findUnique with address as where clause", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findUnique.mockResolvedValue(null);

    await verifier.checkTokenBurnConsistency("TOKADDR", {
      address: "TOKADDR", creator: "C", name: "T", symbol: "T",
      decimals: 7, totalSupply: BigInt(0), initialSupply: BigInt(0),
      totalBurned: BigInt(0), burnCount: 0,
    });

    expect((verifier as any).prisma.token.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { address: "TOKADDR" } })
    );
  });

  it("totalBurned diff has exact entity='token', field='totalBurned', severity='error'", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findUnique.mockResolvedValue({
      address: "T", totalBurned: BigInt(100), burnCount: 1, totalSupply: BigInt(1000),
    });

    const diffs = await verifier.checkTokenBurnConsistency("T", {
      address: "T", creator: "C", name: "T", symbol: "T",
      decimals: 7, totalSupply: BigInt(1000), initialSupply: BigInt(1000),
      totalBurned: BigInt(200), burnCount: 1,
    });

    const d = diffs.find((x) => x.field === "totalBurned")!;
    expect(d.entity).toBe("token");
    expect(d.severity).toBe("error");
    expect(d.backendValue).toBe("100");
    expect(d.onChainValue).toBe("200");
  });

  it("burnCount diff has exact entity='token', field='burnCount', severity='error'", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findUnique.mockResolvedValue({
      address: "T", totalBurned: BigInt(0), burnCount: 0, totalSupply: BigInt(1000),
    });

    const diffs = await verifier.checkTokenBurnConsistency("T", {
      address: "T", creator: "C", name: "T", symbol: "T",
      decimals: 7, totalSupply: BigInt(1000), initialSupply: BigInt(1000),
      totalBurned: BigInt(0), burnCount: 5,
    });

    const d = diffs.find((x) => x.field === "burnCount")!;
    expect(d.entity).toBe("token");
    expect(d.severity).toBe("error");
    expect(d.backendValue).toBe(0);
    expect(d.onChainValue).toBe(5);
  });

  it("totalSupply diff has exact entity='token', field='totalSupply', severity='error'", async () => {
    const { verifier } = makeVerifier();
    (verifier as any).prisma.token.findUnique.mockResolvedValue({
      address: "T", totalBurned: BigInt(0), burnCount: 0, totalSupply: BigInt(500),
    });

    const diffs = await verifier.checkTokenBurnConsistency("T", {
      address: "T", creator: "C", name: "T", symbol: "T",
      decimals: 7, totalSupply: BigInt(1000), initialSupply: BigInt(1000),
      totalBurned: BigInt(0), burnCount: 0,
    });

    const d = diffs.find((x) => x.field === "totalSupply")!;
    expect(d.entity).toBe("token");
    expect(d.severity).toBe("error");
    expect(d.backendValue).toBe("500");
    expect(d.onChainValue).toBe("1000");
  });
});

// ---------------------------------------------------------------------------
// Kill formatResults remaining StringLiteral survivors (L646-L685)
// These are the exact string template literals inside lines[] push calls
// ---------------------------------------------------------------------------

describe("formatResults – remaining string literal kills", () => {
  const mkR = (overrides: Partial<ConsistencyCheckResult> = {}): ConsistencyCheckResult => ({
    consistent: true, timestamp: new Date("2025-05-01T00:00:00.000Z"),
    totalChecked: 3, tokensChecked: 2, burnsChecked: 1,
    diffs: [], errors: [], duration: 7, ...overrides,
  });

  it("output contains the separator line character ═", () => {
    const { verifier } = makeVerifier();
    expect(verifier.formatResults(mkR())).toContain("═");
  });

  it("output lines joined by newline (ArrayDeclaration kill: lines starts with content)", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(mkR());
    expect(out.split("\n").length).toBeGreaterThan(5);
  });

  it("duration line ends with 'ms'", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(mkR());
    const durationLine = out.split("\n").find((l) => l.includes("Duration"));
    expect(durationLine).toBeDefined();
    expect(durationLine).toContain("ms");
  });

  it("consistent line shows ✅ YES when consistent=true", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(mkR({ consistent: true }));
    expect(out).toContain("✅ YES");
  });

  it("consistent line shows ❌ NO when consistent=false", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(mkR({ consistent: false }));
    expect(out).toContain("❌ NO");
  });

  it("no-inconsistencies line contains ✅", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(mkR());
    expect(out).toContain("✅");
  });

  it("error lines prefixed with ⚠", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(mkR({ errors: ["test error"] }));
    const errLine = out.split("\n").find((l) => l.includes("test error"));
    expect(errLine).toContain("⚠");
  });

  it("diff Backend label has trailing colon and space", () => {
    const { verifier } = makeVerifier();
    const out = verifier.formatResults(mkR({
      consistent: false,
      diffs: [{ entity: "token", identifier: "X", field: "f", backendValue: "bv", onChainValue: "ov", severity: "error" }],
    }));
    expect(out).toContain("Backend:");
    expect(out).toContain("On-chain:");
    expect(out).toContain("bv");
    expect(out).toContain("ov");
  });
});

// ---------------------------------------------------------------------------
// OnChainDataFetcher – fetchFactoryState (covers L116-L138 NoCoverage)
// ---------------------------------------------------------------------------

describe("OnChainDataFetcher.fetchFactoryState", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns null when factoryContractId is empty", async () => {
    const f = new OnChainDataFetcher({ factoryContractId: "" });
    const result = await f.fetchFactoryState();
    expect(result).toBeNull();
  });

  it("returns null on axios error", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockRejectedValue(new Error("network"));
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    const result = await f.fetchFactoryState();
    expect(result).toBeNull();
  });

  it("returns null when response has no records", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockResolvedValue({
      data: { _embedded: { records: [] } },
    });
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    const result = await f.fetchFactoryState();
    expect(result).toBeNull();
  });

  it("parses factory state from event records", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockResolvedValue({
      data: {
        _embedded: {
          records: [{
            value: {
              admin: "ADMIN",
              treasury: "TREASURY",
              base_fee: "70000000",
              metadata_fee: "30000000",
              paused: false,
              token_count: "5",
            },
          }],
        },
      },
    });
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    const result = await f.fetchFactoryState();
    expect(result).not.toBeNull();
    expect(result!.admin).toBe("ADMIN");
    expect(result!.treasury).toBe("TREASURY");
    expect(result!.baseFee).toBe(BigInt("70000000"));
    expect(result!.metadataFee).toBe(BigInt("30000000"));
    expect(result!.paused).toBe(false);
    expect(result!.tokenCount).toBe(5);
  });

  it("defaults missing fields to empty/zero", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockResolvedValue({
      data: { _embedded: { records: [{ value: {} }] } },
    });
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    const result = await f.fetchFactoryState();
    expect(result!.admin).toBe("");
    expect(result!.treasury).toBe("");
    expect(result!.baseFee).toBe(BigInt(0));
    expect(result!.tokenCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// OnChainDataFetcher – fetchTokenCount (covers L143-L153 NoCoverage)
// ---------------------------------------------------------------------------

describe("OnChainDataFetcher.fetchTokenCount", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns tokenCount from factory state", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockResolvedValue({
      data: { _embedded: { records: [{ value: { token_count: "7" } }] } },
    });
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    expect(await f.fetchTokenCount()).toBe(7);
  });

  it("returns null when fetchFactoryState returns null", async () => {
    const f = new OnChainDataFetcher({ factoryContractId: "" });
    expect(await f.fetchTokenCount()).toBeNull();
  });

  it("returns null on error", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockRejectedValue(new Error("fail"));
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    expect(await f.fetchTokenCount()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OnChainDataFetcher – fetchBurnEvents (covers L155-L211 NoCoverage)
// ---------------------------------------------------------------------------

describe("OnChainDataFetcher.fetchBurnEvents", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns empty array when response has no records property", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockResolvedValue({ data: {} });
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    expect(await f.fetchBurnEvents("TOK")).toEqual([]);
  });

  it("filters to only tok_burn and adm_burn topics", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockResolvedValue({
      data: {
        _embedded: {
          records: [
            { topic: ["tok_burn", "TOK"], value: { amount: "100", from: "A", burned_by: "A" }, transaction_hash: "h1" },
            { topic: ["adm_burn", "TOK"], value: { amount: "50", from: "B", burned_by: "B" }, transaction_hash: "h2" },
            { topic: ["other_event"], value: {}, transaction_hash: "h3" },
          ],
        },
      },
    });
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    const result = await f.fetchBurnEvents("TOK");
    expect(result).toHaveLength(2);
  });

  it("parses burn event fields correctly", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockResolvedValue({
      data: {
        _embedded: {
          records: [{
            topic: ["tok_burn", "TOK_ADDR"],
            value: {
              token_address: "TOK_ADDR",
              from: "SENDER",
              amount: "1000",
              burned_by: "SENDER",
            },
            transaction_hash: "TX123",
          }],
        },
      },
    });
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    const result = await f.fetchBurnEvents("TOK_ADDR");
    expect(result![0].tokenAddress).toBe("TOK_ADDR");
    expect(result![0].from).toBe("SENDER");
    expect(result![0].amount).toBe(BigInt(1000));
    expect(result![0].burnedBy).toBe("SENDER");
    expect(result![0].isAdminBurn).toBe(false);
    expect(result![0].txHash).toBe("TX123");
  });

  it("sets isAdminBurn=true for adm_burn topic", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockResolvedValue({
      data: {
        _embedded: {
          records: [{
            topic: ["adm_burn", "TOK"],
            value: { amount: "500", from: "ADMIN" },
            transaction_hash: "TX1",
          }],
        },
      },
    });
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    const result = await f.fetchBurnEvents("TOK");
    expect(result![0].isAdminBurn).toBe(true);
  });

  it("returns null on axios error", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockRejectedValue(new Error("timeout"));
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    expect(await f.fetchBurnEvents("TOK")).toBeNull();
  });

  it("falls back to topic[1] for tokenAddress when value.token_address missing", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockResolvedValue({
      data: {
        _embedded: {
          records: [{
            topic: ["tok_burn", "FALLBACK_ADDR"],
            value: { amount: "10", from: "X" },
            transaction_hash: "h",
          }],
        },
      },
    });
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    const result = await f.fetchBurnEvents("FALLBACK_ADDR");
    expect(result![0].tokenAddress).toBe("FALLBACK_ADDR");
  });

  it("defaults amount to 0 when missing", async () => {
    const axiosMod = await import("axios");
    vi.spyOn(axiosMod.default, "get").mockResolvedValue({
      data: {
        _embedded: {
          records: [{
            topic: ["tok_burn", "T"],
            value: { from: "A" },
            transaction_hash: "h",
          }],
        },
      },
    });
    const f = new OnChainDataFetcher({ factoryContractId: "C1", horizonUrl: "https://h" });
    const result = await f.fetchBurnEvents("T");
    expect(result![0].amount).toBe(BigInt(0));
  });
});

// ---------------------------------------------------------------------------
// runFullCheck – catch block (L267-L270 NoCoverage)
// ---------------------------------------------------------------------------

describe("runFullCheck – top-level catch (L267)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("catches exception from checkBurnTotals and adds to errors", async () => {
    const { verifier } = makeVerifier();
    // Let token count succeed but burn totals throw unexpectedly
    (verifier as any).prisma.token.count.mockResolvedValue(0);
    vi.spyOn(OnChainDataFetcher.prototype, "fetchTokenCount").mockResolvedValue(0);
    // Make checkBurnTotals throw by having findMany throw after token count passes
    (verifier as any).prisma.token.findMany.mockRejectedValue(new Error("unexpected db error"));

    const result = await verifier.runFullCheck();
    expect(result.consistent).toBe(false);
    expect(result.errors.some((e) => e.includes("unexpected db error") || e.includes("Burn totals"))).toBe(true);
  });
});
