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
import { 
  BACKGROUND_RETRY_CONFIG,
  calculateBackoffDelay,
  isRetryableError,
  sleep
} from "../stellar-service-integration/rate-limiter";

const _env = validateEnv();
const HORIZON_URL = _env.STELLAR_HORIZON_URL;
const FACTORY_CONTRACT_ID = _env.FACTORY_CONTRACT_ID;

// Fail fast at module load: an empty or malformed contract ID means every
// event poll will silently hit the wrong URL or return no results.
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
const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds

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

  constructor() {
    this.prisma = new PrismaClient();
    this.governanceParser = new GovernanceEventParser(this.prisma);
    this.tokenEventParser = new TokenEventParser(this.prisma);
    this.cursorStore = new EventCursorStore(this.prisma);
    this.streamEventParser = new StreamEventParser(this.prisma);
  }

  /**
   * Start listening for Stellar events
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("Event listener is already running");
      return;
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
   * Poll for new events
   */
  private async pollEvents(): Promise<void> {
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 5;

    while (this.isRunning) {
      try {
        await this.fetchAndProcessEvents();
        consecutiveFailures = 0; // Reset on success
      } catch (error) {
        consecutiveFailures++;
        
        const isTransient = isRetryableError(error);
        
        if (isTransient) {
          console.warn(
            `Transient error polling events (failure ${consecutiveFailures}/${maxConsecutiveFailures}):`,
            error instanceof Error ? error.message : String(error)
          );
          
          // Use exponential backoff for transient errors
          const backoffDelay = calculateBackoffDelay(
            Math.min(consecutiveFailures, BACKGROUND_RETRY_CONFIG.maxAttempts),
            BACKGROUND_RETRY_CONFIG
          );
          
          console.log(`Backing off for ${Math.round(backoffDelay)}ms before next poll`);
          await sleep(backoffDelay);
          
          // If too many consecutive failures, alert but continue
          if (consecutiveFailures >= maxConsecutiveFailures) {
            console.error(
              `Event listener has failed ${consecutiveFailures} times consecutively. ` +
              `Continuing with extended backoff.`
            );
          }
        } else {
          // Terminal error - log and continue with normal polling
          console.error("Terminal error polling events (will continue):", error);
          consecutiveFailures = 0; // Reset since it's not a transient issue
        }
      }

      // Wait before next poll (normal interval or already backed off above)
      if (consecutiveFailures === 0) {
        await this.delay(POLL_INTERVAL_MS);
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
      const response = await axios.get(url, { 
        params,
        timeout: 30000, // 30 second timeout
      });
      
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
      // Enhance error with context for better retry decisions
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 429) {
          console.warn("Rate limited by Horizon API (429)");
          throw error; // Will be retried with backoff
        } else if (status && status >= 500) {
          console.warn(`Horizon API server error (${status})`);
          throw error; // Will be retried with backoff
        } else if (status && status >= 400 && status < 500) {
          console.error(`Horizon API client error (${status}):`, error.message);
          throw error; // Terminal error, won't retry
        }
      }
      
      console.error("Error fetching events:", error);
      throw error;
    }
  }

  /**
   * Process a single event
   */
  private async processEvent(event: StellarEvent): Promise<void> {
    try {
      // Check if this is a governance event
      if (governanceEventMapper.isGovernanceEvent(event)) {
        const governanceEvent = governanceEventMapper.mapEvent(event);
        if (governanceEvent) {
          await this.governanceParser.parseEvent(governanceEvent);
          console.log(`Processed governance event: ${governanceEvent.type}`);
        }
        return;
      }

      // Route buyback campaign events
      if (this.isBuybackEvent(event)) {
        await this.processBuybackEvent(event);
        return;
      }

      // Route stream and vault events
      if (this.isStreamOrVaultEvent(event)) {
        await this.processStreamOrVaultEvent(event);
        return;
      }

      // Parse event topic to determine event type
      const eventType = this.parseEventType(event);

      // Extract event data based on type
      const eventData = this.extractEventData(event, eventType);

      if (!eventData) {
        return;
      }

      // Persist token projection (idempotent)
      const rawTokenEvent = this.toRawTokenEvent(event);
      if (rawTokenEvent) {
        await this.tokenEventParser.parseEvent(rawTokenEvent);
      }

      // Trigger webhooks only if we have a webhook event type
      if (eventType) {
        await webhookDeliveryService.triggerEvent(
          eventType,
          eventData,
          eventData.tokenAddress
        );
      }
    } catch (error) {
      console.error("Error processing event:", error);
    }
  }

  /**
   * Parse event type from Stellar event
   */
  private parseEventType(event: StellarEvent): WebhookEventType | null {
    // Event topics are typically structured as [event_name, ...]
    if (event.topic.length < 1) {
      return null;
    }

    const eventName = event.topic[0];

    switch (eventName) {
      case "tok_burn":
        return WebhookEventType.TOKEN_BURN_SELF;

      case "adm_burn":
        return WebhookEventType.TOKEN_BURN_ADMIN;

      case "tok_reg":
        return WebhookEventType.TOKEN_CREATED;

      case "adm_xfer":
      case "adm_prop":
        // Both admin transfer and admin proposed are admin-related events
        return null; // No webhook type defined yet, but parse successfully

      default:
        return null;
    }
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
   * Check if event is a stream or vault event
   */
  private isStreamOrVaultEvent(event: StellarEvent): boolean {
    const topic0 = event.topic[0];
    return [
      "vlt_cr_v1",
      "vlt_fd_v1",
      "vlt_cl_v1",
      "vlt_cn_v1",
      "vlt_md_v1"
    ].includes(topic0);
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
   * Check if event is a buyback event
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
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default new StellarEventListener();
