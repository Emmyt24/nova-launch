/**
 * GET /api/admin/operational
 * Aggregated operational state for the admin dashboard.
 * Returns token counts and event listener cursor status.
 * All fields are read-only — no mutations here.
 */
import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticateAdmin } from '../../middleware/auth';
import { successResponse, errorResponse } from '../../utils/response';
import {
  getIPFSCircuitBreakerMetrics,
  resetIPFSCircuitBreaker,
  rotatePinataCredentials,
} from '../../lib/ipfs/pinata.js';

const router = Router();

router.get('/', authenticateAdmin, async (_req, res) => {
  try {
    const [totalTokens, cursorState] = await Promise.all([
      prisma.token.count(),
      prisma.integrationState.findUnique({ where: { key: 'event_cursor' } }),
    ]);

    res.json(
      successResponse({
        tokens: { total: totalTokens },
        eventListener: {
          cursor: cursorState?.value ?? null,
          updatedAt: cursorState?.updatedAt ?? null,
        },
        fetchedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    console.error('Error fetching operational state:', error);
    res.status(500).json(
      errorResponse({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch operational state',
      }),
    );
  }
});

/**
 * GET /api/admin/operational/circuit-breaker/ipfs
 * Get IPFS circuit breaker metrics for monitoring.
 */
router.get('/circuit-breaker/ipfs', authenticateAdmin, (_req, res) => {
  try {
    const metrics = getIPFSCircuitBreakerMetrics();
    res.json(
      successResponse({
        service: 'ipfs',
        metrics,
        fetchedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    console.error('Error fetching circuit breaker metrics:', error);
    res.status(500).json(
      errorResponse({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch circuit breaker metrics',
      }),
    );
  }
});

/**
 * POST /api/admin/operational/circuit-breaker/ipfs/reset
 * Reset IPFS circuit breaker (admin use only).
 */
router.post('/circuit-breaker/ipfs/reset', authenticateAdmin, (_req, res) => {
  try {
    resetIPFSCircuitBreaker();
    res.json(
      successResponse({
        service: 'ipfs',
        message: 'Circuit breaker reset successfully',
      }),
    );
  } catch (error) {
    console.error('Error resetting circuit breaker:', error);
    res.status(500).json(
      errorResponse({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to reset circuit breaker',
      }),
    );
  }
});

/**
 * POST /api/admin/operational/pinata/credentials
 * Validate and rotate Pinata API credentials without downtime.
 * The new credential pair is checked before it becomes active.
 */
router.post('/pinata/credentials', authenticateAdmin, async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body;

    if (!apiKey || !apiSecret) {
      return res.status(400).json(
        errorResponse({
          code: 'INVALID_REQUEST',
          message: 'apiKey and apiSecret are required',
        }),
      );
    }

    await rotatePinataCredentials(apiKey, apiSecret);

    res.json(
      successResponse({
        message: 'Pinata credentials validated and rotated successfully',
      }),
    );
  } catch (error) {
    console.error('Error rotating Pinata credentials:', error);
    res.status(500).json(
      errorResponse({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to rotate Pinata credentials',
      }),
    );
  }
});

export default router;
