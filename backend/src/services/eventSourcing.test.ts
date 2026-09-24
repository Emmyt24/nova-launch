import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  EventSourcingService,
  InMemoryEventStore,
  DomainEvent,
  AggregateSnapshot,
} from './eventSourcing';

describe('EventSourcingService', () => {
  let service: EventSourcingService;
  let eventStore: InMemoryEventStore;

  beforeEach(() => {
    eventStore = new InMemoryEventStore();
    service = new EventSourcingService(eventStore);
  });

  it('should publish events', async () => {
    await service.publishEvent('agg-1', 'UserCreated', {
      name: 'John',
      email: 'john@example.com',
    });

    const history = await service.getAggregateHistory('agg-1');
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe('UserCreated');
  });

  it('should maintain event version', async () => {
    await service.publishEvent('agg-1', 'Event1', {});
    await service.publishEvent('agg-1', 'Event2', {});
    await service.publishEvent('agg-1', 'Event3', {});

    const history = await service.getAggregateHistory('agg-1');
    expect(history[0].version).toBe(1);
    expect(history[1].version).toBe(2);
    expect(history[2].version).toBe(3);
  });

  it('should record audit trail', async () => {
    await service.publishEvent('agg-1', 'UserCreated', { name: 'John' }, {
      actor: 'admin',
    });

    const trail = await service.getAuditTrail();
    expect(trail).toHaveLength(1);
    expect(trail[0].eventType).toBe('UserCreated');
    expect(trail[0].actor).toBe('admin');
  });

  it('should filter audit trail by aggregate', async () => {
    await service.publishEvent('agg-1', 'Event1', {});
    await service.publishEvent('agg-2', 'Event2', {});

    const trail = await service.getAuditTrail('agg-1');
    expect(trail).toHaveLength(1);
    expect(trail[0].aggregateId).toBe('agg-1');
  });

  it('should filter audit trail by timestamp', async () => {
    const before = Date.now();
    await service.publishEvent('agg-1', 'Event1', {});
    const after = Date.now();

    const trail = await service.getAuditTrail(undefined, before);
    expect(trail.length).toBeGreaterThan(0);
  });

  it('should handle event subscriptions', async () => {
    const handler = vi.fn();
    service.subscribe('UserCreated', handler);

    await service.publishEvent('agg-1', 'UserCreated', { name: 'John' });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'UserCreated',
    }));
  });

  it('should handle multiple subscribers', async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    service.subscribe('UserCreated', handler1);
    service.subscribe('UserCreated', handler2);

    await service.publishEvent('agg-1', 'UserCreated', {});

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it('should handle subscriber errors gracefully', async () => {
    const errorHandler = vi.fn().mockRejectedValue(new Error('Handler error'));
    const successHandler = vi.fn();

    service.subscribe('Event', errorHandler);
    service.subscribe('Event', successHandler);

    await service.publishEvent('agg-1', 'Event', {});

    expect(errorHandler).toHaveBeenCalled();
    expect(successHandler).toHaveBeenCalled();
  });

  it('should get aggregate history', async () => {
    await service.publishEvent('agg-1', 'Event1', { value: 1 });
    await service.publishEvent('agg-1', 'Event2', { value: 2 });

    const history = await service.getAggregateHistory('agg-1');
    expect(history).toHaveLength(2);
    expect(history[0].data.value).toBe(1);
    expect(history[1].data.value).toBe(2);
  });

  it('should clear audit trail', async () => {
    await service.publishEvent('agg-1', 'Event1', {});
    service.clearAuditTrail();

    const trail = await service.getAuditTrail();
    expect(trail).toHaveLength(0);
  });

  it('should include metadata in events', async () => {
    const metadata = { actor: 'user123', source: 'api' };
    await service.publishEvent('agg-1', 'Event', {}, metadata);

    const history = await service.getAggregateHistory('agg-1');
    expect(history[0].metadata).toEqual(metadata);
  });

  it('should handle concurrent events', async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      service.publishEvent(`agg-${i}`, 'Event', { index: i })
    );

    await Promise.all(promises);

    for (let i = 0; i < 10; i++) {
      const history = await service.getAggregateHistory(`agg-${i}`);
      expect(history).toHaveLength(1);
    }
  });

  it('assigns unique, sequential versions under concurrent publishes for same aggregate (Issue #1977)', async () => {
    // Fire multiple concurrent publishEvent calls for the same aggregateId
    // Each event should get a unique, sequential version number
    const concurrentCount = 5;
    const promises = Array.from({ length: concurrentCount }, (_, i) =>
      service.publishEvent('agg-concurrent', `Event${i}`, { index: i })
    );

    await Promise.all(promises);

    const history = await service.getAggregateHistory('agg-concurrent');
    expect(history).toHaveLength(concurrentCount);

    // Versions should be unique and sequential (1, 2, 3, 4, 5)
    const versions = history.map((e) => e.version).sort((a, b) => a - b);
    for (let i = 0; i < concurrentCount; i++) {
      expect(versions[i]).toBe(i + 1);
    }

    // Check for duplicates — there should be none
    const uniqueVersions = new Set(versions);
    expect(uniqueVersions.size).toBe(concurrentCount);
  });
});

