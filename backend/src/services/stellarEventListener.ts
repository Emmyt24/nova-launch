import axios from "axios";
import { randomUUID } from "crypto";
import { hostname } from "os";
import { Gauge, register } from "prom-client";
import { validateEnv } from "../config/env";
import { LeaderElection, LEADER_LOCK_TTL_MS, LEADER_RENEW_INTERVAL_MS } from "../lib/leaderElection";
import { getRedis } from "../lib/redis";
import { WebhookEventType } from "../types/webhook";
import webhookDeliveryService from "./webhookDeliveryService";
import { PrismaClient } from "@prisma/client";
import { GovernanceEventParser } from "./governanceEventParser";
import governanceEventMapper from "./governanceEventMapper";
import { TokenEventParser, RawTokenEvent } from "./tokenEventParser";
import { EventCursorStore, parseLedgerFromCursor } from "./eventCursorStore";
import { StreamEventParser } from "./streamEventParser";
import { parseVaultCreatedEvent, parseVaultClaimedEvent, parseVaultCancelledEvent, parseVaultMetadataUpdatedEvent } from "./vaultEventParser";
import { decodeEvent, kindForTopic } from "./eventVersioning/decoderRegistry";
import {
  isRetryableError,
  sleep
} from "../stellar-service-integration/rate-limiter";
import { ListenerBackoffState, LISTENER_RECONNECT_CONFIG } from "./listenerBackoff";
import { IntegrationMetrics } from "../monitoring/metrics/prometheus-config";
import { OutboundHttpClient } from "../lib/outboundHttpClient";
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

/**
 * Maximum number of ledgers the cursor may lag before a full catchup is
 * triggered on reconnect. Configurable via MAX_CATCHUP_LEDGERS env var.
 */
export const MAX_CATCHUP_LEDGERS =
  parseInt(process.env.MAX_CATCHUP_LEDGERS ?? "1000", 10);

/** Prometheus gauge: how many ledgers behind the live ledger the cursor is. */
const cursorLagGauge = new Gauge({
  name: "listener_cursor_lag",
  help: "Number of ledgers the Stellar event listener cursor is behind the live ledger.",
  registers: [register],
});

const LAG_WINDOW_SIZE_MS = 60000;
const globalLagWindow = new LagWindow(LAG_WINDOW_SIZE_MS);
const eventKindLagWindows = new Map<string, LagWindow>();

export interface HorizonTransport {
  getEvents(url: string, params: any): Promise<{ data: { _embedded?: { records: StellarEvent[] } } }>;
  /** Fetch the latest ledger sequence from Horizon. May return null on error. */
  getCurrentLedger?(url: string): Promise<number | null>;
}

// Per-call retry (3 attempts, jittered backoff, skips 4xx) and circuit
// breaker protection for the real Horizon HTTP transport. This is a
// separate, faster-reacting layer underneath `pollEvents()`'s own
// poll-loop-level backoff — it fails fast within a single poll iteration
// instead of always waiting for the outer loop to back off.
const horizonClient = new OutboundHttpClient({ serviceName: "horizon" });

export class DefaultHorizonTransport implements HorizonTransport {
  async getEvents(url: string, params: any): Promise<any> {
    return horizonClient.execute(() => axios.get(url, { params, timeout: 30000 }));
  }

