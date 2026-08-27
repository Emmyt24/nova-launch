import axios, { AxiosError } from 'axios';
import { PrismaClient } from '@prisma/client';
import { validateEnv } from '../config/env';
import { GovernanceEventParser } from './governanceEventParser';
import { TokenEventParser } from './tokenEventParser';
import { StreamEventParser } from './streamEventParser';
import {
  parseVaultCreatedEvent,
  parseVaultClaimedEvent,
  parseVaultCancelledEvent,
  parseVaultMetadataUpdatedEvent,
} from './vaultEventParser';
import { EventCursorStore } from './eventCursorStore';
import { isRetryableError, sleep } from '../stellar-service-integration/rate-limiter';
import { findNearestUsableSnapshotLedger, restoreAllProjectionSnapshots } from './projectionSnapshot';

const _env = validateEnv();
const HORIZON_URL = _env.STELLAR_HORIZON_URL;
const FACTORY_CONTRACT_ID = _env.FACTORY_CONTRACT_ID;

interface StellarEvent {
  type: string;
  ledger: number;
  ledger_close_time: string;
  contract_id: string;
  id: string;
  paging_token: string;
  topic: string[];
  value: any;
  in_successful_contract_call: boolean;
  transaction_hash: string;
}

interface ReplayOptions {
  startLedger?: number;
  endLedger?: number;
  batchSize?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  dryRun?: boolean;
}

interface ReplayResult {
  eventsProcessed: number;
  eventsSkipped: number;
  startLedger: number;
  endLedger: number;
  finalCursor: string | null;
  errors: Array<{ ledger: number; error: string }>;
  duration: number;
}

/**
 * EventReplayService provides disaster recovery by replaying historical contract events
 * from Stellar Horizon to rebuild read models (projections) after data loss.
 *
 * Key features:
 * - Configurable ledger range for targeted recovery
 * - Automatic retry with exponential backoff for network failures
 * - Idempotent event processing (safe to re-run)
 * - Dry-run mode for validation without persistence
 * - Deterministic projection rebuilding
 */