describe('EventSourcingService — snapshot-based replay', () => {
  let service: EventSourcingService;
  let eventStore: InMemoryEventStore;

  // Simple counter reducer: accumulates a running total from each event's `value`.
  const counterReducer = (
    state: Record<string, any>,
    event: DomainEvent
  ): Record<string, any> => ({
    ...state,
    total: (state.total ?? 0) + (event.data.value ?? 0),
    count: (state.count ?? 0) + 1,
  });

  beforeEach(() => {
    eventStore = new InMemoryEventStore();
    service = new EventSourcingService(eventStore);
  });

  it('createSnapshot returns correct version matching the latest event', async () => {
    await service.publishEvent('agg-snap', 'Increment', { value: 10 });
    await service.publishEvent('agg-snap', 'Increment', { value: 20 });
    await service.publishEvent('agg-snap', 'Increment', { value: 30 });

    const state = await service.rebuildStateFromSnapshot('agg-snap', counterReducer);
    const snapshot = await service.createSnapshot('agg-snap', state);

    expect(snapshot.version).toBe(3);
    expect(snapshot.aggregateId).toBe('agg-snap');
    expect(snapshot.state).toEqual({ total: 60, count: 3 });
  });

  it('rebuildStateFromSnapshot produces identical result with and without a snapshot', async () => {
    // Publish several events
    for (let i = 1; i <= 5; i++) {
      await service.publishEvent('agg-equiv', 'Increment', { value: i * 10 });
    }

    // Full replay (no snapshot yet)
    const fullState = await service.rebuildStateFromSnapshot('agg-equiv', counterReducer);

    // Save snapshot at current version, then publish more events
    await service.createSnapshot('agg-equiv', fullState);

    for (let i = 6; i <= 8; i++) {
      await service.publishEvent('agg-equiv', 'Increment', { value: i * 10 });
    }

    // Snapshot-assisted replay (starts from snapshot, replays only events 6–8)
    const snapshotState = await service.rebuildStateFromSnapshot('agg-equiv', counterReducer);

    // Full replay from scratch for comparison
    const freshStore = new InMemoryEventStore();
    const freshService = new EventSourcingService(freshStore);
    for (let i = 1; i <= 8; i++) {
      await freshService.publishEvent('agg-equiv', 'Increment', { value: i * 10 });
    }
    const freshFullState = await freshService.rebuildStateFromSnapshot('agg-equiv', counterReducer);

    expect(snapshotState).toEqual(freshFullState);
    expect(snapshotState.total).toBe(360); // 10+20+30+40+50+60+70+80
    expect(snapshotState.count).toBe(8);
  });

  it('forward-compatibility: new fields default correctly when absent from an old snapshot', async () => {
    // Simulate an "old" snapshot that lacks a field the reducer would normally produce
    const oldSnapshot: AggregateSnapshot = {
      id: 'snap-legacy',
      aggregateId: 'agg-compat',
      version: 2,
      state: { total: 30 }, // `count` field absent — simulates old snapshot format
      timestamp: Date.now(),
    };
    await eventStore.saveSnapshot(oldSnapshot);

    // Events after the snapshot version
    const event3: DomainEvent = {
      id: '3',
      aggregateId: 'agg-compat',
      type: 'Increment',
      timestamp: Date.now(),
      version: 3,
      data: { value: 40 },
    };
    await eventStore.append(event3);

    // Reducer handles missing `count` gracefully via the `?? 0` default
    const state = await service.rebuildStateFromSnapshot('agg-compat', counterReducer);

    expect(state.total).toBe(70);  // 30 (snapshot) + 40 (event3)
    expect(state.count).toBe(1);   // only 1 event replayed; old snapshot had no count
  });

  it('auto-snapshot triggers at the configured interval', async () => {
    const interval = 3;
    const autoService = new EventSourcingService(eventStore, interval);

    // Publish exactly `interval` events — the Nth event should trigger an auto-snapshot
    for (let i = 1; i <= interval; i++) {
      await autoService.publishEvent('agg-auto', 'Increment', { value: i }, undefined, counterReducer);
    }

    const snapshot = await eventStore.getLatestSnapshot('agg-auto');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.version).toBe(interval);
    expect(snapshot!.state).toEqual({ total: 6, count: 3 }); // 1+2+3

    // Publish more events past the interval boundary
    for (let i = interval + 1; i <= interval * 2; i++) {
      await autoService.publishEvent('agg-auto', 'Increment', { value: i }, undefined, counterReducer);
    }

    // A second snapshot should now exist at version interval*2
    const latestSnapshot = await eventStore.getLatestSnapshot('agg-auto');
    expect(latestSnapshot!.version).toBe(interval * 2);
  });
});

describe('InMemoryEventStore', () => {
  let store: InMemoryEventStore;

  beforeEach(() => {
    store = new InMemoryEventStore();
  });

  it('should append events', async () => {
    const event: DomainEvent = {
      id: '1',
      aggregateId: 'agg-1',
      type: 'Test',
      timestamp: Date.now(),
      version: 1,
      data: {},
    };

    await store.append(event);
    const events = await store.getEvents('agg-1');

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('1');
  });

  it('should get events from version', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.append({
        id: String(i),
        aggregateId: 'agg-1',
        type: 'Event',
        timestamp: Date.now(),
        version: i,
        data: {},
      });
    }

    const events = await store.getEvents('agg-1', 3);
    expect(events).toHaveLength(3);
    expect(events[0].version).toBe(3);
  });

  it('should get all events', async () => {
    await store.append({
      id: '1',
      aggregateId: 'agg-1',
      type: 'Event',
      timestamp: Date.now(),
      version: 1,
      data: {},
    });

    const events = await store.getAllEvents();
    expect(events.length).toBeGreaterThan(0);
  });
});
