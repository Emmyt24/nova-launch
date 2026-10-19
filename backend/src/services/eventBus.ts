/**
 * Event Bus Architecture for Microservice Communication
 *
 * An in-process, typed event bus that decouples microservice modules:
 *  - Publish/subscribe with wildcard support ("*" catches all events)
 *  - Async handlers with isolated error handling (one bad handler never
 *    blocks others)
 *  - One-time subscriptions via `once()`
 *  - Unsubscribe support
 *  - Dead-letter queue for failed handler invocations
 *  - Event history for replay / debugging
 *  - Schema validation against event-schemas/ in non-production (#1406)
 *
 * Issue: #843, #1406
 */

import { v4 as uuidv4 } from "uuid";
import { validateEventPayload } from "./eventSchemaValidator";
import { logger } from "../lib/logger";

/**
 * Whether the current process is running in production. Mirrors the
 * `isProduction()` convention used elsewhere (e.g. `backend/src/routes/health.ts`).
 */
const isProduction = () => process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BusEvent<T = unknown> {
  /** Unique event identifier */
  id: string;
  /** Event type / topic (e.g. "token.created", "webhook.failed") */
  type: string;
  /** Event payload */
  payload: T;
  /** ISO timestamp of publication */
  timestamp: string;
  /** Optional correlation ID for distributed tracing */
  correlationId?: string;
  /**
   * Monotonically incrementing sequence number assigned at publish time.
   * Used by the catchup endpoint so clients can request missed events
   * after a WebSocket reconnect (#1372).
   */
  sequence: number;
  /**
   * Schema version of the event payload (#2243). Absent on legacy events
   * published before versioning was introduced; consumers should treat a
   * missing `version` as `1`. New payload shapes bump this value so older
   * parsers can keep working while newer ones read the richer payload.
   */
  version?: number;
}

// ---------------------------------------------------------------------------
// Versioned event payloads (#2243, #2245)
// ---------------------------------------------------------------------------

/**
 * Current schema version for fee-change events. Version 2 adds the previous
 * value alongside the new one so audit trails are complete; version 1
 * payloads (new value only) remain parseable.
 */
export const FEE_CHANGE_EVENT_VERSION = 2;

/** Current schema version for allowlist-mode change events (#2245). */
export const ALLOWLIST_CHANGE_EVENT_VERSION = 1;

/** Event type emitted when a fee parameter changes. */
export const FEE_CHANGED_EVENT = "fee.changed";

/** Event type emitted when a token's allowlist mode is toggled. */
export const ALLOWLIST_MODE_CHANGED_EVENT = "token.allowlist_mode.changed";

/**
 * Payload for `fee.changed` (version 2). `oldValue` is `null` when the fee
 * parameter had no prior value (e.g. first-time configuration).
 */
export interface FeeChangedPayload {
  /** Version of this payload shape. */
  version: number;
  /** Identifier of the fee parameter that changed (e.g. "transfer_fee_bps"). */
  parameter: string;
  /** Previous value, or `null` if unset. */
  oldValue: string | number | null;
  /** New value. */
  newValue: string | number;
  /** Optional account/actor that performed the change. */
  changedBy?: string;
  /** Optional free-form reason for the change. */
  reason?: string;
}

/**
 * Payload for `token.allowlist_mode.changed` (#2245).
 */
export interface AllowlistModeChangedPayload {
  /** Version of this payload shape. */
  version: number;
  /** Token contract address whose allowlist mode changed. */
  tokenAddress: string;
  /** Whether allowlist (restricted transfers) mode is now enabled. */
  enabled: boolean;
  /** Optional account/actor that performed the change. */
  changedBy?: string;
}

/**
 * Parse a `fee.changed` payload of any supported version into the current
 * (v2) shape. Version 1 payloads carried only the new value, so `oldValue`
 * is reported as `null` for them.
 *
 * @throws {Error} if the payload is not a recognised fee-change payload.
 */
export function parseFeeChangedPayload(payload: unknown): FeeChangedPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Invalid fee.changed payload: expected an object");
  }
  const raw = payload as Record<string, unknown>;
  const version = typeof raw.version === "number" ? raw.version : 1;

  if (version >= 2) {
    if (typeof raw.parameter !== "string") {
      throw new Error("Invalid fee.changed payload: missing parameter");
    }
    if (raw.newValue === undefined) {
      throw new Error("Invalid fee.changed payload: missing newValue");
    }
    return {
      version: FEE_CHANGE_EVENT_VERSION,
      parameter: raw.parameter,
      oldValue:
        raw.oldValue === undefined
          ? null
          : (raw.oldValue as string | number | null),
      newValue: raw.newValue as string | number,
      changedBy: typeof raw.changedBy === "string" ? raw.changedBy : undefined,
      reason: typeof raw.reason === "string" ? raw.reason : undefined,
    };
  }

  // Version 1: only the new value was emitted.
  if (typeof raw.parameter !== "string") {
    throw new Error("Invalid fee.changed payload: missing parameter");
  }
  if (raw.value === undefined && raw.newValue === undefined) {
    throw new Error("Invalid fee.changed payload: missing value");
  }
  return {
    version: FEE_CHANGE_EVENT_VERSION,
    parameter: raw.parameter,
    oldValue: null,
    newValue: (raw.newValue ?? raw.value) as string | number,
    changedBy: typeof raw.changedBy === "string" ? raw.changedBy : undefined,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
  };
}

