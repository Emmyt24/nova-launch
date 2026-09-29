export interface DomainEvent {
  id: string;
  aggregateId: string;
  type: string;
  timestamp: number;
  version: number;
  data: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface AggregateSnapshot {
  id: string;
  aggregateId: string;
  version: number;
  state: Record<string, any>;
  timestamp: number;
}

export interface EventStore {
  append(event: DomainEvent): Promise<void>;
  getEvents(aggregateId: string, fromVersion?: number): Promise<DomainEvent[]>;
  getAllEvents(fromTimestamp?: number): Promise<DomainEvent[]>;
  saveSnapshot(snapshot: AggregateSnapshot): Promise<void>;
  getLatestSnapshot(aggregateId: string): Promise<AggregateSnapshot | null>;
}

export interface AuditTrail {
  eventId: string;
  aggregateId: string;
  eventType: string;
  timestamp: string;
  actor?: string;
  changes: Record<string, any>;
}

export class InMemoryEventStore implements EventStore {
  private events: Map<string, DomainEvent[]> = new Map();
  private allEvents: DomainEvent[] = [];
  private snapshots: Map<string, AggregateSnapshot[]> = new Map();

  async append(event: DomainEvent): Promise<void> {
    if (!this.events.has(event.aggregateId)) {
      this.events.set(event.aggregateId, []);
    }

    this.events.get(event.aggregateId)!.push(event);
    this.allEvents.push(event);
  }

  async getEvents(
    aggregateId: string,
    fromVersion?: number
  ): Promise<DomainEvent[]> {
    const events = this.events.get(aggregateId) || [];
    if (!fromVersion) return events;
    return events.filter(e => e.version >= fromVersion);
  }

  async getAllEvents(fromTimestamp?: number): Promise<DomainEvent[]> {
    if (!fromTimestamp) return this.allEvents;
    return this.allEvents.filter(e => e.timestamp >= fromTimestamp);
  }

  async saveSnapshot(snapshot: AggregateSnapshot): Promise<void> {
    if (!this.snapshots.has(snapshot.aggregateId)) {
      this.snapshots.set(snapshot.aggregateId, []);
    }
    this.snapshots.get(snapshot.aggregateId)!.push(snapshot);
  }

  async getLatestSnapshot(aggregateId: string): Promise<AggregateSnapshot | null> {
    const snapshots = this.snapshots.get(aggregateId) || [];
    if (snapshots.length === 0) return null;
    return snapshots[snapshots.length - 1];
  }
}

/**
 * General-purpose, in-memory event-sourcing utility.
 *
 * ## ⚠️  This is NOT the projection snapshot system
 *
 * This codebase has two unrelated concepts both called "snapshot":
 *
 * 1. **`EventSourcingService.createSnapshot` / `AggregateSnapshot`** (this
 *    file) — a generic, in-memory utility keyed by `aggregateId`. It is a
 *    standalone event-sourcing building block and is **not** used in
 *    production by any live feature today.
 *
 * 2. **`projectionSnapshot.ts` / `ProjectionSnapshot`** — a
 *    Prisma-persisted, ledger-keyed snapshot of the campaign, governance,
 *    stream, and vault projection tables. This is the system that
 *    actually backs event replay and projection restore in production (see
 *    `eventReplayService.ts` and `projectionConsistencyCheck.ts`). It is
 *    documented in full in `docs/PROJECTION_SNAPSHOTS.md`.
 *
 * If you arrived here looking for the replay/restore mechanism, you want
 * `projectionSnapshot.ts` and `eventReplayService.ts`, not this class.
 */
export class EventSourcingService {
  private eventStore: EventStore;
  private auditTrail: AuditTrail[] = [];
  private eventHandlers: Map<string, Function[]> = new Map();
  private snapshotInterval: number;

  constructor(eventStore?: EventStore, snapshotInterval: number = 100) {
    this.eventStore = eventStore || new InMemoryEventStore();
    this.snapshotInterval = snapshotInterval;
  }

  async publishEvent(
    aggregateId: string,
    eventType: string,
    data: Record<string, any>,
    metadata?: Record<string, any>,
    stateReducer?: (state: Record<string, any>, event: DomainEvent) => Record<string, any>
  ): Promise<void> {
    const event: DomainEvent = {
      id: this.generateEventId(),
      aggregateId,
      type: eventType,
      timestamp: Date.now(),
      version: await this.getNextVersion(aggregateId),
      data,
      metadata,
    };

    await this.eventStore.append(event);
    this.recordAuditTrail(event);
    await this.handleEvent(event);

    // Auto-snapshot every N events
    if (event.version % this.snapshotInterval === 0 && stateReducer) {
      const state = await this.rebuildStateFromSnapshot(aggregateId, stateReducer);
      await this.createSnapshot(aggregateId, state);
    }
  }

  async getAggregateHistory(aggregateId: string): Promise<DomainEvent[]> {
    return this.eventStore.getEvents(aggregateId);
  }

  async rebuildStateFromSnapshot(
    aggregateId: string,
    stateReducer: (state: Record<string, any>, event: DomainEvent) => Record<string, any>
  ): Promise<Record<string, any>> {
    const snapshot = await this.eventStore.getLatestSnapshot(aggregateId);
    let state = snapshot?.state || {};
    const fromVersion = snapshot ? snapshot.version + 1 : 1;

    const events = await this.eventStore.getEvents(aggregateId, fromVersion);
    for (const event of events) {
      state = stateReducer(state, event);
    }

    return state;
  }

  async createSnapshot(
    aggregateId: string,
    state: Record<string, any>
  ): Promise<AggregateSnapshot> {
    const events = await this.eventStore.getEvents(aggregateId);
    const version = events.length > 0 ? events[events.length - 1].version : 0;

    const snapshot: AggregateSnapshot = {
      id: `snap_${aggregateId}_${version}_${Date.now()}`,
      aggregateId,
      version,
      state,
      timestamp: Date.now(),
    };

    await this.eventStore.saveSnapshot(snapshot);
    return snapshot;
  }

  async getAuditTrail(
    aggregateId?: string,
    fromTimestamp?: number
  ): Promise<AuditTrail[]> {
    let trail = this.auditTrail;

    if (aggregateId) {
      trail = trail.filter(t => t.aggregateId === aggregateId);
    }

    if (fromTimestamp) {
      trail = trail.filter(t => new Date(t.timestamp).getTime() >= fromTimestamp);
    }

    return trail;
  }

  subscribe(eventType: string, handler: (event: DomainEvent) => Promise<void>): void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    this.eventHandlers.get(eventType)!.push(handler);
  }

  private async handleEvent(event: DomainEvent): Promise<void> {
    const handlers = this.eventHandlers.get(event.type) || [];
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error) {
        console.error(`Error handling event ${event.type}:`, error);
      }
    }
  }

  private recordAuditTrail(event: DomainEvent): void {
    const trail: AuditTrail = {
      eventId: event.id,
      aggregateId: event.aggregateId,
      eventType: event.type,
      timestamp: new Date(event.timestamp).toISOString(),
      actor: event.metadata?.actor,
      changes: event.data,
    };
    this.auditTrail.push(trail);
  }

  private async getNextVersion(aggregateId: string): Promise<number> {
    const events = await this.eventStore.getEvents(aggregateId);
    return events.length + 1;
  }

  private generateEventId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  clearAuditTrail(): void {
    this.auditTrail = [];
  }
}
