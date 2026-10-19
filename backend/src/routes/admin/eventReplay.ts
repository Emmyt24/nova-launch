import { Router, Request, Response, NextFunction } from 'express';
import { EventReplayService } from '../../services/eventReplayService';
import { authenticateAdmin, requireSuperAdmin } from '../../middleware/auth';
import type { AuthRequest } from '../../middleware/auth';
import { Database } from '../../config/database';

const router = Router();
const replayService = new EventReplayService();

/** Largest ledger span a single range replay may cover. */
export const MAX_REPLAY_LEDGER_SPAN = Number(process.env.EVENT_REPLAY_MAX_LEDGER_SPAN) || 100_000;
/** Range replays allowed per admin per window. */
export const REPLAY_RATE_LIMIT_MAX = Number(process.env.EVENT_REPLAY_RATE_LIMIT_MAX) || 5;
/** Rate-limit window length in milliseconds. */
export const REPLAY_RATE_LIMIT_WINDOW_MS =
  Number(process.env.EVENT_REPLAY_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;

/**
 * Fixed-window, per-admin rate limiter for range replays. Kept in-process
 * because replays are rare, operator-driven, and must not depend on Redis
 * being healthy during incident recovery.
 */
export function createReplayRateLimiter(
  max: number = REPLAY_RATE_LIMIT_MAX,
  windowMs: number = REPLAY_RATE_LIMIT_WINDOW_MS,
  now: () => number = Date.now,
) {
  const windows = new Map<string, { count: number; resetAt: number }>();

  const middleware = (req: AuthRequest, res: Response, next: NextFunction) => {
    const key = req.admin?.id ?? req.ip ?? 'unknown';
    const t = now();
    let entry = windows.get(key);
    if (!entry || t >= entry.resetAt) {
      entry = { count: 0, resetAt: t + windowMs };
      windows.set(key, entry);
    }

    entry.count++;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - t) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many replay requests, please try again later.',
        retryAfterSeconds: retryAfter,
      });
    }
    next();
  };

  return Object.assign(middleware, { reset: () => windows.clear() });
}

export const replayRateLimiter = createReplayRateLimiter();

/** Only one range replay may run at a time per process. */
let rangeReplayInProgress = false;

/** Test-only: reset in-process state between tests. */
export function __resetReplayStateForTests(): void {
  rangeReplayInProgress = false;
  replayRateLimiter.reset();
}

function parseLedger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : NaN;
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function recordReplayAudit(
  req: AuthRequest,
  params: Record<string, unknown>,
  outcome: Record<string, unknown>,
): void {
  if (!req.admin) return;
  Database.createAuditLog({
    adminId: req.admin.id,
    action: 'EVENT_REPLAY_RANGE',
    resource: 'event-replay',
    resourceId: `${params.startLedger}-${params.endLedger}`,
    beforeState: params,
    afterState: outcome,
    ipAddress: req.ip || req.socket?.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent'] || 'unknown',
  }).catch((err) => console.error('[EventReplay] Audit log error:', err));
}

/**
 * POST /admin/event-replay/range
 *
 * Reprocess events within an explicit ledger range, e.g. after fixing a
 * parser bug that caused events to fail. Accepts JSON body or query params.
 *
 *   - startLedger (required): first ledger to replay, inclusive
 *   - endLedger   (required): last ledger to replay, inclusive
 *   - dryRun: validate without persisting (default: true — opt in to writes)
 *   - batchSize: events per Horizon request (1-200, default 100)
 *   - maxRetries: network retry attempts (0-10, default 5)
 *
 * Rate limited per admin, single-flight, and every attempt is audit logged.
 */
