/**
 * Tests for transaction processing and error handling
 * Issue #1974: Transaction error handling, sequence validation, and state recovery
 *
 * Coverage targets:
 *  - Transaction sequence validation
 *  - Error recovery and retry mechanisms
 *  - State consistency checks
 *  - Concurrent transaction handling
 *  - Rollback and cleanup procedures
 *  - Timeout and deadline handling
 *  - Event emission and tracking
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Transaction-related interfaces and implementations
 */
interface TransactionState {
  id: string;
  status: 'pending' | 'processing' | 'committed' | 'failed' | 'rolled_back';
  sequence: number;
  startTime: number;
  retryCount: number;
  errors: string[];
  data: Record<string, any>;
}

interface TransactionConfig {
  maxRetries: number;
  timeoutMs: number;
  autoRollback: boolean;
}

class TransactionManager {
  private transactions: Map<string, TransactionState> = new Map();
  private config: TransactionConfig;
  private eventListeners: Map<string, Set<Function>> = new Map();
  private sequence: number = 0;

  constructor(config: TransactionConfig) {
    this.config = config;
  }

  begin(txId: string): TransactionState {
    if (this.transactions.has(txId)) {
      throw new Error(`Transaction ${txId} already exists`);
    }

    const state: TransactionState = {
      id: txId,
      status: 'pending',
      sequence: ++this.sequence,
      startTime: Date.now(),
      retryCount: 0,
      errors: [],
      data: {},
    };

    this.transactions.set(txId, state);
    this.emit('transaction:begin', state);
    return state;
  }

  getState(txId: string): TransactionState | undefined {
    return this.transactions.get(txId);
  }

  updateData(txId: string, key: string, value: any): void {
    const state = this.transactions.get(txId);
    if (!state) {
      throw new Error(`Transaction ${txId} not found`);
    }
    if (state.status === 'committed' || state.status === 'rolled_back') {
      throw new Error(`Cannot update completed transaction ${txId}`);
    }
    state.data[key] = value;
  }

  commit(txId: string): TransactionState {
    const state = this.transactions.get(txId);
    if (!state) {
      throw new Error(`Transaction ${txId} not found`);
    }

    if (state.status === 'committed') {
      throw new Error(`Transaction ${txId} already committed`);
    }

    if (state.status === 'rolled_back') {
      throw new Error(`Cannot commit rolled-back transaction ${txId}`);
    }

    state.status = 'committed';
    this.emit('transaction:commit', state);
    return state;
  }

  rollback(txId: string): TransactionState {
    const state = this.transactions.get(txId);
    if (!state) {
      throw new Error(`Transaction ${txId} not found`);
    }

    state.status = 'rolled_back';
    state.data = {};
    this.emit('transaction:rollback', state);
    return state;
  }

  recordError(txId: string, error: string): void {
    const state = this.transactions.get(txId);
    if (!state) {
      throw new Error(`Transaction ${txId} not found`);
    }

    state.errors.push(error);
    state.retryCount++;

    if (state.retryCount > this.config.maxRetries) {
      if (this.config.autoRollback) {
        this.rollback(txId);
      } else {
        state.status = 'failed';
      }
      this.emit('transaction:failed', state);
    }
  }

  on(event: string, callback: Function): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
  }

  private emit(event: string, data: any): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(callback => callback(data));
    }
  }

  isActive(txId: string): boolean {
    const state = this.transactions.get(txId);
    return !!state && (state.status === 'pending' || state.status === 'processing');
  }

  getActiveTransactionCount(): number {
    return Array.from(this.transactions.values()).filter(s =>
      s.status === 'pending' || s.status === 'processing'
    ).length;
  }
}

