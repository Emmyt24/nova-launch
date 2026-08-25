/**
 * Pull-model dividend distribution routes (#1759).
 *
 * The backend never holds a holder's or the admin's private key, so every
 * write endpoint here returns an *unsigned* transaction XDR for the caller's
 * wallet to sign — matching how other on-chain write paths in this API are
 * expected to work once wired to a real signer (see the TODO in
 * `batchTokenDeployService.callStellarDeploy`). `/submit` relays a
 * caller-signed envelope back to the network.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticateAdmin } from "../middleware/auth";
import { successResponse, errorResponse } from "../utils/response";
import * as dividendService from "../services/dividendService";

const router = Router();

const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;
const stellarAddress = z
  .string()
  .regex(STELLAR_ADDRESS_RE, "Invalid Stellar address");
const amountString = z
  .string()
  .regex(/^\d+$/, "Amount must be a non-negative integer string");

function handleServiceError(res: Response, err: unknown) {
  const message = err instanceof Error ? err.message : "Unexpected error";
  const status = /not\s*found/i.test(message) ? 404 : 400;
  res.status(status).json(errorResponse({ code: "DIVIDEND_ERROR", message }));
}

// ── Write: build unsigned transactions ──────────────────────────────────────

const initiateSchema = z.object({
  admin: stellarAddress,
  tokenIndex: z.number().int().nonnegative(),
  asset: stellarAddress,
  totalAmount: amountString,
  claimDeadlineLedger: z.number().int().positive(),
});

/**
 * POST /api/dividends/initiate
 * Admin-only: build an unsigned `initiate_distribution` transaction.
 */
router.post(
  "/initiate",
  authenticateAdmin,
  async (req: Request, res: Response) => {
    const parsed = initiateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(
        errorResponse({
          code: "INVALID_INPUT",
          message: "Invalid request body",
          details: parsed.error.issues,
        })
      );
    }
    try {
      const tx = await dividendService.buildInitiateDistributionTx(parsed.data);
      res.json(successResponse(tx));
    } catch (err) {
      handleServiceError(res, err);
    }
  }
);

const claimSchema = z.object({
  holder: stellarAddress,
  distributionId: z.number().int().nonnegative(),
});

/**
 * POST /api/dividends/claim
 * Build an unsigned `claim_dividend` transaction for `holder`.
 */
router.post("/claim", async (req: Request, res: Response) => {
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(
      errorResponse({
        code: "INVALID_INPUT",
        message: "Invalid request body",
        details: parsed.error.issues,
      })
    );
  }
  try {
    const tx = await dividendService.buildClaimDividendTx(parsed.data);
    res.json(successResponse(tx));
  } catch (err) {
    handleServiceError(res, err);
  }
});

const reclaimSchema = z.object({
  admin: stellarAddress,
  distributionId: z.number().int().nonnegative(),
});

/**
 * POST /api/dividends/reclaim
 * Admin-only: build an unsigned `reclaim_unclaimed` transaction.
 */
router.post(
  "/reclaim",
  authenticateAdmin,
  async (req: Request, res: Response) => {
    const parsed = reclaimSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(
        errorResponse({
          code: "INVALID_INPUT",
          message: "Invalid request body",
          details: parsed.error.issues,
        })
      );
    }
    try {
      const tx = await dividendService.buildReclaimUnclaimedTx(parsed.data);
      res.json(successResponse(tx));
    } catch (err) {
      handleServiceError(res, err);
    }
  }
);

const submitSchema = z.object({ signedXdr: z.string().min(1) });

/**
 * POST /api/dividends/submit
 * Relay a caller-signed transaction envelope (from any of the three
 * build endpoints above) to the network.
 */
router.post("/submit", async (req: Request, res: Response) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(
      errorResponse({
        code: "INVALID_INPUT",
        message: "Invalid request body",
        details: parsed.error.issues,
      })
    );
  }
  try {
    const result = await dividendService.submitSignedDividendTx(
      parsed.data.signedXdr
    );
    res.json(successResponse(result));
  } catch (err) {
    handleServiceError(res, err);
  }
});

// ── Read: live on-chain queries ──────────────────────────────────────────────

/**
 * GET /api/dividends
 * Total number of distributions initiated.
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const count = await dividendService.getDistributionCount();
    res.json(successResponse({ count }));
  } catch (err) {
    handleServiceError(res, err);
  }
});

function parseDistributionId(req: Request, res: Response): number | null {
  const id = Number(req.params.distributionId);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json(
      errorResponse({
        code: "INVALID_INPUT",
        message: "Invalid distribution id",
      })
    );
    return null;
  }
  return id;
}

/**
 * GET /api/dividends/:distributionId
 * Live on-chain distribution record.
 */
