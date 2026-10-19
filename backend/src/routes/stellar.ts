import { Router, Request, Response } from "express";
import axios from "axios";
import { successResponse, errorResponse } from "../utils/response";
import { getExplorerUrl, getTxUrl } from "../config/explorer";
import { env } from "../config/env";

const router = Router();

// Cache fee stats briefly to avoid hammering Horizon on every dashboard
// refresh / poll. Horizon's own fee_stats endpoint is computed over the
// last 5 ledgers, so a short cache window does not meaningfully reduce
// freshness while still protecting Horizon from bursty traffic.
let feeStatsCache: {
  data: FeeStatsResponse;
  timestamp: number;
} | null = null;

const CACHE_DURATION_MS = 5 * 1000; // 5 seconds

interface HorizonFeeBucket {
  max: string;
  min: string;
  mode: string;
  p10: string;
  p20: string;
  p30: string;
  p40: string;
  p50: string;
  p60: string;
  p70: string;
  p80: string;
  p90: string;
  p95: string;
  p99: string;
}

interface HorizonFeeStatsRaw {
  last_ledger: string;
  last_ledger_base_fee: string;
  ledger_capacity_usage: string;
  fee_charged: HorizonFeeBucket;
  max_fee: HorizonFeeBucket;
}

export interface FeeStatsResponse {
  lastLedger: number;
  lastLedgerBaseFee: number;
  ledgerCapacityUsage: number;
  feeCharged: {
    min: number;
    max: number;
    mode: number;
    p10: number;
    p20: number;
    p30: number;
    p40: number;
    p50: number;
    p60: number;
    p70: number;
    p80: number;
    p90: number;
    p95: number;
    p99: number;
  };
  fetchedAt: string;
}

function mapFeeBucket(bucket: HorizonFeeBucket) {
  return {
    min: Number(bucket.min),
    max: Number(bucket.max),
    mode: Number(bucket.mode),
    p10: Number(bucket.p10),
    p20: Number(bucket.p20),
    p30: Number(bucket.p30),
    p40: Number(bucket.p40),
    p50: Number(bucket.p50),
    p60: Number(bucket.p60),
    p70: Number(bucket.p70),
    p80: Number(bucket.p80),
    p90: Number(bucket.p90),
    p95: Number(bucket.p95),
    p99: Number(bucket.p99),
  };
}

function getHorizonUrl(): string {
  return env.STELLAR_HORIZON_URL;
}

/**
 * GET /api/stellar/fee-stats
 *
 * Proxies Horizon's `/fee_stats` endpoint and normalizes the response into
 * a friendlier shape (numbers instead of stringified integers, camelCase
 * keys). Horizon's fee_stats reflects only the most recent few ledgers —
 * it is a real-time snapshot, NOT a historical time series. Callers that
 * want a trend over time (e.g. the gas dashboard's 24h chart) must sample
 * this endpoint repeatedly and accumulate snapshots client-side.
 */
router.get("/fee-stats", async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (feeStatsCache && now - feeStatsCache.timestamp < CACHE_DURATION_MS) {
      return res.json(successResponse(feeStatsCache.data));
    }

    const horizonUrl = getHorizonUrl();
    const response = await axios.get<HorizonFeeStatsRaw>(
      `${horizonUrl}/fee_stats`,
      { timeout: 10000 }
    );

    const raw = response.data;

    const feeStats: FeeStatsResponse = {
      lastLedger: Number(raw.last_ledger),
      lastLedgerBaseFee: Number(raw.last_ledger_base_fee),
      ledgerCapacityUsage: Number(raw.ledger_capacity_usage),
      feeCharged: mapFeeBucket(raw.fee_charged),
      fetchedAt: new Date().toISOString(),
    };

    feeStatsCache = { data: feeStats, timestamp: now };

    res.json(
      successResponse({
        ...feeStats,
        explorerUrl: getExplorerUrl(env.STELLAR_NETWORK, env.STELLAR_EXPLORER_PROVIDER),
        txExplorerUrl: getTxUrl(
          env.STELLAR_NETWORK,
          env.STELLAR_EXPLORER_PROVIDER,
          String(feeStats.lastLedger)
        ),
      })
    );
  } catch (error) {
    console.error("Error fetching Horizon fee stats:", error);
    res.status(502).json(
      errorResponse({
        code: "HORIZON_FEE_STATS_ERROR",
        message: "Failed to fetch fee stats from Horizon",
      })
    );
  }
});

export default router;
