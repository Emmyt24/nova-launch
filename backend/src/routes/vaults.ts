/**
 * Vaults route — read-only projection of on-chain *stream* vaults.
 *
 * Naming history: "vault" here means the token-factory contract's streaming
 * escrow (`vault.rs` / `streaming.rs`): a creator funds an amount, the
 * beneficiary claims it, or the creator cancels. Every handler below is a
 * query over `streamProjectionService` (the `Stream` table). This is what
 * `routes/streams.ts` refers to when it calls itself "distinct from
 * `routes/vaults.ts`", which backs the ingestion pipeline rather than
 * off-chain stream metadata.
 *
 * Relationship to the contract's *fractionalization* model
 * (contracts/token-factory/src/fractionalization.rs): none at runtime — this
 * route layer does not expose fractionalization, and none of the handlers below
 * can mint, transfer, or redeem fractional shares. The two "vault" concepts
 * share a word and nothing else, so the redemption rules of one must not be
 * assumed to apply to the other.
 *
 * The 100%-accumulation redemption requirement (contract-side, documented in
 * fractionalization.rs) is restated here because contributors building a
 * redemption UI from the backend entry point have no other way to discover it:
 *  - `fractionalize` locks exactly one indivisible unit (`UNIQUE_ASSET_AMOUNT`)
 *    of an external SAC asset and mints the entire `total_supply` of
 *    fractional shares to the single `owner`. Shares are ledger entries in
 *    `FractionalShareBalance`, not a deployed token.
 *  - `redeem` (contract entry point `redeem_fractional_asset`) requires the
 *    caller to hold and burn 100% of the outstanding shares
 *    (`caller_shares == vault.total_supply`) before it releases the locked
 *    asset. Any other balance fails with `Error::InsufficientShares`.
 *  - `transfer_shares` (contract entry point `transfer_fractional_shares`) is
 *    the ONLY way shares move between addresses, so a partial holder cannot
 *    redeem their slice: the shares must first be consolidated back into one
 *    address via transfers before `redeem` becomes callable. There is no
 *    partial redemption, no pro-rata claim, and no "burn your shares, take
 *    your fraction of the asset" path — the underlying asset is a single
 *    indivisible unit.
 *
 * Deliberate exceptions to the "must hold 100% to redeem" rule (all of them
 * are contract behavior, not backend behavior):
 *  - The single-owner trivial case needs no consolidation at all: `fractionalize`
 *    mints the full supply to `owner`, so `owner` may redeem immediately. The
 *    `transfer_shares` round trip only becomes necessary once shares have
 *    actually been split between holders.
 *  - Read-only queries (`is_asset_fractionalized`, `get_fractional_vault`,
 *    `get_fractional_share_balance`) are not gated on share ownership, so they
 *    are answerable for any holder regardless of how shares are distributed.
 *  - `redeem` rejects with `Error::ContractPaused` before it evaluates share
 *    balances, so a paused contract fails for every caller regardless of
 *    holdings.
 *  - A successful redemption flips the vault to `FractionalStatus::Redeemed`;
 *    subsequent redeem attempts fail with `Error::FractionalVaultNotFound`
 *    rather than `InsufficientShares`. The same `(asset_contract, asset_id)`
 *    pair may then be fractionalized again, starting from a fresh 100%-to-owner
 *    supply.
 *
 * Deliberate exception for this route layer: none of the handlers below is a
 * redemption path, so the 100%-accumulation requirement constrains no response
 * shape here. `GET /api/vaults/:id` is keyed by on-chain *streamId*
 * (`DataKey::StreamCount`), not by the fractionalization vault id
 * (`DataKey::FractionalVaultCount`) — the two counters are independent and their
 * numeric values can overlap, so a fractionalization vault id is not a valid
 * lookup key for this route even when the numbers coincide.
 */

import { Router } from "express";
import { StreamStatus, StreamWithdrawalType } from "@prisma/client";
import { streamProjectionService } from "../services/streamProjectionService";
import { successResponse, errorResponse } from "../utils/response";

const router = Router();

