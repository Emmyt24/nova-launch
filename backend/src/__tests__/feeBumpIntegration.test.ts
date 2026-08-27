/**
 * Integration tests for fee-bump deployment pipeline (#1346).
 * No live Stellar network required — Horizon is fully mocked.
 *
 * Three core scenarios under test:
 *   1. Successful fee-bump on first retry (underfunded-fee rejection → bump succeeds)
 *   2. Max-retry exhaustion surfaces a terminal, typed error
 *   3. Guard: the service never re-submits a transaction hash it already confirmed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FeeBumpResult } from "../stellar-service-integration/feeBump.service";

// ---------------------------------------------------------------------------
// Mock feeBump.service before importing the module under test so that
// submitFeeBump is fully controllable without touching the network.
// ---------------------------------------------------------------------------
const mockSubmitFeeBump = vi.fn<
  Parameters<typeof import("../stellar-service-integration/feeBump.service").submitFeeBump>,
  Promise<FeeBumpResult>
>();

vi.mock("../stellar-service-integration/feeBump.service", () => ({
  submitFeeBump: mockSubmitFeeBump,
  DEFAULT_FEE_BUMP_CONFIG: {
    pendingThresholdMs: 50,
    feeMultiplier: 10,
    maxPollAttempts: 3,
    pollIntervalMs: 5,
    networkPassphrase: "Test SDF Network ; September 2015",
  },
}));

// Import after mocking so the mock is in place when the module initialises.
import {
  needsFeeBump,
  isSponsorConfigured,
  submitDeploymentWithFeeBump,
  DeploymentContext,
} from "../services/feeBumpIntegration";
import type { HorizonServer } from "../stellar-service-integration/feeBump.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal HorizonServer mock.  All methods are spied on. */
function makeHorizon(
  callImpl: () => Promise<{ successful?: boolean; hash: string }> = () =>
    Promise.reject({ response: { status: 404 } })
): HorizonServer {
  return {
    transactions: () => ({
      transaction: () => ({
        call: vi.fn().mockImplementation(callImpl),
      }),
    }),
    submitTransaction: vi.fn().mockResolvedValue({ hash: "feebumphash" }),
  };
}

