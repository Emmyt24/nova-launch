import { describe, expect, it, vi } from "vitest";
import {
  submitFeeBump,
  type FeeBumpConfig,
  type HorizonServer,
  type HorizonTransactionRecord,
} from "../feeBump.service";

vi.mock("../rate-limiter", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

const config: FeeBumpConfig = {
  pendingThresholdMs: 60_000,
  feeMultiplier: 10,
  maxPollAttempts: 1,
  pollIntervalMs: 0,
  networkPassphrase: "test network",
};

const notFound = Object.assign(new Error("transaction not found"), {
  response: { status: 404 },
});

function createHorizon(
  responses: Array<HorizonTransactionRecord | Error>,
  submitResult: { hash: string } = { hash: "bump-hash" }
) {
  const call = vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw notFound;
    return response;
  });
  const transaction = vi.fn().mockReturnValue({ call });
  const horizon = {
    transactions: vi.fn().mockReturnValue({ transaction }),
    submitTransaction: vi.fn().mockResolvedValue(submitResult),
  } as unknown as HorizonServer;

  return { horizon, call, transaction };
}

describe("submitFeeBump", () => {
  it("returns the original transaction when polling finds it confirmed", async () => {
    const { horizon } = createHorizon([{ hash: "original-hash", successful: true }]);
    const build = vi.fn();

    await expect(
      submitFeeBump("original-hash", "100", build, horizon, config)
    ).resolves.toEqual({ outcome: "confirmed_original", hash: "original-hash" });
    expect(build).not.toHaveBeenCalled();
    expect(horizon.submitTransaction).not.toHaveBeenCalled();
  });

  it("builds and submits a fee bump when Horizon returns 404", async () => {
    const { horizon } = createHorizon([notFound, notFound]);
    const feeBumpTx = { signed: true };
    const build = vi.fn().mockReturnValue(feeBumpTx);

    await expect(
      submitFeeBump("original-hash", "125", build, horizon, config)
    ).resolves.toEqual({
      outcome: "fee_bumped",
      originalHash: "original-hash",
      feeBumpHash: "bump-hash",
    });
    expect(build).toHaveBeenCalledWith("1250");
    expect(horizon.submitTransaction).toHaveBeenCalledWith(feeBumpTx);
  });

  it("skips submission when the original confirms during the race check", async () => {
    const { horizon } = createHorizon([
      notFound,
      { hash: "original-hash", successful: false },
    ]);
    const build = vi.fn().mockReturnValue({ signed: true });

    await expect(
      submitFeeBump("original-hash", "100", build, horizon, config)
    ).resolves.toEqual({ outcome: "confirmed_original", hash: "original-hash" });
    expect(build).toHaveBeenCalledOnce();
    expect(horizon.submitTransaction).not.toHaveBeenCalled();
  });

  it("propagates unexpected Horizon errors instead of treating them as missing", async () => {
    const failure = Object.assign(new Error("Horizon unavailable"), {
      response: { status: 503 },
    });
    const { horizon } = createHorizon([failure]);

    await expect(
      submitFeeBump("original-hash", "100", vi.fn(), horizon, config)
    ).rejects.toThrow("Horizon unavailable");
    expect(horizon.submitTransaction).not.toHaveBeenCalled();
  });

  it("propagates fee-bump submission failures", async () => {
    const { horizon } = createHorizon([notFound, notFound]);
    const submitFailure = new Error("submission rejected");
    vi.mocked(horizon.submitTransaction).mockRejectedValueOnce(submitFailure);

    await expect(
      submitFeeBump("original-hash", "100", vi.fn(), horizon, config)
    ).rejects.toThrow("submission rejected");
  });
});