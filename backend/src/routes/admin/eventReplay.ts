import { Router, Request, Response } from 'express';
import { EventReplayService } from '../../services/eventReplayService';
import { authenticateAdmin, requireSuperAdmin } from '../../middleware/auth';

const router = Router();
const replayService = new EventReplayService();

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
    if (batchSize && (Number(batchSize) < 1 || Number(batchSize) > 200)) {
      return res.status(400).json({ error: 'batchSize must be between 1 and 200' });
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
    res.status(500).json({ error });
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
      return res.status(400).json({
        error: 'Confirmation required. Pass ?confirm=yes to proceed.',
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
    res.status(500).json({ error });
  }
});

export default router;