function parseListOpts(query: any) {
  const limit = Math.min(parseInt(query.limit as string) || 50, 200);
  const offset = parseInt(query.offset as string) || 0;
  const status = query.status as StreamStatus | undefined;
  if (status && !Object.values(StreamStatus).includes(status)) {
    return { error: `Invalid status. Must be one of: ${Object.values(StreamStatus).join(", ")}` };
  }
  return { limit, offset, status };
}

/**
 * GET /api/vaults/creator/:address?status=CREATED&limit=50&offset=0
 * Vaults created by address.
 */
router.get("/creator/:address", async (req, res) => {
  const opts = parseListOpts(req.query);
  if ("error" in opts) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: opts.error! }));
  try {
    const vaults = await streamProjectionService.getStreamsByCreator(req.params.address, opts);
    res.json(successResponse(vaults));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch creator vaults" }));
  }
});

/**
 * GET /api/vaults/beneficiary/:address?status=CREATED&limit=50&offset=0
 * Vaults where address is the beneficiary (recipient).
 */
router.get("/beneficiary/:address", async (req, res) => {
  const opts = parseListOpts(req.query);
  if ("error" in opts) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: opts.error! }));
  try {
    const vaults = await streamProjectionService.getStreamsByRecipient(req.params.address, opts);
    res.json(successResponse(vaults));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch beneficiary vaults" }));
  }
});

/**
 * GET /api/vaults/:id
 * Single vault by on-chain streamId.
 *
 * `:id` is a *stream* id, not a fractionalization vault id — see the file
 * header for the 100%-accumulation redemption requirement that governs the
 * contract-side fractionalization model, and for why its id space is separate.
 */
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: "Invalid vault ID" }));
  try {
    const vault = await streamProjectionService.getStreamById(id);
    if (!vault) return res.status(404).json(errorResponse({ code: "NOT_FOUND", message: "Vault not found" }));
    res.json(successResponse(vault));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch vault" }));
  }
});

/**
 * GET /api/vaults/:id/withdrawals?limit=10&cursor=...
 * Withdrawal history for a vault with cursor-based pagination.
 */
router.get("/:id/withdrawals", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: "Invalid vault ID" }));

  const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
  const cursor = req.query.cursor as string | undefined;
  const status = req.query.status as string | undefined;

  // Validate status filter if provided
  const validStatuses = ["CLAIMED", "CANCELLED"];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json(
      errorResponse({
        code: "INVALID_INPUT",
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      })
    );
  }

  try {
    const vault = await streamProjectionService.getStreamById(id);
    if (!vault) return res.status(404).json(errorResponse({ code: "NOT_FOUND", message: "Vault not found" }));

    // Real withdrawal transactions recorded from on-chain claim/cancel events,
    // already ordered most recent first.
    const records = await streamProjectionService.getWithdrawalsByStreamId(id, {
      transactionType: status as StreamWithdrawalType | undefined,
    });
    const withdrawals = records.map((w) => ({
      id: `${id}-${w.transactionType === "CLAIMED" ? "claim" : "cancel"}-${w.txHash}`,
      vaultId: id,
      transactionType: w.transactionType,
      amount: w.amount,
      timestamp: w.timestamp.toISOString(),
      txHash: w.txHash,
      recipient: w.recipient,
    }));

    // Implement cursor-based pagination
    const startIndex = cursor ? Math.max(0, parseInt(atob(cursor), 10)) : 0;
    const paginatedWithdrawals = withdrawals.slice(startIndex, startIndex + limit);
    const nextIndex = startIndex + limit;
    const hasMore = nextIndex < withdrawals.length;

    res.json(
      successResponse({
        withdrawals: paginatedWithdrawals,
        nextCursor: hasMore ? btoa(nextIndex.toString()) : undefined,
        prevCursor: startIndex > 0 ? btoa(Math.max(0, startIndex - limit).toString()) : undefined,
        hasMore,
        totalCount: withdrawals.length,
      })
    );
  } catch (err) {
    console.error(err);
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch withdrawal history" }));
  }
});

export default router;
