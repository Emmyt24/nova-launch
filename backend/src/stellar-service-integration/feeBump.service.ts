/**
 * Fee-bump service for stuck Stellar transactions (#1159).
 *
 * A transaction is considered "stuck" when it has been pending for longer than
 * pendingThresholdMs (default 60 s). The service wraps the original envelope in
 * a fee-bump transaction that pays a higher fee, then submits it.
 * If the original confirms before the bump is submitted the service detects the
 * success and skips the bump to avoid double-submission.
 *
 * Threshold: controlled by FEE_BUMP_PENDING_THRESHOLD_MS env var (default 60 s).
 *
 * The service accepts a HorizonServer interface so callers (and tests) can
 * inject any compatible implementation without importing the SDK directly.
 *
 * Layering (#2063): this module is the single lower-level fee-bump
 * implementation. Higher-level, flow-specific entry points (for example
 * `services/feeBumpIntegration.ts`'s `submitDeploymentWithFeeBump`) are thin
 * wrappers that delegate here. New fee-bump-eligible flows should follow that
 * same wrapper pattern rather than calling `submitFeeBump` directly, so the
 * polling/race-guard logic stays in one place.
 */

import { sleep } from "./rate-limiter";

// ---------------------------------------------------------------------------
// Minimal interface — only the Horizon methods we actually call
// ---------------------------------------------------------------------------

export interface HorizonTransactionRecord {
  successful?: boolean;
  hash: string;
}

export interface HorizonServer {
  transactions(): {
    transaction(hash: string): { call(): Promise<HorizonTransactionRecord> };
  };
  submitTransaction(tx: unknown): Promise<{ hash: string }>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeeBumpConfig {
  /** How long (ms) to wait before considering a tx stuck. Default: 60_000 */
  pendingThresholdMs: number;
  /** Multiplier applied to the original fee. Default: 10 */
  feeMultiplier: number;
  /** How many times to poll before giving up. Default: 20 */
  maxPollAttempts: number;
  /** Interval between polls (ms). Default: 3_000 */
  pollIntervalMs: number;
  /** Stellar network passphrase */
  networkPassphrase: string;
}

export const DEFAULT_FEE_BUMP_CONFIG: FeeBumpConfig = {
  pendingThresholdMs:
    parseInt(process.env.FEE_BUMP_PENDING_THRESHOLD_MS ?? "60000", 10),
  feeMultiplier: 10,
  maxPollAttempts: 20,
  pollIntervalMs: 3_000,
  networkPassphrase: "Test SDF Network ; September 2015",
};

export type FeeBumpResult =
  | { outcome: "confirmed_original"; hash: string }
  | { outcome: "fee_bumped"; originalHash: string; feeBumpHash: string }
  | { outcome: "timeout"; hash: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function pollUntilConfirmedOrStuck(
  horizon: HorizonServer,
  txHash: string,
  config: FeeBumpConfig
): Promise<boolean> {
  const deadline = Date.now() + config.pendingThresholdMs;

  for (let i = 0; i < config.maxPollAttempts; i++) {
    if (Date.now() >= deadline) break;

    try {
      const tx = await horizon.transactions().transaction(txHash).call();
      if (tx.successful !== undefined) return true;
    } catch (err: any) {
      if (err?.response?.status !== 404) throw err;
    }

    await sleep(config.pollIntervalMs);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Submit a fee-bump wrapping the given inner transaction.
 *
 * This is the lower-level primitive shared by all fee-bump flows. Prefer
 * calling a flow-specific wrapper (e.g. `submitDeploymentWithFeeBump` in
 * `services/feeBumpIntegration.ts`) instead of invoking this directly, so the
 * wrapper can own flow-specific concerns while this function owns the
 * polling/race-guard/submission logic.
 *
 * @param innerTx          The original (inner) transaction object
 * @param originalHash     Hex hash of the inner transaction
 * @param originalFee      Fee string of the inner transaction (in stroops)
 * @param buildFeeBumpTx   Factory that builds and signs the fee-bump tx
 * @param horizon          Horizon server instance
 * @param config           Fee-bump configuration
 */
export async function submitFeeBump(
  originalHash: string,
  originalFee: string,
  buildFeeBumpTx: (bumpFee: string) => unknown,
  horizon: HorizonServer,
  config: FeeBumpConfig = DEFAULT_FEE_BUMP_CONFIG
): Promise<FeeBumpResult> {
  // Poll to see if the original already confirmed
  const alreadyConfirmed = await pollUntilConfirmedOrStuck(
    horizon,
    originalHash,
    config
  );

  if (alreadyConfirmed) {
    return { outcome: "confirmed_original", hash: originalHash };
  }

  // Build the fee-bump transaction
  const bumpFee = String(parseInt(originalFee, 10) * config.feeMultiplier);
  const feeBumpTx = buildFeeBumpTx(bumpFee);

  // Race-condition guard: check once more before submitting
  try {
    const check = await horizon.transactions().transaction(originalHash).call();
    if (check.successful !== undefined) {
      return { outcome: "confirmed_original", hash: originalHash };
    }
  } catch (err: any) {
    if (err?.response?.status !== 404) throw err;
  }

  const response = await horizon.submitTransaction(feeBumpTx);
  return { outcome: "fee_bumped", originalHash, feeBumpHash: response.hash };
}
