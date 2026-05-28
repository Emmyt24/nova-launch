import axios from "axios";
import { validateEnv } from "../config/env";
import { WebhookEventType } from "../types/webhook";
import webhookDeliveryService from "./webhookDeliveryService";
import { PrismaClient } from "@prisma/client";
import { GovernanceEventParser } from "./governanceEventParser";
import governanceEventMapper from "./governanceEventMapper";
import { TokenEventParser, RawTokenEvent } from "./tokenEventParser";
import { EventCursorStore } from "./eventCursorStore";
import { StreamEventParser } from "./streamEventParser";
import { parseVaultCreatedEvent, parseVaultClaimedEvent, parseVaultCancelledEvent, parseVaultMetadataUpdatedEvent } from "./vaultEventParser";
import { decodeEvent, kindForTopic } from "./eventVersioning/decoderRegistry";
import {
  isRetryableError,
  sleep
} from "../stellar-service-integration/rate-limiter";
import { ListenerBackoffState, LISTENER_RECONNECT_CONFIG } from "./listenerBackoff";
import { IntegrationMetrics } from "../monitoring/metrics/prometheus-config";
import {
  PROJECTION_LAG_THRESHOLDS,
  determineThresholdStatus,
  generateThresholdAlert,
  LagWindow,
  ProjectionLagMetrics,
  ThresholdAlert,
} from "../monitoring/metrics/projectionLagThresholds";

const _env = validateEnv();
const HORIZON_URL = _env.STELLAR_HORIZON_URL;
const FACTORY_CONTRACT_ID = _env.FACTORY_CONTRACT_ID;

const POLL_INTERVAL_MS = 5000;

const LAG_WINDOW_SIZE_MS = 60000;
const globalLagWindow = new LagWindow(LAG_WINDOW_SIZE_MS);
const eventKindLagWindows = new Map<string, LagWindow>();

export interface HorizonTransport {
  getEvents(url: string, params: any): Promise<{ data: { _embedded?: { records: StellarEvent[] } } }>;
}

export class DefaultHorizonTransport implements HorizonTransport {
  async getEvents(url: string, params: any): Promise<any> {
    return axios.get(url, { params, timeout: 30000 });
  }
}

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

export class StellarEventListener {
  private isRunning = false;
  private lastCursor: string | null = null;
  private prisma: PrismaClient;
  private governanceParser: GovernanceEventParser;
  private tokenEventParser: TokenEventParser;
  private cursorStore: EventCursorStore;
  private streamEventParser: StreamEventParser;
  private recentLagMetrics: ProjectionLagMetrics[] = [];
  private lastAlertTime: Map<string, number> = new Map();
  private alertDebounceMs = 5000;
  private transport: HorizonTransport;

  constructor(transport?: HorizonTransport) {
    this.prisma = new PrismaClient();
    this.governanceParser = new GovernanceEventParser(this.prisma);
    this.tokenEventParser = new TokenEventParser(this.prisma);
    this.cursorStore = new EventCursorStore(this.prisma);
    this.streamEventParser = new StreamEventParser(this.prisma);
    this.transport = transport || new DefaultHorizonTransport();
  }

  setTransport(transport: HorizonTransport): void {
    this.transport = transport;
  }

  /**
   * Start listening for Stellar events
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("Event listener is already running");
      return;
    }

    if (!FACTORY_CONTRACT_ID) {
      throw new Error(
        'FACTORY_CONTRACT_ID is empty — StellarEventListener cannot start. ' +
        'Set FACTORY_CONTRACT_ID to the deployed contract address for STELLAR_NETWORK="' +
        _env.STELLAR_NETWORK + '".',
      );
    }
    if (!/^C[A-Z2-7]{55}$/.test(FACTORY_CONTRACT_ID)) {
      throw new Error(
        `FACTORY_CONTRACT_ID is malformed: "${FACTORY_CONTRACT_ID}". ` +
        'Expected a 56-character Soroban contract ID starting with "C". ' +
        'Verify the address matches STELLAR_NETWORK="' + _env.STELLAR_NETWORK + '".',
      );
    }

    // Load durable cursor before starting — resumes from last processed event
    this.lastCursor = await this.cursorStore.load();
    console.log(`Resuming from cursor: ${this.lastCursor ?? "origin"}`);

    this.isRunning = true;
    console.log("Starting Stellar event listener...");

    // Start polling loop
    this.pollEvents();
  }

  /**
   * Stop listening for events
   */
  stop(): void {
    this.isRunning = false;
    console.log("Stopping Stellar event listener...");
  }

