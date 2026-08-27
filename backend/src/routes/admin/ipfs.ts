/**
 * Admin IPFS Pin Monitor routes (#1403).
 *
 * Exposes the durable IPFSPin tracking table to the admin dashboard so
 * operators can see pin health (pinned/failed/warning) for every tracked
 * CID, and manually trigger a re-pin attempt when Pinata drops content.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { authenticateAdmin } from "../../middleware/auth";
import { successResponse, errorResponse } from "../../utils/response";
import { checkPinStatus } from "../../lib/ipfs/pinMonitor";
import { getActivePinataCredentials } from "../../lib/ipfs/pinata.js";
import { pinataQueue } from "../../lib/ipfs/pinataQueue.js";
import { MetricsCollector } from "../../lib/metrics";

const router = Router();

/** Threshold beyond which a pin is considered "failed" (red) rather than just "warning" (yellow). */
const FAILURE_THRESHOLD = 3;

function pinHealthStatus(pinned: boolean, failureCount: number): "pinned" | "warning" | "failed" {
  if (pinned && failureCount === 0) return "pinned";
  if (failureCount > FAILURE_THRESHOLD) return "failed";
  if (failureCount > 1) return "warning";
  return pinned ? "pinned" : "warning";
}

// GET /api/admin/ipfs/pins - List all tracked pins with status/failure count/last checked
router.get("/pins", authenticateAdmin, async (_req, res) => {
  try {
    const pins = await prisma.iPFSPin.findMany({
      orderBy: { updatedAt: "desc" },
    });

    const data = pins.map((pin) => ({
      cid: pin.cid,
      tokenName: pin.tokenName,
      tokenAddress: pin.tokenAddress,
      pinned: pin.pinned,
      failureCount: pin.failureCount,
      lastChecked: pin.lastChecked,
      error: pin.error,
      status: pinHealthStatus(pin.pinned, pin.failureCount),
      createdAt: pin.createdAt,
      updatedAt: pin.updatedAt,
    }));

    res.json(
      successResponse({
        pins: data,
        total: data.length,
      })
    );
  } catch (error) {
    console.error("Error fetching IPFS pins:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch IPFS pin status",
      })
    );
  }
});

const rePinParamsSchema = z.object({
  cid: z.string().min(1, "cid is required"),
});

// POST /api/admin/ipfs/re-pin/:cid - Trigger a re-pin attempt for a given CID
router.post("/re-pin/:cid", authenticateAdmin, async (req, res) => {
  const startedAt = Date.now();
  try {
    const { cid } = rePinParamsSchema.parse(req.params);

    let apiKey: string;
    let apiSecret: string;
    try {
      const creds = getActivePinataCredentials();
      apiKey = creds.apiKey;
      apiSecret = creds.apiSecret;
    } catch (credError) {
      return res.status(503).json(
        errorResponse({
          code: "PINATA_NOT_CONFIGURED",
          message: "Pinata credentials are not configured",
        })
      );
    }

    // Re-pin by re-fetching/re-pinning the content via Pinata's pin-by-hash
    // API, throttled through the shared queue used for all other Pinata calls.
    const rePinResult = await pinataQueue.enqueue(async () => {
      const res = await fetch("https://api.pinata.cloud/pinning/pinByHash", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          pinata_api_key: apiKey,
          pinata_secret_api_key: apiSecret,
        },
        body: JSON.stringify({ hashToPin: cid }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Pinata pinByHash failed: HTTP ${res.status} ${text}`);
      }

      return res.json().catch(() => ({}));
    });

    // Verify the re-pin succeeded
    const status = await checkPinStatus(cid, apiKey, apiSecret);

    const durationSeconds = (Date.now() - startedAt) / 1000;
    MetricsCollector.recordIPFSOperation(
      "re-pin",
      status.pinned ? "success" : "failure",
      durationSeconds
    );

    const existing = await prisma.iPFSPin.findUnique({ where: { cid } });

    const updated = await prisma.iPFSPin.upsert({
      where: { cid },
      create: {
        cid,
        pinned: status.pinned,
        failureCount: status.pinned ? 0 : 1,
        lastChecked: new Date(),
        error: status.error ?? null,
      },
      update: {
        pinned: status.pinned,
        failureCount: status.pinned ? 0 : (existing?.failureCount ?? 0) + 1,
        lastChecked: new Date(),
        error: status.error ?? null,
      },
    });

    res.json(
      successResponse({
        cid: updated.cid,
        pinned: updated.pinned,
        failureCount: updated.failureCount,
        lastChecked: updated.lastChecked,
        error: updated.error,
        status: pinHealthStatus(updated.pinned, updated.failureCount),
        pinataResponse: rePinResult,
        message: status.pinned
          ? "Re-pin successful"
          : "Re-pin attempted but pin could not be verified",
      })
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json(
        errorResponse({
          code: "VALIDATION_ERROR",
          message: "Invalid CID",
          details: error.issues,
        })
      );
    }

    const durationSeconds = (Date.now() - startedAt) / 1000;
    MetricsCollector.recordIPFSOperation("re-pin", "failure", durationSeconds);

    console.error("Error re-pinning CID:", error);

    // Best-effort: record the failed attempt so the dashboard reflects it.
    try {
      const { cid } = req.params;
      const existing = await prisma.iPFSPin.findUnique({ where: { cid } });
      await prisma.iPFSPin.upsert({
        where: { cid },
        create: {
          cid,
          pinned: false,
          failureCount: 1,
          lastChecked: new Date(),
          error: error instanceof Error ? error.message : String(error),
        },
        update: {
          pinned: false,
          failureCount: (existing?.failureCount ?? 0) + 1,
          lastChecked: new Date(),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch (trackingError) {
      console.error("Error recording failed re-pin attempt:", trackingError);
    }

    res.status(500).json(
      errorResponse({
        code: "RE_PIN_FAILED",
        message: "Failed to re-pin CID",
      })
    );
  }
});

export default router;