router.get("/:distributionId", async (req: Request, res: Response) => {
  const distributionId = parseDistributionId(req, res);
  if (distributionId === null) return;
  try {
    const record = await dividendService.getDistribution(distributionId);
    res.json(successResponse(record));
  } catch (err) {
    handleServiceError(res, err);
  }
});

/**
 * GET /api/dividends/:distributionId/claimed-total
 * Running total of amounts claimed so far.
 */
router.get(
  "/:distributionId/claimed-total",
  async (req: Request, res: Response) => {
    const distributionId = parseDistributionId(req, res);
    if (distributionId === null) return;
    try {
      const claimedTotal =
        await dividendService.getDividendClaimedTotal(distributionId);
      res.json(successResponse({ distributionId, claimedTotal }));
    } catch (err) {
      handleServiceError(res, err);
    }
  }
);

/**
 * GET /api/dividends/:distributionId/claimed/:holder
 * Whether `holder` has already claimed this distribution.
 */
router.get(
  "/:distributionId/claimed/:holder",
  async (req: Request, res: Response) => {
    const distributionId = parseDistributionId(req, res);
    if (distributionId === null) return;
    const { holder } = req.params;
    if (!STELLAR_ADDRESS_RE.test(holder)) {
      return res.status(400).json(
        errorResponse({
          code: "INVALID_INPUT",
          message: "Invalid holder address",
        })
      );
    }
    try {
      const claimed = await dividendService.hasClaimedDividend(
        distributionId,
        holder
      );
      res.json(successResponse({ distributionId, holder, claimed }));
    } catch (err) {
      handleServiceError(res, err);
    }
  }
);

// ── Read: paginated reporting (Prisma projection) ───────────────────────────

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

/**
 * GET /api/dividends/:distributionId/claims?limit=25&cursor=...
 * Paginated claim history, most recent first.
 */
router.get("/:distributionId/claims", async (req: Request, res: Response) => {
  const distributionId = parseDistributionId(req, res);
  if (distributionId === null) return;
  const parsedQuery = pageQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json(
      errorResponse({
        code: "INVALID_INPUT",
        message: "Invalid pagination params",
      })
    );
  }
  try {
    const page = await dividendService.listClaimsForDistribution(
      distributionId,
      parsedQuery.data
    );
    res.json(successResponse(page));
  } catch (err) {
    handleServiceError(res, err);
  }
});

/**
 * GET /api/dividends/:distributionId/holders?limit=25&cursor=...
 * Paginated per-holder claim snapshot (best-effort — see the KNOWN GAP note
 * in dividendService.ts: this only covers holders who have claimed).
 */
router.get("/:distributionId/holders", async (req: Request, res: Response) => {
  const distributionId = parseDistributionId(req, res);
  if (distributionId === null) return;
  const parsedQuery = pageQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json(
      errorResponse({
        code: "INVALID_INPUT",
        message: "Invalid pagination params",
      })
    );
  }
  try {
    const page = await dividendService.listHolderSnapshotsForDistribution(
      distributionId,
      parsedQuery.data
    );
    res.json(successResponse(page));
  } catch (err) {
    handleServiceError(res, err);
  }
});

// ── Event ingestion (internal — mirrors POST /api/governance/events/ingest) ─

const ingestSchema = z.object({
  events: z.array(
    z.object({
      topic: z.string(),
      topicValues: z.array(z.unknown()),
      data: z.array(z.unknown()),
      txHash: z.string(),
      ledger: z.number(),
      ledgerCloseTime: z.string(),
    })
  ),
});

/**
 * POST /api/dividends/events/ingest
 * Internal: ingest decoded div_ini1 / div_clm1 / div_rcl1 events into the
 * Prisma projection.
 */
router.post(
  "/events/ingest",
  authenticateAdmin,
  async (req: Request, res: Response) => {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(
        errorResponse({
          code: "INVALID_INPUT",
          message: "Invalid request body",
          details: parsed.error.issues,
        })
      );
    }

    const results = [];
    for (const event of parsed.data.events) {
      try {
        await dividendService.ingestDividendEvent(event);
        results.push({
          success: true,
          topic: event.topic,
          txHash: event.txHash,
        });
      } catch (err) {
        results.push({
          success: false,
          topic: event.topic,
          txHash: event.txHash,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    res.json(successResponse({ processed: results.length, results }));
  }
);

export default router;