  /**
   * Poll for new events with bounded exponential backoff and jitter on failure.
   *
   * Backoff resets after LISTENER_RECONNECT_CONFIG.healthResetThreshold consecutive
   * successful polls to avoid permanently elevated delays after transient outages.
   */
  private async pollEvents(): Promise<void> {
    const backoff = new ListenerBackoffState(LISTENER_RECONNECT_CONFIG);

    while (this.isRunning) {
      try {
        await this.fetchAndProcessEvents();
        backoff.recordSuccess();
        await this.delay(POLL_INTERVAL_MS);
      } catch (error) {
        const isTransient = isRetryableError(error);

        console.warn(
          `[StellarEventListener] poll error (transient=${isTransient}):`,
          error instanceof Error ? error.message : String(error),
        );

        if (isTransient) {
          const { delayMs, attempt } = backoff.recordFailure();

          if (attempt > 5) {
            console.error(
              `[StellarEventListener] ${attempt} consecutive failures — continuing with extended backoff`,
            );
          }

          IntegrationMetrics.recordEventProcessed('reconnect', 'error');
          await sleep(delayMs);
        } else {
          // Non-transient error: log and resume normal cadence without backoff
          console.error("[StellarEventListener] non-retryable error (will continue):", error);
          backoff.recordSuccess();
          await this.delay(POLL_INTERVAL_MS);
        }
      }
    }
  }