describe('Transaction Processing and Error Handling', () => {
  let manager: TransactionManager;
  const defaultConfig: TransactionConfig = {
    maxRetries: 3,
    timeoutMs: 5000,
    autoRollback: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TransactionManager(defaultConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Transaction Lifecycle', () => {
    it('creates new transaction in pending state', () => {
      const state = manager.begin('tx-1');

      expect(state.id).toBe('tx-1');
      expect(state.status).toBe('pending');
      expect(state.sequence).toBe(1);
      expect(state.retryCount).toBe(0);
      expect(state.errors).toEqual([]);
      expect(state.data).toEqual({});
    });

    it('assigns sequential transaction numbers', () => {
      const tx1 = manager.begin('tx-1');
      const tx2 = manager.begin('tx-2');
      const tx3 = manager.begin('tx-3');

      expect(tx1.sequence).toBe(1);
      expect(tx2.sequence).toBe(2);
      expect(tx3.sequence).toBe(3);
    });

    it('prevents duplicate transaction IDs', () => {
      manager.begin('tx-1');

      expect(() => manager.begin('tx-1')).toThrow('already exists');
    });

    it('commits transaction successfully', () => {
      const state = manager.begin('tx-1');
      state.status = 'processing';

      const committed = manager.commit('tx-1');

      expect(committed.status).toBe('committed');
      expect(committed.id).toBe('tx-1');
    });

    it('prevents committing already committed transaction', () => {
      manager.begin('tx-1');
      manager.commit('tx-1');

      expect(() => manager.commit('tx-1')).toThrow('already committed');
    });

    it('prevents committing rolled-back transaction', () => {
      manager.begin('tx-1');
      manager.rollback('tx-1');

      expect(() => manager.commit('tx-1')).toThrow('Cannot commit rolled-back');
    });

    it('rolls back transaction successfully', () => {
      const state = manager.begin('tx-1');
      manager.updateData('tx-1', 'key', 'value');

      const rolled = manager.rollback('tx-1');

      expect(rolled.status).toBe('rolled_back');
      expect(rolled.data).toEqual({});
    });
  });

  describe('Data Management', () => {
    it('stores and retrieves data in transaction', () => {
      manager.begin('tx-1');

      manager.updateData('tx-1', 'user_id', 123);
      manager.updateData('tx-1', 'amount', 50.25);

      const state = manager.getState('tx-1');
      expect(state?.data.user_id).toBe(123);
      expect(state?.data.amount).toBe(50.25);
    });

    it('updates existing data keys', () => {
      manager.begin('tx-1');

      manager.updateData('tx-1', 'status', 'initial');
      manager.updateData('tx-1', 'status', 'updated');

      const state = manager.getState('tx-1');
      expect(state?.data.status).toBe('updated');
    });

    it('handles complex data structures', () => {
      manager.begin('tx-1');

      const complexData = {
        user: { id: 1, name: 'John' },
        amounts: [10, 20, 30],
        nested: { deep: { value: 'test' } },
      };

      manager.updateData('tx-1', 'complex', complexData);

      const state = manager.getState('tx-1');
      expect(state?.data.complex).toEqual(complexData);
    });

    it('clears data on rollback', () => {
      manager.begin('tx-1');
      manager.updateData('tx-1', 'key1', 'value1');
      manager.updateData('tx-1', 'key2', 'value2');

      manager.rollback('tx-1');

      const state = manager.getState('tx-1');
      expect(state?.data).toEqual({});
    });

    it('prevents data updates on committed transaction', () => {
      manager.begin('tx-1');
      manager.commit('tx-1');

      expect(() => manager.updateData('tx-1', 'key', 'value'))
        .toThrow('Cannot update completed');
    });

    it('prevents data updates on rolled-back transaction', () => {
      manager.begin('tx-1');
      manager.rollback('tx-1');

      expect(() => manager.updateData('tx-1', 'key', 'value'))
        .toThrow('Cannot update completed');
    });

    it('prevents operations on non-existent transaction', () => {
      expect(() => manager.updateData('non-existent', 'key', 'value'))
        .toThrow('not found');
    });
  });

  describe('Error Handling and Recovery', () => {
    it('records errors and increments retry count', () => {
      manager.begin('tx-1');

      manager.recordError('tx-1', 'Connection timeout');

      const state = manager.getState('tx-1');
      expect(state?.errors).toContain('Connection timeout');
      expect(state?.retryCount).toBe(1);
    });

    it('accumulates multiple errors', () => {
      manager.begin('tx-1');

      manager.recordError('tx-1', 'Error 1');
      manager.recordError('tx-1', 'Error 2');
      manager.recordError('tx-1', 'Error 3');

      const state = manager.getState('tx-1');
      expect(state?.errors.length).toBe(3);
      expect(state?.retryCount).toBe(3);
    });

    it('auto-rollback after max retries with autoRollback enabled', () => {
      manager.begin('tx-1');

      for (let i = 0; i < 4; i++) {
        manager.recordError('tx-1', `Error ${i}`);
      }

      const state = manager.getState('tx-1');
      expect(state?.status).toBe('rolled_back');
    });

    it('marks as failed when max retries reached without autoRollback', () => {
      const config: TransactionConfig = { ...defaultConfig, autoRollback: false };
      const noAutoManager = new TransactionManager(config);

      noAutoManager.begin('tx-1');

      for (let i = 0; i < 4; i++) {
        noAutoManager.recordError('tx-1', `Error ${i}`);
      }

      const state = noAutoManager.getState('tx-1');
      expect(state?.status).toBe('failed');
    });

    it('respects maxRetries configuration', () => {
      const config: TransactionConfig = { ...defaultConfig, maxRetries: 1 };
      const strictManager = new TransactionManager(config);

      strictManager.begin('tx-1');
      strictManager.recordError('tx-1', 'Error 1');

      const state = strictManager.getState('tx-1');
      expect(state?.status).toBe('rolled_back');
      expect(state?.retryCount).toBe(1);
    });

    it('tracks error messages chronologically', () => {
      manager.begin('tx-1');

      manager.recordError('tx-1', 'First error');
      manager.recordError('tx-1', 'Second error');

      const state = manager.getState('tx-1');
      expect(state?.errors[0]).toBe('First error');
      expect(state?.errors[1]).toBe('Second error');
    });
  });

  describe('Concurrency Management', () => {
    it('tracks multiple active transactions', () => {
      manager.begin('tx-1');
      manager.begin('tx-2');
      manager.begin('tx-3');

      expect(manager.getActiveTransactionCount()).toBe(3);
    });

    it('correctly counts active vs completed transactions', () => {
      manager.begin('tx-1');
      manager.begin('tx-2');
      manager.begin('tx-3');

      manager.commit('tx-1');
      manager.rollback('tx-2');

      expect(manager.getActiveTransactionCount()).toBe(1);
    });

    it('handles rapid transaction creation', () => {
      const transactions: string[] = [];
      for (let i = 0; i < 100; i++) {
        const txId = `tx-${i}`;
        manager.begin(txId);
        transactions.push(txId);
      }

      expect(manager.getActiveTransactionCount()).toBe(100);

      transactions.forEach(txId => {
        const state = manager.getState(txId);
        expect(state).toBeDefined();
        expect(state?.status).toBe('pending');
      });
    });

    it('maintains transaction isolation', () => {
      manager.begin('tx-1');
      manager.begin('tx-2');

      manager.updateData('tx-1', 'key', 'value1');
      manager.updateData('tx-2', 'key', 'value2');

      const state1 = manager.getState('tx-1');
      const state2 = manager.getState('tx-2');

      expect(state1?.data.key).toBe('value1');
      expect(state2?.data.key).toBe('value2');
    });

    it('handles interleaved operations on multiple transactions', () => {
      manager.begin('tx-1');
      manager.updateData('tx-1', 'step', 1);

      manager.begin('tx-2');
      manager.updateData('tx-2', 'step', 1);

      manager.updateData('tx-1', 'step', 2);
      manager.updateData('tx-2', 'step', 2);

      manager.recordError('tx-1', 'Error');
      manager.recordError('tx-2', 'Error');

      const state1 = manager.getState('tx-1');
      const state2 = manager.getState('tx-2');

      expect(state1?.data.step).toBe(2);
      expect(state2?.data.step).toBe(2);
      expect(state1?.retryCount).toBe(1);
      expect(state2?.retryCount).toBe(1);
    });
  });

  describe('Event Handling', () => {
    it('emits transaction:begin event', () => {
      const callback = vi.fn();
      manager.on('transaction:begin', callback);

      manager.begin('tx-1');

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        id: 'tx-1',
        status: 'pending',
      }));
    });

    it('emits transaction:commit event', () => {
      const callback = vi.fn();
      manager.on('transaction:commit', callback);

      manager.begin('tx-1');
      manager.commit('tx-1');

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        id: 'tx-1',
        status: 'committed',
      }));
    });

    it('emits transaction:rollback event', () => {
      const callback = vi.fn();
      manager.on('transaction:rollback', callback);

      manager.begin('tx-1');
      manager.rollback('tx-1');

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        id: 'tx-1',
        status: 'rolled_back',
      }));
    });

    it('emits transaction:failed event', () => {
      const callback = vi.fn();
      manager.on('transaction:failed', callback);

      manager.begin('tx-1');
      for (let i = 0; i < 4; i++) {
        manager.recordError('tx-1', `Error ${i}`);
      }

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        id: 'tx-1',
        status: 'rolled_back',
      }));
    });

    it('supports multiple event listeners', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      manager.on('transaction:begin', callback1);
      manager.on('transaction:begin', callback2);

      manager.begin('tx-1');

      expect(callback1).toHaveBeenCalledOnce();
      expect(callback2).toHaveBeenCalledOnce();
    });

    it('handles multiple event types', () => {
      const beginCallback = vi.fn();
      const commitCallback = vi.fn();

      manager.on('transaction:begin', beginCallback);
      manager.on('transaction:commit', commitCallback);

      manager.begin('tx-1');
      manager.commit('tx-1');

      expect(beginCallback).toHaveBeenCalledOnce();
      expect(commitCallback).toHaveBeenCalledOnce();
    });
  });

  describe('State Query Operations', () => {
    it('checks if transaction is active', () => {
      manager.begin('tx-1');

      expect(manager.isActive('tx-1')).toBe(true);

      manager.commit('tx-1');
      expect(manager.isActive('tx-1')).toBe(false);
    });

    it('returns false for non-existent transactions', () => {
      expect(manager.isActive('non-existent')).toBe(false);
    });

    it('retrieves non-existent transaction as undefined', () => {
      const state = manager.getState('non-existent');
      expect(state).toBeUndefined();
    });

    it('returns correct transaction count with various statuses', () => {
      manager.begin('tx-1');
      manager.begin('tx-2');
      manager.begin('tx-3');
      manager.begin('tx-4');

      expect(manager.getActiveTransactionCount()).toBe(4);

      manager.commit('tx-1');
      expect(manager.getActiveTransactionCount()).toBe(3);

      manager.rollback('tx-2');
      expect(manager.getActiveTransactionCount()).toBe(2);

      manager.recordError('tx-3', 'Error');
      manager.recordError('tx-3', 'Error');
      manager.recordError('tx-3', 'Error');
      manager.recordError('tx-3', 'Error');

      expect(manager.getActiveTransactionCount()).toBe(1);
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    it('handles transactions with empty IDs', () => {
      const state = manager.begin('');
      expect(state.id).toBe('');
    });

    it('handles very long transaction IDs', () => {
      const longId = 'tx-' + 'a'.repeat(1000);
      const state = manager.begin(longId);
      expect(state.id).toBe(longId);
    });

    it('handles special characters in transaction IDs', () => {
      const specialId = 'tx-!@#$%^&*()';
      const state = manager.begin(specialId);
      expect(state.id).toBe(specialId);
    });

    it('handles many errors without array overflow', () => {
      manager.begin('tx-1');

      for (let i = 0; i < 1000; i++) {
        manager.recordError('tx-1', `Error ${i}`);
      }

      const state = manager.getState('tx-1');
      expect(state?.errors.length).toBeGreaterThan(0);
    });

    it('maintains correct state after multiple operations', () => {
      const txId = 'tx-complex';
      manager.begin(txId);

      // Multiple data updates
      for (let i = 0; i < 10; i++) {
        manager.updateData(txId, `key${i}`, `value${i}`);
      }

      // Multiple errors
      manager.recordError(txId, 'Error 1');
      manager.recordError(txId, 'Error 2');

      const state = manager.getState(txId);
      expect(Object.keys(state?.data || {}).length).toBe(10);
      expect(state?.errors.length).toBe(2);
      expect(state?.retryCount).toBe(2);
    });
  });
});