/**
 * Parse a `token.allowlist_mode.changed` payload into the current shape.
 *
 * @throws {Error} if the payload is not a recognised allowlist-change payload.
 */
export function parseAllowlistModeChangedPayload(
  payload: unknown
): AllowlistModeChangedPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(
      "Invalid token.allowlist_mode.changed payload: expected an object"
    );
  }
  const raw = payload as Record<string, unknown>;
  if (typeof raw.tokenAddress !== "string") {
    throw new Error(
      "Invalid token.allowlist_mode.changed payload: missing tokenAddress"
    );
  }
  if (typeof raw.enabled !== "boolean") {
    throw new Error(
      "Invalid token.allowlist_mode.changed payload: missing enabled"
    );
  }
  return {
    version:
      typeof raw.version === "number"
        ? raw.version
        : ALLOWLIST_CHANGE_EVENT_VERSION,
    tokenAddress: raw.tokenAddress,
    enabled: raw.enabled,
    changedBy: typeof raw.changedBy === "string" ? raw.changedBy : undefined,
  };
}

export type EventHandler<T = unknown> = (
  event: BusEvent<T>
) => void | Promise<void>;

export interface Subscription {
  id: string;
  eventType: string;
  /** Remove this subscription */
  unsubscribe: () => void;
}

export interface DeadLetterEntry {
  event: BusEvent;
  handlerSubscriptionId: string;
  error: string;
  failedAt: string;
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export class EventBus {
  private handlers = new Map<string, Map<string, EventHandler>>();
  private history: BusEvent[] = [];
  private deadLetterQueue: DeadLetterEntry[] = [];

  /** Monotonically incrementing sequence counter (#1372); resets on restart because this bus is in-memory. */
  private _sequence = 0;

  /** Maximum events kept in history. 0 = unlimited. */
  private readonly maxHistory: number;

  constructor(options: { maxHistory?: number } = {}) {
    this.maxHistory = options.maxHistory ?? 1000;
  }

  // ── Subscribe ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to an event type.
   *
   * Use `"*"` to receive every event regardless of type.
   *
   * @returns A `Subscription` object with an `unsubscribe()` method.
   */
  subscribe<T = unknown>(
    eventType: string,
    handler: EventHandler<T>
  ): Subscription {
    const subscriptionId = uuidv4();

    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Map());
    }

    this.handlers.get(eventType)!.set(subscriptionId, handler as EventHandler);