router.post(
  '/event-replay/range',
  authenticateAdmin,
  requireSuperAdmin,
  replayRateLimiter,
  async (req: AuthRequest, res: Response) => {
    const input = { ...(req.query as Record<string, unknown>), ...((req.body as Record<string, unknown>) ?? {}) };

    const startLedger = parseLedger(input.startLedger);
    const endLedger = parseLedger(input.endLedger);
    const batchSize = input.batchSize === undefined ? 100 : Number(input.batchSize);
    const maxRetries = input.maxRetries === undefined ? 5 : Number(input.maxRetries);
    const dryRun = parseBool(input.dryRun, true);

    if (startLedger === null || endLedger === null) {
      return res.status(400).json({ error: 'startLedger and endLedger are required' });
    }
    if (Number.isNaN(startLedger) || Number.isNaN(endLedger)) {
      return res.status(400).json({ error: 'startLedger and endLedger must be positive integers' });
    }
    if (endLedger < startLedger) {
      return res.status(400).json({ error: 'endLedger must be greater than or equal to startLedger' });
    }
    if (endLedger - startLedger + 1 > MAX_REPLAY_LEDGER_SPAN) {
      return res.status(400).json({
        error: `Ledger range must not exceed ${MAX_REPLAY_LEDGER_SPAN} ledgers`,
      });
    }
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
      return res.status(400).json({ error: 'batchSize must be between 1 and 200' });
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      return res.status(400).json({ error: 'maxRetries must be between 0 and 10' });
    }

    if (rangeReplayInProgress) {
      return res.status(409).json({ error: 'A range replay is already in progress' });
    }

    const params = { startLedger, endLedger, dryRun, batchSize, maxRetries };
    rangeReplayInProgress = true;
    console.warn(
      `[EventReplay] Range replay ${startLedger}-${endLedger} (dryRun=${dryRun}) initiated by ${req.admin?.id}`,
    );

    try {
      const result = await replayService.replay(params);
      recordReplayAudit(req, params, {
        status: 'completed',
        eventsProcessed: result.eventsProcessed,
        eventsSkipped: result.eventsSkipped,
        errorCount: result.errors.length,
        finalCursor: result.finalCursor,
        duration: result.duration,
      });
      res.json({ ...result, dryRun });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[EventReplay] Range replay error:', error);
      recordReplayAudit(req, params, { status: 'failed', error });
      res.status(500).json({ error });
    } finally {
      rangeReplayInProgress = false;
    }
  },
);

/**
 * POST /admin/event-replay
 *
 * Replay contract events from Stellar to rebuild projections.
 *
 * Query parameters:
 *   - startLedger: Starting ledger number (optional, uses stored cursor if not provided)
 *   - endLedger: Ending ledger number (optional, no limit if not provided)
 *   - batchSize: Events per Horizon request (default: 100, max: 200)
 *   - dryRun: Validate without persisting (default: false)
 *   - maxRetries: Network retry attempts (default: 5)
 *
 * Response:
 *   {
 *     eventsProcessed: number,
 *     eventsSkipped: number,
 *     startLedger: number,
 *     endLedger: number,
 *     finalCursor: string | null,
 *     errors: Array<{ ledger: number; error: string }>,
 *     duration: number
 *   }
 */
router.post('/event-replay', authenticateAdmin, requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const {
      startLedger,
      endLedger,
      batchSize = 100,
      dryRun = false,
      maxRetries = 5,
    } = req.query;

    // Validate parameters
    if (batchSize) {
      const parsed = Number(batchSize);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 200) {
        return sendError(res, 400, ErrorCode.INVALID_PARAMETERS, 'batchSize must be between 1 and 200', { parameter: 'batchSize' });
      }
    }

    const result = await replayService.replay({
      startLedger: startLedger ? Number(startLedger) : undefined,
      endLedger: endLedger ? Number(endLedger) : undefined,
      batchSize: Number(batchSize),
      dryRun: dryRun === 'true',
      maxRetries: Number(maxRetries),
    });

    res.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[EventReplay] Route error:', error);
    sendError(res, 500, ErrorCode.INTERNAL_SERVER_ERROR, 'Event replay failed', { reason: error });
  }
});

/**
 * POST /admin/event-replay/clear-and-rebuild
 *
 * DESTRUCTIVE: Clear all projections and rebuild from scratch.
 * Requires explicit confirmation via query parameter.
 *
 * Query parameters:
 *   - confirm: Must be "yes" to proceed
 *   - startLedger: Starting ledger (optional, uses STELLAR_CURSOR_ORIGIN if not provided)
 *
 * Response: Same as /event-replay
 */
router.post('/event-replay/clear-and-rebuild', authenticateAdmin, requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { confirm, startLedger } = req.query;

    if (confirm !== 'yes') {
      return sendError(res, 400, ErrorCode.BAD_REQUEST, 'Confirmation required. Pass ?confirm=yes to proceed.', {
        warning: 'This operation will delete all projections and rebuild from scratch.',
      });
    }

    console.warn('[EventReplay] Clear and rebuild initiated by admin');

    const result = await replayService.clearAndRebuild({
      startLedger: startLedger ? Number(startLedger) : undefined,
    });

    res.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[EventReplay] Clear and rebuild error:', error);
    sendError(res, 500, ErrorCode.INTERNAL_SERVER_ERROR, 'Clear and rebuild failed', { reason: error });
  }
});

export default router;
