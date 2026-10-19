/**
 * GET /api/admin/network/validate
 *
 * Runtime validation of all external network dependencies.
 * Returns a structured reachability report for Horizon, Soroban RPC, and the
 * IPFS gateway so operators can detect misconfiguration before transactions fail.
 *
 * The endpoint is admin-only; it is safe to call repeatedly without side effects.
 */
import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/auth';
import { successResponse, errorResponse } from '../../utils/response';
import { runNetworkValidation } from '../../config/startupValidation';
import { validateEnv } from '../../config/env';
import { getEndpointHealthReport } from '../../services/rpcFailover';

const router = Router();

/**
 * GET /
 * Probe Horizon, Soroban RPC, and the IPFS gateway and return a structured report.
 *
 * Response body (success):
 *   {
 *     horizon: { reachable: boolean; latencyMs: number | null; passphraseMatches: boolean }
 *     rpc:     { reachable: boolean }
 *     ipfs:    { reachable: boolean }
 *     endpoints: {
 *       horizon: { active: string | null; endpoints: Array<{ url: string; healthy: boolean; latencyMs: number | null; lastCheckedAt: string | null; lastError: string | null }> }
 *       rpc:     { active: string | null; endpoints: Array<{ url: string; healthy: boolean; latencyMs: number | null; lastCheckedAt: string | null; lastError: string | null }> }
 *     }
 *   }
 */
router.get('/', authenticateAdmin, async (_req, res) => {
  try {
    const env = validateEnv();
    const report = await runNetworkValidation(env);
    const endpoints = getEndpointHealthReport();
    res.json(successResponse({ ...report, endpoints }));
  } catch (error) {
    console.error('Network validation error:', error);
    res.status(500).json(
      errorResponse({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Network validation failed',
      }),
    );
  }
});

export default router;