    return {
      id: subscriptionId,
      eventType,
      unsubscribe: () => this.unsubscribe(eventType, subscriptionId),
    };
  }

  /**
   * Subscribe to an event type for a single invocation.
   * The handler is automatically removed after the first matching event.
   */
  once<T = unknown>(
    eventType: string,
    handler: EventHandler<T>
  ): Subscription {
    let subscription: Subscription;

    const wrappedHandler: EventHandler<T> = async (event) => {
      subscription.unsubscribe();
      await handler(event);
    };

    subscription = this.subscribe(eventType, wrappedHandler);
    return subscription;
  }

  /**
   * Remove a specific subscription.
   */
  unsubscribe(eventType: string, subscriptionId: string): void {
    this.handlers.get(eventType)?.delete(subscriptionId);
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  /**
   * Publish an event to all matching subscribers.
   *
   * Handlers are invoked concurrently. A failing handler is caught and
   * recorded in the dead-letter queue — it does not affect other handlers.
   *
   * Schema validation (#1406): in non-production environments
   * (`NODE_ENV !== "production"`), `payload` is validated against the JSON
   * Schema registered for `type` in `event-schemas/` *before* the event is
   * recorded or dispatched. A mismatch throws `EventSchemaValidationError`
   * synchronously so schema drift is caught immediately in dev/CI/tests
   * rather than silently corrupting consumers. Event types with no
   * registered schema are not validated. In production, validation is
   * skipped entirely (logged at debug level) so a schema bug can never take
   * down a live publish path — production payload drift is instead expected
   * to be caught by the CI codegen-sync check and by non-prod testing.
   *
   * Naming convention with `event-schemas/` (#2087): `eventSchemaValidator.ts`
   * loads every `*.schema.json` file from the monorepo-root `event-schemas/`
   * directory and keys each one by its own `eventType` field. For a
   * `publish("token.burned", ...)` call to have a chance of being
   * schema-validated, the string literal passed as `type` must exactly match
   * the `eventType` field of a schema file — same casing, same dot-separated
   * segments, no aliases or wildcards. The file name itself is irrelevant to
   * lookup; only the `eventType` value matters. If a contributor adds a new
   * `publish` call and forgets to add a matching schema file, the event is
   * simply skipped (not an error) and will silently go unvalidated in
   * non-production. Deliberate exceptions: the wildcard subscription type
   * `"*"` is never published and therefore never schema-validated, and any
   * event type intentionally left schema-less (e.g. internal-only or
   * transitional events) is likewise skipped by design.
   *
   * Suggested follow-up (#2087): a lint rule or test could enumerate every
   * string literal passed to `eventBus.publish` across the codebase and flag
   * ones with no corresponding schema file, turning the silent skip above
   * into an actionable CI signal. Not implemented in this change.
   *
   * @returns The fully constructed `BusEvent` that was dispatched.
   * @throws {EventSchemaValidationError} if `payload` fails schema validation
   *   outside production.
   */
  async publish<T = unknown>(
    type: string,
    payload: T,
    options: { correlationId?: string; version?: number } = {}
  ): Promise<BusEvent<T>> {
    if (!isProduction()) {
      validateEventPayload(type, payload);
    } else {
      logger.debug("[EventBus] schema validation skipped in production", { type });
    }

    const event: BusEvent<T> = {
      id: uuidv4(),
      type,
      payload,
      timestamp: new Date().toISOString(),
      correlationId: options.correlationId,
      sequence: ++this._sequence,
      version: options.version,
    };

    this.recordHistory(event);

    // Collect handlers: exact-match + wildcard
    const exactHandlers = this.handlers.get(type) ?? new Map<string, EventHandler>();
    const wildcardHandlers = this.handlers.get("*") ?? new Map<string, EventHandler>();

    const allHandlers = new Map([...exactHandlers, ...wildcardHandlers]);

    await Promise.all(
      Array.from(allHandlers.entries()).map(([subId, handler]) =>
        this.invokeHandler(handler, event, subId)
      )
    );

    return event;
  }

  /**
   * Publish a versioned `fee.changed` event carrying both the previous and
   * new values (#2243). The payload is emitted at
   * `FEE_CHANGE_EVENT_VERSION`; consumers on older versions can still parse
   * it via `parseFeeChangedPayload`.
   */
  async publishFeeChanged(
    change: {
      parameter: string;
      oldValue: string | number | null;
      newValue: string | number;
      changedBy?: string;
      reason?: string;
    },
    options: { correlationId?: string } = {}
  ): Promise<BusEvent<FeeChangedPayload>> {
    const payload: FeeChangedPayload = {
      version: FEE_CHANGE_EVENT_VERSION,
      parameter: change.parameter,
      oldValue: change.oldValue,
      newValue: change.newValue,
      changedBy: change.changedBy,
      reason: change.reason,
    };
    return this.publish(FEE_CHANGED_EVENT, payload, {
      ...options,
      version: FEE_CHANGE_EVENT_VERSION,
    });
  }

  /**
   * Publish a `token.allowlist_mode.changed` event (#2245).
   */
  async publishAllowlistModeChanged(
    change: {
      tokenAddress: string;
      enabled: boolean;
      changedBy?: string;
    },
    options: { correlationId?: string } = {}
  ): Promise<BusEvent<AllowlistModeChangedPayload>> {
    const payload: AllowlistModeChangedPayload = {
      version: ALLOWLIST_CHANGE_EVENT_VERSION,
      tokenAddress: change.tokenAddress,
      enabled: change.enabled,
      changedBy: change.changedBy,
    };
    return this.publish(ALLOWLIST_MODE_CHANGED_EVENT, payload, {
      ...options,
      version: ALLOWLIST_CHANGE_EVENT_VERSION,
    });
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /** Return a copy of the event history (most recent last). */
  getHistory(eventType?: string): BusEvent[] {
    if (!eventType) return [...this.history];
    return this.history.filter((e) => e.type === eventType);
  }

  /** Return a copy of the dead-letter queue. */
  getDeadLetterQueue(): DeadLetterEntry[] {
    return [...this.deadLetterQueue];
  }

  /** Number of active subscriptions for a given event type (or total). */
  subscriberCount(eventType?: string): number {
    if (eventType) return this.handlers.get(eventType)?.size ?? 0;
    let total = 0;
    for (const map of this.handlers.values()) total += map.size;
    return total;
  }

  /** Remove all subscriptions and clear history / DLQ. */
  reset(): void {
    this.handlers.clear();
    this.history = [];
    this.deadLetterQueue = [];
    this._sequence = 0;
  }

  /** Current sequence counter value — highest sequence number emitted so far. */
  get currentSequence(): number {
    return this._sequence;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async invokeHandler(
    handler: EventHandler,
    event: BusEvent,
    subscriptionId: string
  ): Promise<void> {
    try {
      await handler(event);
    } catch (err) {
      const entry: DeadLetterEntry = {
        event,
        handlerSubscriptionId: subscriptionId,
        error: err instanceof Error ? err.message : String(err),
        failedAt: new Date().toISOString(),
      };
      this.deadLetterQueue.push(entry);
      console.error(
        `[EventBus] Handler ${subscriptionId} failed for event ${event.type}:`,
        err
      );
    }
  }

  private recordHistory(event: BusEvent): void {
    this.history.push(event);
    if (this.maxHistory > 0 && this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }
}

/** Singleton event bus instance shared across the backend. */
export const eventBus = new EventBus();