  async getCurrentLedger(horizonUrl: string): Promise<number | null> {
    try {
      const res = await axios.get(horizonUrl, { timeout: 10000 });
      return res.data?.core_latest_ledger ?? null;
    } catch {
      return null;
    }
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

  /**
   * Distributed leader election — only the elected leader may run the
   * ingestion loop and advance the event cursor. Standby instances keep
   * this heartbeat running (hot) but never call `pollEvents()` while idle.
   */
  private leaderElection: LeaderElection;
  private electionStarted = false;
  private fencingToken: number | null = null;

  constructor(transport?: HorizonTransport) {
    this.prisma = new PrismaClient();
    this.governanceParser = new GovernanceEventParser(this.prisma);
    this.tokenEventParser = new TokenEventParser(this.prisma);
    this.cursorStore = new EventCursorStore(this.prisma);
    this.streamEventParser = new StreamEventParser(this.prisma);
    this.transport = transport || new DefaultHorizonTransport();
    this.leaderElection = new LeaderElection({
      redis: getRedis(),
      role: "stellar_event_listener",
      instanceId: `${hostname()}:${process.pid}:${randomUUID()}`,
      ttlMs: LEADER_LOCK_TTL_MS,
      renewIntervalMs: LEADER_RENEW_INTERVAL_MS,
      events: {
        onBecameLeader: (token) => this.onBecameLeader(token),
        onLostLeadership: (reason) => this.onLostLeadership(reason),
      },
    });
  }

  /** Test/tooling hook: allows injecting a LeaderElection instance without going through the constructor's Redis wiring. */
  setLeaderElection(leaderElection: LeaderElection): void {
    this.leaderElection = leaderElection;
  }

  setTransport(transport: HorizonTransport): void {
    this.transport = transport;
  }

  /**
   * Start contending for leadership. The ingestion loop only begins once
   * this instance is actually elected leader (see `onBecameLeader`) — an
   * instance that never wins the election stays hot (heartbeating) but
   * idle, exactly like every other standby.
   */
  async start(): Promise<void> {
    if (this.electionStarted) {
      console.warn("Event listener election already started");
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

    this.electionStarted = true;
    console.log("[StellarEventListener] starting leader election heartbeat...");
    await this.leaderElection.start();
  }

  /**
   * Called by the LeaderElection heartbeat when this instance wins (or
   * regains) leadership. Loads the durable cursor and starts ingestion.
   */
  private async onBecameLeader(fencingToken: number): Promise<void> {
    this.fencingToken = fencingToken;

    if (this.isRunning) {
      // Already ingesting (e.g. a renewal that the script reported as a
      // fresh acquisition due to a prior lease expiry/regrant) — nothing to restart.
      return;
    }

    // Load durable cursor before starting — resumes from last processed event
    this.lastCursor = await this.cursorStore.load();
    console.log(`[StellarEventListener] became leader (fencingToken=${fencingToken}), resuming from cursor: ${this.lastCursor ?? "origin"}`);

    // If cursor is too far behind the live ledger, drop it and do a full catchup
    await this.applyCatchupPolicyIfNeeded();

    this.isRunning = true;

    // Start polling loop
    this.pollEvents();
  }

  /**
   * Called by the LeaderElection heartbeat when this instance loses (or
   * never had) leadership. Halts ingestion — the instance remains hot,
   * still heartbeating and ready to resume if it wins a future election.
   */
  private onLostLeadership(reason: string): void {
    if (this.isRunning) {
      console.warn(`[StellarEventListener] lost leadership (${reason}) — halting ingestion`);
    }
    this.isRunning = false;
    this.fencingToken = null;
  }

  /**
   * Stop listening for events and release leadership (if held).
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    this.electionStarted = false;
    await this.leaderElection.stop();
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

          if (attempt > LISTENER_RECONNECT_CONFIG.maxRetries) {
            console.error(
              `[StellarEventListener] ${attempt} consecutive failures — max retries exhausted. Surfacing terminal error.`,
            );
            throw new Error(`Max retries exhausted after ${attempt} attempts`);
          }

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
        // Every cursor write is gated on the fencing token still being
        // current. If a new leader has since been elected (this instance
        // was demoted but hasn't noticed — clock skew, slow GC, delayed
        // partition detection), the token check fails and we must not
        // advance the cursor with stale/duplicate progress.
        if (this.fencingToken === null || !(await this.leaderElection.validateFencingToken(this.fencingToken))) {
          console.error(
            "[StellarEventListener] fencing-token rejected — refusing stale cursor write, halting ingestion",
          );
          this.isRunning = false;
          this.fencingToken = null;
          return;
        }

        await this.processEvent(event);
        this.lastCursor = event.paging_token;
        await this.cursorStore.save(this.lastCursor);
        this.emitCursorLagMetric(event.ledger);
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
   * If the persisted cursor is older than MAX_CATCHUP_LEDGERS behind the live
   * ledger, reset it to null so we start a full catchup from the current tip.
   * The lag is also reported to the cursor_lag Prometheus gauge.
   */
  private async applyCatchupPolicyIfNeeded(): Promise<void> {
    if (!this.lastCursor) return;

    const currentLedger = await this.transport.getCurrentLedger?.(HORIZON_URL);
    if (currentLedger == null) return;

    const lag = await this.cursorStore.getCursorLag(currentLedger);
    if (lag == null) return;

    cursorLagGauge.set(lag);
    console.log(`[StellarEventListener] cursor lag: ${lag} ledgers`);

    if (lag > MAX_CATCHUP_LEDGERS) {
      console.warn(
        `[StellarEventListener] cursor lag ${lag} exceeds MAX_CATCHUP_LEDGERS ` +
          `(${MAX_CATCHUP_LEDGERS}) — resetting to current tip for full catchup`
      );
      this.lastCursor = null;
    }
  }

  /**
   * Emit the cursor_lag metric for the most recently processed event ledger.
   */
  private emitCursorLagMetric(eventLedger: number): void {
    // We don't have real-time ledger here, so we record what we have:
    // lag will be updated on next start/reconnect via applyCatchupPolicyIfNeeded.
    // For per-event granularity, record relative to the event's own ledger.
    // This is a best-effort metric; precise lag is computed on reconnect.
    const cursor = this.lastCursor;
    if (!cursor) return;
    const ledger = parseLedgerFromCursor(cursor);
    if (ledger !== null) {
      // lag vs event ledger (0 when fully caught up)
      cursorLagGauge.set(Math.max(0, eventLedger - ledger));
    }
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