export class EventReplayService {
  private prisma: PrismaClient;
  private governanceParser: GovernanceEventParser;
  private tokenEventParser: TokenEventParser;
  private streamEventParser: StreamEventParser;
  private cursorStore: EventCursorStore;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
    this.governanceParser = new GovernanceEventParser(this.prisma);
    this.tokenEventParser = new TokenEventParser(this.prisma);
    this.streamEventParser = new StreamEventParser(this.prisma);
    this.cursorStore = new EventCursorStore(this.prisma);
  }

  /**
   * Replay events from a configurable starting ledger to rebuild projections.
   * Idempotent: safe to call multiple times.
   */
  async replay(options: ReplayOptions = {}): Promise<ReplayResult> {
    const {
      startLedger,
      endLedger,
      batchSize = 100,
      maxRetries = 5,
      retryDelayMs = 1000,
      dryRun = false,
    } = options;

    if (!FACTORY_CONTRACT_ID) {
      throw new Error('FACTORY_CONTRACT_ID not configured');
    }

    const startTime = Date.now();
    let eventsProcessed = 0;
    let eventsSkipped = 0;
    const errors: Array<{ ledger: number; error: string }> = [];
    let cursor: string | null = null;
    let currentLedger = startLedger || 0;
    let finalCursor: string | null = null;

    try {
      // Determine starting cursor
      if (startLedger) {
        cursor = `${startLedger - 1}-0`;
      } else {
        cursor = await this.cursorStore.load();
      }

      console.log(
        `[EventReplay] Starting replay from ledger ${startLedger || 'stored cursor'}, batch size: ${batchSize}`,
      );

      let hasMore = true;
      while (hasMore) {
        try {
          const events = await this.fetchEventsWithRetry(
            cursor,
            batchSize,
            maxRetries,
            retryDelayMs,
          );

          if (!events.length) {
            hasMore = false;
            break;
          }

          // Process events in order
          for (const event of events) {
            try {
              // Skip if outside range
              if (endLedger && event.ledger > endLedger) {
                hasMore = false;
                break;
              }

              currentLedger = event.ledger;

              // Route to appropriate parser
              await this.processEvent(event, dryRun);
              eventsProcessed++;

              // Update cursor for recovery
              finalCursor = event.paging_token;
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              errors.push({ ledger: event.ledger, error: errorMsg });
              eventsSkipped++;
              console.warn(
                `[EventReplay] Error processing event at ledger ${event.ledger}: ${errorMsg}`,
              );
            }
          }

          // Update cursor for next batch
          if (events.length > 0) {
            cursor = events[events.length - 1].paging_token;
          }

          // Stop if we got fewer events than requested (end of stream)
          if (events.length < batchSize) {
            hasMore = false;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`[EventReplay] Batch fetch failed: ${errorMsg}`);
          errors.push({ ledger: currentLedger, error: `Batch fetch: ${errorMsg}` });
          hasMore = false;
        }
      }

      // Persist cursor if not dry-run
      if (!dryRun && finalCursor) {
        await this.cursorStore.save(finalCursor);
        console.log(`[EventReplay] Cursor persisted: ${finalCursor}`);
      }

      const duration = Date.now() - startTime;
      const result: ReplayResult = {
        eventsProcessed,
        eventsSkipped,
        startLedger: startLedger || 0,
        endLedger: endLedger || currentLedger,
        finalCursor,
        errors,
        duration,
      };

      console.log(
        `[EventReplay] Completed: ${eventsProcessed} processed, ${eventsSkipped} skipped in ${duration}ms`,
      );

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Event replay failed: ${errorMsg}`);
    }
  }

  /**
   * Replays up to `targetLedger`, resuming from the nearest usable
   * cross-projection snapshot (see `projectionSnapshot.ts`) instead of
   * always replaying from ledger zero. Falls back to a full replay from
   * origin if no complete snapshot set exists at or before `targetLedger`.
   */
  async replayFromLedger(
    targetLedger: number,
    options: Omit<ReplayOptions, 'startLedger' | 'endLedger'> = {},
  ): Promise<ReplayResult> {
    const snapshotLedger = await findNearestUsableSnapshotLedger(this.prisma, targetLedger);

    if (snapshotLedger !== null) {
      console.log(
        `[EventReplay] Resuming from snapshot at ledger ${snapshotLedger} (target: ${targetLedger})`,
      );
      await restoreAllProjectionSnapshots(this.prisma, snapshotLedger);
      return this.replay({ ...options, startLedger: snapshotLedger + 1, endLedger: targetLedger });
    }

    console.log(
      `[EventReplay] No usable snapshot at or before ledger ${targetLedger} — replaying from origin`,
    );
    return this.replay({ ...options, endLedger: targetLedger });
  }

  /**
   * Fetch events from Horizon with automatic retry and exponential backoff.
   */
  private async fetchEventsWithRetry(
    cursor: string | null,
    limit: number,
    maxRetries: number,
    retryDelayMs: number,
  ): Promise<StellarEvent[]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const params: any = {
          limit,
          order: 'asc',
          type: 'contract',
        };

        if (cursor) {
          params.cursor = cursor;
        }

        const response = await axios.get(`${HORIZON_URL}/events`, {
          params,
          timeout: 30000,
        });

        const events = response.data._embedded?.records || [];
        return events.filter((e: StellarEvent) => e.contract_id === FACTORY_CONTRACT_ID);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (!isRetryableError(err as AxiosError)) {
          throw lastError;
        }

        if (attempt < maxRetries) {
          const delay = retryDelayMs * Math.pow(2, attempt);
          console.warn(
            `[EventReplay] Fetch failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`,
          );
          await sleep(delay);
        }
      }
    }

    throw lastError || new Error('Failed to fetch events after retries');
  }

  /**
   * Process a single event by routing to the appropriate parser.
   * Idempotent: duplicate events are safely ignored.
   */
  private async processEvent(event: StellarEvent, dryRun: boolean): Promise<void> {
    if (dryRun) {
      // Validation only, no persistence
      this.validateEvent(event);
      return;
    }

    const topic = event.topic[0];

    // Token events
    if (topic === 'tok_reg' || topic === 'tok_burn' || topic === 'adm_burn') {
      await this.tokenEventParser.parseEvent(event as any);
      return;
    }

    // Governance events
    if (
      topic.includes('prop_create') ||
      topic.includes('vote') ||
      topic.includes('prop_exec') ||
      topic.includes('prop_snap')
    ) {
      await this.governanceParser.parseEvent(event as any);
      return;
    }

    // Stream events
    if (topic === 'stream_create' || topic === 'stream_claim' || topic === 'stream_cancel') {
      await this.streamEventParser.parseEvent(event as any);
      return;
    }

    // Vault events
    if (topic === 'vault_created') {
      await parseVaultCreatedEvent(this.prisma, event as any);
      return;
    }
    if (topic === 'vault_claimed') {
      await parseVaultClaimedEvent(this.prisma, event as any);
      return;
    }
    if (topic === 'vault_cancelled') {
      await parseVaultCancelledEvent(this.prisma, event as any);
      return;
    }
    if (topic === 'vault_metadata_updated') {
      await parseVaultMetadataUpdatedEvent(this.prisma, event as any);
      return;
    }

    // Unknown event type - log but don't fail
    console.debug(`[EventReplay] Skipping unknown event type: ${topic}`);
  }

  /**
   * Validate event structure without processing.
   */
  private validateEvent(event: StellarEvent): void {
    if (!event.ledger || !event.paging_token || !event.topic?.length) {
      throw new Error('Invalid event structure: missing required fields');
    }

    if (!event.contract_id || event.contract_id !== FACTORY_CONTRACT_ID) {
      throw new Error('Event contract_id mismatch');
    }
  }

  /**
   * Clear all projections and rebuild from scratch.
   * WARNING: Destructive operation. Use with caution.
   */
  async clearAndRebuild(options: ReplayOptions = {}): Promise<ReplayResult> {
    console.warn('[EventReplay] Clearing all projections...');

    // Clear all projection tables
    await this.prisma.$transaction([
      this.prisma.token.deleteMany(),
      this.prisma.burnRecord.deleteMany(),
      this.prisma.proposal.deleteMany(),
      this.prisma.vote.deleteMany(),
      this.prisma.stream.deleteMany(),
      this.prisma.campaign.deleteMany(),
      this.prisma.campaignExecution.deleteMany(),
      this.prisma.campaignAuditTrail.deleteMany(),
    ]);

    console.log('[EventReplay] Projections cleared. Starting replay...');

    // Reset cursor to origin
    const originCursor = process.env.STELLAR_CURSOR_ORIGIN || null;
    if (originCursor) {
      await this.cursorStore.save(originCursor);
    }

    // Replay from origin
    return this.replay({ ...options, startLedger: undefined });
  }
}

export default new EventReplayService();