  /**
   * Fetch and process new events from Horizon
   */
  private async fetchAndProcessEvents(): Promise<void> {
    const url = `${HORIZON_URL}/contracts/${FACTORY_CONTRACT_ID}/events`;
    const params: any = {
      limit: 100,
      order: "asc",
    };

    if (this.lastCursor) {
      params.cursor = this.lastCursor;
    }

    try {
      const response = await this.transport.getEvents(url, params);
      const events: StellarEvent[] = response.data._embedded?.records || [];

      if (events.length === 0) {
        return;
      }

      console.log(`Processing ${events.length} new events`);

      for (const event of events) {
        await this.processEvent(event);
        this.lastCursor = event.paging_token;
        await this.cursorStore.save(this.lastCursor);
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 429) {
          console.warn("Rate limited by Horizon API (429)");
          throw error;
        } else if (status && status >= 500) {
          console.warn(`Horizon API server error (${status})`);
          throw error;
        } else if (status && status >= 400 && status < 500) {
          console.error(`Horizon API client error (${status}):`, error.message);
          throw error;
        }
      }
      
      console.error("Error fetching events:", error);
      throw error;
    }
  }

  /**
   * Process a single event — all routing goes through the decoder registry.
   */
  private async processEvent(event: StellarEvent): Promise<void> {
    try {
      // Calculate projection lag early - before any processing
      const lagMetrics = this.calculateProjectionLag(event);
      
      // Record lag metrics
      this.recordLagMetrics(lagMetrics);

      const normalized = decodeEvent(event);

      if (normalized.kind === 'unknown') {
        // Already logged by decodeEvent; nothing more to do.
        return;
      }

      const kind = normalized.kind;

      // ── Governance ──────────────────────────────────────────────────────
      if (kind.startsWith('proposal_') || kind === 'vote_cast') {
        // Still delegate to the existing mapper+parser for full Prisma projection
        const governanceEvent = governanceEventMapper.mapEvent(event);
        if (governanceEvent) {
          await this.governanceParser.parseEvent(governanceEvent);
        }
        IntegrationMetrics.recordIngestionLag(kind, event.ledger_close_time);
        IntegrationMetrics.recordEventProcessed(kind, 'success');
        return;
      }

      // ── Vault / Stream ──────────────────────────────────────────────────
      if (kind.startsWith('vault_')) {
        await this.processStreamOrVaultEvent(event);
        IntegrationMetrics.recordIngestionLag(kind, event.ledger_close_time);
        IntegrationMetrics.recordEventProcessed(kind, 'success');
        return;
      }

      // ── Campaign ────────────────────────────────────────────────────────
      if (kind.startsWith('campaign_')) {
        await this.processBuybackEvent(event);
        IntegrationMetrics.recordIngestionLag(kind, event.ledger_close_time);
        IntegrationMetrics.recordEventProcessed(kind, 'success');
        return;
      }

      // ── Token ───────────────────────────────────────────────────────────
      const rawTokenEvent = this.toRawTokenEvent(event);
      if (rawTokenEvent) {
        await this.tokenEventParser.parseEvent(rawTokenEvent);
      }

      // Webhook dispatch for token events
      const webhookType = this.kindToWebhookType(kind);
      if (webhookType) {
        const eventData = this.extractEventData(event, webhookType);
        if (eventData) {
          await webhookDeliveryService.triggerEvent(webhookType, eventData, eventData.tokenAddress);
        }
      }

      IntegrationMetrics.recordIngestionLag(kind, event.ledger_close_time);
      IntegrationMetrics.recordEventProcessed(kind, 'success');
    } catch (error) {
      console.error("Error processing event:", error);
      const kind = kindForTopic(event.topic?.[0] ?? '') ?? 'unknown';
      IntegrationMetrics.recordEventProcessed(kind, 'error');
    }
  }

  /** Map a normalized kind to a WebhookEventType, if applicable. */
  private kindToWebhookType(kind: string): WebhookEventType | null {
    switch (kind) {
      case 'token_burned':       return WebhookEventType.TOKEN_BURN_SELF;
      case 'token_admin_burned': return WebhookEventType.TOKEN_BURN_ADMIN;
      case 'token_created':      return WebhookEventType.TOKEN_CREATED;
      default:                   return null;
    }
  }

  /**
   * Parse event type from Stellar event (kept for extractEventData compatibility)
   * @deprecated Use kindToWebhookType with the decoder registry instead
   */
  private parseEventType(event: StellarEvent): WebhookEventType | null {
    return this.kindToWebhookType(kindForTopic(event.topic?.[0] ?? '') ?? '');
  }

  /**
   * Extract event data from Stellar event
   */
  private extractEventData(
    event: StellarEvent,
    eventType: WebhookEventType | null
  ): any {
    const baseData = {
      transactionHash: event.transaction_hash,
      ledger: event.ledger,
    };

    if (!eventType) {
      // Return base data for events without specific webhook types
      return baseData;
    }

    switch (eventType) {
      case WebhookEventType.TOKEN_BURN_SELF:
        return {
          ...baseData,
          tokenAddress: event.topic[1] || "",
          from: event.value?.from || "",
          amount: event.value?.amount?.toString() || "0",
          burner: event.value?.burner || event.value?.from || "",
        };

      case WebhookEventType.TOKEN_BURN_ADMIN:
        return {
          ...baseData,
          tokenAddress: event.topic[1] || "",
          from: event.value?.from || "",
          amount: event.value?.amount?.toString() || "0",
          admin: event.value?.admin || "",
        };

      case WebhookEventType.TOKEN_CREATED:
        return {
          ...baseData,
          tokenAddress: event.topic[1] || "",
          creator: event.value?.creator || "",
          name: event.value?.name || "",
          symbol: event.value?.symbol || "",
          decimals: event.value?.decimals || 7,
          initialSupply: event.value?.initial_supply?.toString() || "0",
        };

      case WebhookEventType.TOKEN_METADATA_UPDATED:
        return {
          ...baseData,
          tokenAddress: event.topic[1] || "",
          metadataUri: event.value?.metadata_uri || "",
          updatedBy: event.value?.updated_by || "",
        };

      default:
        return baseData;
    }
  }

  /**
   * Map a StellarEvent to a RawTokenEvent for projection, or null if not a token event.
   */
  private toRawTokenEvent(event: StellarEvent): RawTokenEvent | null {
    const topic0 = event.topic[0];
    const tokenAddress = event.topic[1] || "";

    switch (topic0) {
      case "tok_reg":
        return {
          type: "tok_reg",
          tokenAddress,
          transactionHash: event.transaction_hash,
          ledger: event.ledger,
          creator: event.value?.creator || "",
          name: event.value?.name || "",
          symbol: event.value?.symbol || "",
          decimals: event.value?.decimals ?? 7,
          initialSupply: event.value?.initial_supply?.toString() || "0",
        };
      case "tok_burn":
        return {
          type: "tok_burn",
          tokenAddress,
          transactionHash: event.transaction_hash,
          ledger: event.ledger,
          from: event.value?.from || "",
          amount: event.value?.amount?.toString() || "0",
          burner: event.value?.burner || event.value?.from || "",
        };
      case "adm_burn":
        return {
          type: "adm_burn",
          tokenAddress,
          transactionHash: event.transaction_hash,
          ledger: event.ledger,
          from: event.value?.from || "",
          amount: event.value?.amount?.toString() || "0",
          admin: event.value?.admin || "",
        };
      case "tok_meta":
        return {
          type: "tok_meta",
          tokenAddress,
          transactionHash: event.transaction_hash,
          ledger: event.ledger,
          metadataUri: event.value?.metadata_uri || "",
          updatedBy: event.value?.updated_by || "",
        };
      default:
        return null;
    }
  }

  /**
   * Check if event is a stream or vault event (registry-backed)
   */
  private isStreamOrVaultEvent(event: StellarEvent): boolean {
    const kind = kindForTopic(event.topic?.[0] ?? '');
    return kind?.startsWith('vault_') ?? false;
  }

  /**
   * Process stream or vault events
   */
  private async processStreamOrVaultEvent(event: StellarEvent): Promise<void> {
    const topic0 = event.topic[0];
    const timestamp = Math.floor(new Date(event.ledger_close_time).getTime() / 1000);

    switch (topic0) {
      case "vlt_cr_v1": {
        const parsed = parseVaultCreatedEvent(event, timestamp);
        if (parsed) {
          await this.streamEventParser.parseEvent({
            type: "created",
            streamId: parsed.streamId,
            creator: parsed.creator,
            recipient: parsed.recipient,
            amount: parsed.amount,
            hasMetadata: parsed.hasMetadata,
            txHash: event.transaction_hash,
            timestamp: new Date(timestamp * 1000),
          });
        }
        break;
      }
      case "vlt_cl_v1": {
        const parsed = parseVaultClaimedEvent(event, timestamp);
        if (parsed) {
          await this.streamEventParser.parseEvent({
            type: "claimed",
            streamId: parsed.streamId,
            recipient: parsed.recipient,
            amount: parsed.amount,
            txHash: event.transaction_hash,
            timestamp: new Date(timestamp * 1000),
          });
        }
        break;
      }
      case "vlt_cn_v1": {
        const parsed = parseVaultCancelledEvent(event, timestamp);
        if (parsed) {
          await this.streamEventParser.parseEvent({
            type: "cancelled",
            streamId: parsed.streamId,
            creator: parsed.canceller, // Mapping canceller to creator for event type compatibility
            refundAmount: parsed.remainingAmount,
            txHash: event.transaction_hash,
            timestamp: new Date(timestamp * 1000),
          });
        }
        break;
      }
      case "vlt_md_v1": {
        const parsed = parseVaultMetadataUpdatedEvent(event, timestamp);
        if (parsed) {
          await this.streamEventParser.parseEvent({
            type: "metadata_updated",
            streamId: parsed.streamId,
            updater: parsed.updater,
            hasMetadata: parsed.hasMetadata,
            txHash: event.transaction_hash,
            timestamp: new Date(timestamp * 1000),
          });
        }
        break;
      }
    }
  }

  /**
   * Check if event is a campaign/buyback event (registry-backed)
   */
  private isBuybackEvent(event: StellarEvent): boolean {
    const topic0 = event.topic[0];
    return [
      'camp_cr_v1', 'camp_cr',
      'camp_ex_v1', 'camp_ex',
      'camp_st_v1', 'camp_st',
      'buyback_exec',
    ].includes(topic0);
  }

  /**
   * Process buyback event
   */
  private async processBuybackEvent(event: StellarEvent): Promise<void> {
     // Placeholder for buyback processing logic
  }

  /**
   * Calculate projection lag for an event
   * 
   * Lag = time_now - ledger_close_time
   * 
   * Context:
   * - ledger_close_time is when the transaction was confirmed on-chain
   * - Horizon typically has events 1-2 seconds after confirmation
   * - Our processing should be <5 seconds in normal operation
   * - 
   * Algorithm:
   * 1. Parse ledger_close_time from Stellar event
   * 2. Calculate milliseconds elapsed since close time
   * 3. Return measurement along with thresholds status
   */
  private calculateProjectionLag(event: StellarEvent): ProjectionLagMetrics {
    const processedAt = new Date();
    const ledgerCloseTime = new Date(event.ledger_close_time);
    const currentLagMs = processedAt.getTime() - ledgerCloseTime.getTime();

    const eventKind = kindForTopic(event.topic?.[0] ?? '') ?? 'unknown';

    // Get or create lag window for this event kind
    if (!eventKindLagWindows.has(eventKind)) {
      eventKindLagWindows.set(eventKind, new LagWindow(LAG_WINDOW_SIZE_MS));
    }
    const kindWindow = eventKindLagWindows.get(eventKind)!;

    // Record in both global and kind-specific windows
    globalLagWindow.record(currentLagMs);
    kindWindow.record(currentLagMs);

    const thresholdStatus = determineThresholdStatus(currentLagMs, eventKind);

    const metrics: ProjectionLagMetrics = {
      currentLag: currentLagMs,
      maxLagInWindow: kindWindow.getMaxLag(),
      averageLagInWindow: kindWindow.getAverageLag(),
      eventKind,
      ledgerCloseTime,
      processedAt,
      thresholdStatus,
    };

    return metrics;
  }

  /**
   * Record lag metrics locally and check for threshold violations
   */
  private recordLagMetrics(metrics: ProjectionLagMetrics): void {
    // Keep recent metrics for querying
    this.recentLagMetrics.push(metrics);
    if (this.recentLagMetrics.length > 1000) {
      this.recentLagMetrics.shift(); // Keep only recent measurements
    }

    // Log high lag events
    if (metrics.thresholdStatus === 'critical') {
      console.error(
        `[CRITICAL LAG] ${metrics.eventKind}: ` +
        `${metrics.currentLag}ms ` +
        `(window: avg=${Math.round(metrics.averageLagInWindow)}ms, ` +
        `max=${Math.round(metrics.maxLagInWindow)}ms)`
      );
    } else if (metrics.thresholdStatus === 'warning') {
      console.warn(
        `[WARNING LAG] ${metrics.eventKind}: ` +
        `${metrics.currentLag}ms ` +
        `(window: avg=${Math.round(metrics.averageLagInWindow)}ms, ` +
        `max=${Math.round(metrics.maxLagInWindow)}ms)`
      );
    }

    // Generate alert if threshold exceeded (with debouncing to reduce noise)
    const alert = generateThresholdAlert(
      metrics.currentLag,
      metrics.eventKind,
      metrics.ledgerCloseTime
    );

    if (alert) {
      const now = Date.now();
      const lastAlertTime = this.lastAlertTime.get(alert.eventKind) ?? 0;

      if (now - lastAlertTime > this.alertDebounceMs) {
        this.lastAlertTime.set(alert.eventKind, now);
        console.error(`[PROJECTION LAG ALERT] ${alert.message}`);
        // Could emit to monitoring service here
      }
    }
  }

  /**
   * Get current lag metrics for a specific event kind
   */
  getLagMetricsForKind(eventKind: string): {
    current?: number;
    average: number;
    max: number;
    count: number;
  } {
    const window = eventKindLagWindows.get(eventKind);
    if (!window) {
      return { average: 0, max: 0, count: 0 };
    }

    const recent = this.recentLagMetrics.find((m) => m.eventKind === eventKind);
    return {
      current: recent?.currentLag,
      average: window.getAverageLag(),
      max: window.getMaxLag(),
      count: window.getCount(),
    };
  }

  /**
   * Get global lag metrics across all event kinds
   */
  getGlobalLagMetrics(): {
    average: number;
    max: number;
    count: number;
    byKind: Record<string, { average: number; max: number }>;
  } {
    const byKind: Record<string, { average: number; max: number }> = {};

    for (const [kind, window] of eventKindLagWindows) {
      byKind[kind] = {
        average: window.getAverageLag(),
        max: window.getMaxLag(),
      };
    }

    return {
      average: globalLagWindow.getAverageLag(),
      max: globalLagWindow.getMaxLag(),
      count: globalLagWindow.getCount(),
      byKind,
    };
  }

  /**
   * Get recent lag metrics (for testing / debugging)
   */
  getRecentLagMetrics(count: number = 10): ProjectionLagMetrics[] {
    return this.recentLagMetrics.slice(-count);
  }

  /**
   * Replay a recorded batch of Stellar events through the full ingestion pipeline.
   * Intended for integration tests and offline replay tooling — not for production polling.
   */
  async replayBatch(events: StellarEvent[]): Promise<{ processed: number; errors: number }> {
    let processed = 0;
    let errors = 0;
    for (const event of events) {
      try {
        await this.processEvent(event);
        processed++;
      } catch (err) {
        errors++;
        console.error(`replayBatch: error on event ${event.id}:`, err);
      }
    }
    return { processed, errors };
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default new StellarEventListener();
