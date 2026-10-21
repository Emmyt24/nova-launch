/**
 * POST /api/admin/reconcile/:tokenAddress
 *
 * Manually trigger reconciliation of the Prisma projection for a single token
 * against current on-chain state fetched via Horizon API.
 *
 * Idempotent — calling this endpoint multiple times is safe.
 *
 * GET /api/admin/reconcile/vaults/report
 *
 * Read-only report comparing on-chain vault state with the `Stream`
 * projection (#2208). Admin only.
 */
import { Router } from "express";
import { authenticateAdmin } from "../../middleware/auth";
import { successResponse, errorResponse } from "../../utils/response";
import { OnChainProjectionVerifier } from "../../services/consistency/onchainProjectionVerifier";
import { prisma } from "../../lib/prisma";

const router = Router();

router.get("/vaults/report", authenticateAdmin, async (_req, res) => {
  try {
    const verifier = new OnChainProjectionVerifier(prisma);
    const report = await verifier.buildVaultReconciliationReport();
    return res.json(successResponse(report));
  } catch (error) {
    console.error("Vault reconciliation report error:", error);
    return res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to build vault reconciliation report",
      })
    );
  }
});

router.post("/:tokenAddress", authenticateAdmin, async (req, res) => {
  const { tokenAddress } = req.params;

  if (!tokenAddress || tokenAddress.trim() === "") {
    return res.status(400).json(
      errorResponse({
        code: "INVALID_REQUEST",
        message: "tokenAddress is required",
      })
    );
  }

  try {
    const verifier = new OnChainProjectionVerifier(prisma);
    const result = await verifier.reconcileProjection(tokenAddress.trim());

    return res.json(
      successResponse({
        tokenAddress: result.tokenAddress,
        fieldsUpdated: result.fieldsUpdated,
        alreadyConsistent: result.alreadyConsistent,
        lastReconciledAt: result.lastReconciledAt,
      })
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Reconciliation failed";

    if (message.includes("token not found in projection")) {
      return res.status(404).json(
        errorResponse({ code: "NOT_FOUND", message })
      );
    }

    console.error("Reconciliation error:", error);
    return res.status(500).json(
      errorResponse({ code: "INTERNAL_SERVER_ERROR", message })
    );
  }
});

export default router;