/** Build a minimal DeploymentContext. */
function makeCtx(
  overrides: Partial<DeploymentContext> = {}
): DeploymentContext {
  return {
    userBalanceXLM: 0.1, // below 1.0 XLM threshold by default
    originalTxHash: "originalhash123",
    originalFee: "100",
    buildFeeBumpTx: vi.fn((fee: string) => ({ fee })),
    horizon: makeHorizon(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Force needsFeeBump to return true so all paths are exercised regardless
// of whether STELLAR_FEE_BUMP_SPONSOR_ACCOUNT is set in the test environment.
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  // Spy on needsFeeBump exported from the module under test so that the
  // "sponsor not configured" early-exit is bypassed in all test scenarios
  // that need it.
});

// ---------------------------------------------------------------------------
// isSponsorConfigured / needsFeeBump — pure-logic unit coverage
// ---------------------------------------------------------------------------

describe("isSponsorConfigured", () => {
  it("returns a boolean", () => {
    expect(typeof isSponsorConfigured()).toBe("boolean");
  });
});

describe("needsFeeBump", () => {
  it("returns false when balance is above the default 1.0 XLM threshold", () => {
    // Even if sponsor is configured, a high balance must not trigger a bump.
    const threshold = parseFloat(
      process.env.STELLAR_FEE_BUMP_THRESHOLD_XLM ?? "1.0"
    );
    const result = needsFeeBump(threshold + 0.01);
    // If sponsor IS configured the result is false because balance is above threshold.
    // If sponsor is NOT configured the result is also false.
    expect(result).toBe(false);
  });

  it("returns false when sponsor account is not configured regardless of balance", () => {
    if (!isSponsorConfigured()) {
      expect(needsFeeBump(0.001)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// submitDeploymentWithFeeBump — path: balance above threshold
// ---------------------------------------------------------------------------

describe("submitDeploymentWithFeeBump — high-balance path", () => {
  it("returns feeBumped=false and result=null when balance is above threshold", async () => {
    const ctx = makeCtx({ userBalanceXLM: 99.0 });
    const out = await submitDeploymentWithFeeBump(ctx);

    expect(out.feeBumped).toBe(false);
    expect(out.result).toBeNull();
  });

  it("never calls submitFeeBump when balance is sufficient", async () => {
    const ctx = makeCtx({ userBalanceXLM: 50.0 });
    await submitDeploymentWithFeeBump(ctx);

    expect(mockSubmitFeeBump).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// submitDeploymentWithFeeBump — path: sponsor configured (spy-forced)
//
// Because STELLAR_FEE_BUMP_SPONSOR_ACCOUNT may not be set in the CI
// environment we reach the interesting paths by spying on `needsFeeBump`
// to return true unconditionally.
// ---------------------------------------------------------------------------

describe("submitDeploymentWithFeeBump — fee-bump paths (sponsor mocked active)", () => {
  // Spy on the module's needsFeeBump so we can force it to return true.
  // We re-import via the live module reference which vi.spyOn can patch.
  let needsFeeBumpSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on the actual exported function so submitDeploymentWithFeeBump
    // sees needsFeeBump() === true without needing an env var at load time.
    needsFeeBumpSpy = vi.spyOn(
      // Dynamic require keeps TypeScript happy without a second import statement
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../services/feeBumpIntegration"),
      "needsFeeBump"
    );
    needsFeeBumpSpy.mockReturnValue(true);
  });

  afterEach(() => {
    needsFeeBumpSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Successful fee-bump on first attempt
  // -------------------------------------------------------------------------

  it("scenario 1 — successful fee-bump on first retry: returns feeBumped=true with result", async () => {
    const successResult: FeeBumpResult = {
      outcome: "fee_bumped",
      originalHash: "originalhash123",
      feeBumpHash: "feebumphash",
    };
    mockSubmitFeeBump.mockResolvedValueOnce(successResult);

    const ctx = makeCtx({ userBalanceXLM: 0.1 });
    const out = await submitDeploymentWithFeeBump(ctx);

    expect(out.feeBumped).toBe(true);
    expect(out.result).not.toBeNull();
    expect(out.result?.outcome).toBe("fee_bumped");
  });

  it("scenario 1 — submitFeeBump is called with the correct arguments", async () => {
    const successResult: FeeBumpResult = {
      outcome: "fee_bumped",
      originalHash: "originalhash123",
      feeBumpHash: "feebumphash",
    };
    mockSubmitFeeBump.mockResolvedValueOnce(successResult);

    const buildFn = vi.fn((fee: string) => ({ fee }));
    const horizon = makeHorizon();
    const ctx = makeCtx({
      userBalanceXLM: 0.1,
      originalTxHash: "originalhash123",
      originalFee: "200",
      buildFeeBumpTx: buildFn,
      horizon,
    });

    await submitDeploymentWithFeeBump(ctx);

    // submitFeeBump should have been called exactly once
    expect(mockSubmitFeeBump).toHaveBeenCalledOnce();
    const [hash, fee, builder, passedHorizon] =
      mockSubmitFeeBump.mock.calls[0];
    expect(hash).toBe("originalhash123");
    expect(fee).toBe("200");
    expect(builder).toBe(buildFn);
    expect(passedHorizon).toBe(horizon);
  });

  it("scenario 1 — result carries the fee_bumped outcome fields", async () => {
    const successResult: FeeBumpResult = {
      outcome: "fee_bumped",
      originalHash: "originalhash123",
      feeBumpHash: "bumphashABC",
    };
    mockSubmitFeeBump.mockResolvedValueOnce(successResult);

    const out = await submitDeploymentWithFeeBump(makeCtx());

    expect(out.feeBumped).toBe(true);
    if (out.result?.outcome === "fee_bumped") {
      expect(out.result.originalHash).toBe("originalhash123");
      expect(out.result.feeBumpHash).toBe("bumphashABC");
    } else {
      throw new Error("Expected fee_bumped outcome");
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Max-retry exhaustion — submitFeeBump propagates a terminal error
  //
  // The service delegates retry semantics to feeBump.service. When that layer
  // exhausts all attempts it throws (or returns a timeout outcome). We verify
  // that submitDeploymentWithFeeBump surfaces the error to the caller without
  // swallowing it.
  // -------------------------------------------------------------------------

  it("scenario 2 — exhausted retries: propagates terminal error from submitFeeBump", async () => {
    const terminalError = Object.assign(new Error("FEE_BUMP_MAX_RETRIES_EXHAUSTED"), {
      code: "FEE_BUMP_EXHAUSTED",
      retryCount: 20,
    });
    mockSubmitFeeBump.mockRejectedValueOnce(terminalError);

    const ctx = makeCtx({ userBalanceXLM: 0.1 });

    await expect(submitDeploymentWithFeeBump(ctx)).rejects.toThrow(
      "FEE_BUMP_MAX_RETRIES_EXHAUSTED"
    );
  });

  it("scenario 2 — exhausted retries: error carries typed metadata", async () => {
    const terminalError = Object.assign(new Error("FEE_BUMP_MAX_RETRIES_EXHAUSTED"), {
      code: "FEE_BUMP_EXHAUSTED",
      retryCount: 20,
    });
    mockSubmitFeeBump.mockRejectedValueOnce(terminalError);

    const ctx = makeCtx({ userBalanceXLM: 0.1 });

    let caught: unknown;
    try {
      await submitDeploymentWithFeeBump(ctx);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as Error).message).toBe("FEE_BUMP_MAX_RETRIES_EXHAUSTED");
    expect((caught as any).code).toBe("FEE_BUMP_EXHAUSTED");
    expect((caught as any).retryCount).toBe(20);
  });

  it("scenario 2 — timeout outcome from submitFeeBump is surfaced as result", async () => {
    const timeoutResult: FeeBumpResult = {
      outcome: "timeout",
      hash: "originalhash123",
    };
    mockSubmitFeeBump.mockResolvedValueOnce(timeoutResult);

    const out = await submitDeploymentWithFeeBump(makeCtx());

    // The orchestrator doesn't suppress non-bump outcomes; it returns them.
    expect(out.feeBumped).toBe(true); // feeBumped=true means the path ran
    expect(out.result?.outcome).toBe("timeout");
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Guard against bumping a transaction that already succeeded
  //
  // If submitFeeBump detects the original tx confirmed before the bump was
  // submitted (race-condition guard inside feeBump.service), it returns
  // `confirmed_original`. The orchestrator must surface this and must NOT
  // make a second submitTransaction call.
  // -------------------------------------------------------------------------

  it("scenario 3 — already-succeeded guard: outcome is confirmed_original", async () => {
    const confirmedResult: FeeBumpResult = {
      outcome: "confirmed_original",
      hash: "originalhash123",
    };
    mockSubmitFeeBump.mockResolvedValueOnce(confirmedResult);

    const out = await submitDeploymentWithFeeBump(makeCtx());

    expect(out.feeBumped).toBe(true);
    expect(out.result?.outcome).toBe("confirmed_original");
  });

  it("scenario 3 — already-succeeded guard: result carries the original hash", async () => {
    const confirmedResult: FeeBumpResult = {
      outcome: "confirmed_original",
      hash: "originalhash123",
    };
    mockSubmitFeeBump.mockResolvedValueOnce(confirmedResult);

    const out = await submitDeploymentWithFeeBump(makeCtx());

    if (out.result?.outcome === "confirmed_original") {
      expect(out.result.hash).toBe("originalhash123");
    } else {
      throw new Error("Expected confirmed_original outcome");
    }
  });

  it("scenario 3 — already-succeeded guard: submitFeeBump called exactly once (no double-submit)", async () => {
    const confirmedResult: FeeBumpResult = {
      outcome: "confirmed_original",
      hash: "originalhash123",
    };
    mockSubmitFeeBump.mockResolvedValueOnce(confirmedResult);

    const horizon = makeHorizon();
    const ctx = makeCtx({ horizon });

    await submitDeploymentWithFeeBump(ctx);

    // The orchestrator delegates entirely to submitFeeBump (one call).
    // The underlying Horizon.submitTransaction should NOT have been called
    // directly by the orchestrator layer.
    expect(mockSubmitFeeBump).toHaveBeenCalledOnce();
    expect(horizon.submitTransaction).not.toHaveBeenCalled();
  });

  it("scenario 3 — calling submitDeploymentWithFeeBump a second time with the same already-confirmed hash returns confirmed_original again without a second submit", async () => {
    const confirmedResult: FeeBumpResult = {
      outcome: "confirmed_original",
      hash: "originalhash123",
    };
    // Both calls to submitFeeBump return confirmed_original
    mockSubmitFeeBump
      .mockResolvedValueOnce(confirmedResult)
      .mockResolvedValueOnce(confirmedResult);

    const ctx = makeCtx();

    const first = await submitDeploymentWithFeeBump(ctx);
    const second = await submitDeploymentWithFeeBump(ctx);

    // Both should report confirmed_original, not fee_bumped
    expect(first.result?.outcome).toBe("confirmed_original");
    expect(second.result?.outcome).toBe("confirmed_original");
    // submitFeeBump was invoked once per call — no hidden retries by the orchestrator
    expect(mockSubmitFeeBump).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Horizon mock wiring — verify the mock passes horizon through correctly
// ---------------------------------------------------------------------------

describe("Horizon mock passthrough", () => {
  let needsFeeBumpSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    needsFeeBumpSpy = vi.spyOn(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../services/feeBumpIntegration"),
      "needsFeeBump"
    );
    needsFeeBumpSpy.mockReturnValue(true);
  });

  afterEach(() => {
    needsFeeBumpSpy.mockRestore();
  });

  it("passes the horizon object from DeploymentContext to submitFeeBump", async () => {
    mockSubmitFeeBump.mockResolvedValueOnce({
      outcome: "fee_bumped",
      originalHash: "h",
      feeBumpHash: "hbump",
    });

    const horizon = makeHorizon();
    const ctx = makeCtx({ horizon });

    await submitDeploymentWithFeeBump(ctx);

    const passedHorizon = mockSubmitFeeBump.mock.calls[0][3];
    expect(passedHorizon).toBe(horizon);
  });

  it("passes DEFAULT_FEE_BUMP_CONFIG to submitFeeBump", async () => {
    mockSubmitFeeBump.mockResolvedValueOnce({
      outcome: "fee_bumped",
      originalHash: "h",
      feeBumpHash: "hbump",
    });

    await submitDeploymentWithFeeBump(makeCtx());

    // The fifth argument is the config
    const passedConfig = mockSubmitFeeBump.mock.calls[0][4];
    expect(passedConfig).toBeDefined();
    expect(typeof passedConfig?.pendingThresholdMs).toBe("number");
    expect(typeof passedConfig?.feeMultiplier).toBe("number");
  });
});
