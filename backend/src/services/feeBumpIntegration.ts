/**
 * Fee-bump integration for the token deployment pipeline (#1346).
 *
 * When a user's XLM balance is below STELLAR_FEE_BUMP_THRESHOLD_XLM,
 * the deployment transaction is automatically wrapped in a fee-bump funded by
 * the sponsor account (STELLAR_FEE_BUMP_SPONSOR_ACCOUNT).
 *
 * The sponsor is fully transparent to the user — no UI changes required.
 *
 * ## Layering (#2063)
 *
 * This module is a thin, deployment-specific wrapper around the lower-level
 * `submitFeeBump` exported by `stellar-service-integration/feeBump.service.ts`.
 * It owns only the deployment-pipeline policy — reading the balance threshold
 * and sponsor account from the environment, deciding whether a bump is needed,
 * and shaping the `{ feeBumped, result }` return value — while the actual
 * fee-bump construction and submission live in the lower-level service.
 *
 * New fee-bump-eligible flows should follow this same wrapper pattern: add a
 * thin, flow-specific module that decides *whether* to bump and then delegates
 * to `submitFeeBump`, rather than calling `submitFeeBump` directly. Keeping the
 * policy at the wrapper layer and the mechanics in the service avoids
 * duplicating submission logic across flows.
 */

import {
  submitFeeBump,
  DEFAULT_FEE_BUMP_CONFIG,
  FeeBumpResult,
  HorizonServer,
} from "../stellar-service-integration/feeBump.service";

export interface DeploymentContext {
  userBalanceXLM: number;
  originalTxHash: string;
  originalFee: string;
  buildFeeBumpTx: (bumpFee: string) => unknown;
  horizon: HorizonServer;
}

const THRESHOLD_XLM = parseFloat(
  process.env.STELLAR_FEE_BUMP_THRESHOLD_XLM ?? "1.0"
);

const SPONSOR_ACCOUNT = process.env.STELLAR_FEE_BUMP_SPONSOR_ACCOUNT ?? "";

export function isSponsorConfigured(): boolean {
  return SPONSOR_ACCOUNT.length > 0;
}

export function needsFeeBump(userBalanceXLM: number): boolean {
  return isSponsorConfigured() && userBalanceXLM < THRESHOLD_XLM;
}

/**
 * Submit a deployment transaction, automatically applying a fee-bump when
 * the user's balance is below the configured threshold.
 *
 * Thin wrapper over `submitFeeBump` (see the layering note above): it applies
 * the deployment-specific eligibility check and delegates the actual fee-bump
 * submission to the lower-level service.
 *
 * Returns `{ feeBumped: true, result }` when a fee-bump was applied,
 * or `{ feeBumped: false, result: null }` when balance was sufficient.
 */
export async function submitDeploymentWithFeeBump(
  ctx: DeploymentContext
): Promise<{ feeBumped: boolean; result: FeeBumpResult | null }> {
  if (!needsFeeBump(ctx.userBalanceXLM)) {
    return { feeBumped: false, result: null };
  }

  const result = await submitFeeBump(
    ctx.originalTxHash,
    ctx.originalFee,
    ctx.buildFeeBumpTx,
    ctx.horizon,
    DEFAULT_FEE_BUMP_CONFIG
  );

  return { feeBumped: true, result };
}
