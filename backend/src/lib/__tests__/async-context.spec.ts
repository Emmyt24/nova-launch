import { describe, it, expect } from 'vitest';
import {
  asyncContext,
  getCorrelationId,
  getTransactionId,
  getTraceContext,
  getTenantId,
  isBypassingTenant,
  runWithContext,
  runWithTenant,
  runBypassing,
  TraceContext,
} from '../async-context';

describe('async-context', () => {
  it('returns undefined when no context is active', () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(getTransactionId()).toBeUndefined();
    expect(getTraceContext()).toBeUndefined();
    expect(getTenantId()).toBeUndefined();
    expect(isBypassingTenant()).toBe(false);
  });

  describe('runWithContext', () => {
    it('sets correlationId, transactionId, and traceContext in store', () => {
      const trace: TraceContext = {
        version: '00',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        parentId: '00f067aa0ba902b7',
        traceFlags: '01',
        raw: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      };

      const result = runWithContext('corr-123', () => {
        expect(getCorrelationId()).toBe('corr-123');
        expect(getTransactionId()).toBe('tx-456');
        expect(getTraceContext()).toEqual(trace);
        expect(getTenantId()).toBeUndefined();
        expect(isBypassingTenant()).toBe(false);
        return 'success';
      }, 'tx-456', trace);

      expect(result).toBe('success');
      expect(getCorrelationId()).toBeUndefined();
    });

    it('works when optional parameters are omitted', () => {
      runWithContext('corr-abc', () => {
        expect(getCorrelationId()).toBe('corr-abc');
        expect(getTransactionId()).toBeUndefined();
        expect(getTraceContext()).toBeUndefined();
      });
    });
  });

  describe('runWithTenant', () => {
    it('sets tenantId without prior context (defaults correlationId to empty string)', () => {
      runWithTenant('tenant-1', () => {
        expect(getTenantId()).toBe('tenant-1');
        expect(getCorrelationId()).toBe('');
        expect(getTransactionId()).toBeUndefined();
      });
    });

    it('preserves existing correlationId and transactionId when nested in context', () => {
      runWithContext('corr-nest', () => {
        runWithTenant('tenant-2', () => {
          expect(getTenantId()).toBe('tenant-2');
          expect(getCorrelationId()).toBe('corr-nest');
          expect(getTransactionId()).toBe('tx-nest');
        });
      }, 'tx-nest');
    });
  });

  describe('runBypassing', () => {
    it('enables bypassTenant flag without existing context', () => {
      runBypassing(() => {
        expect(isBypassingTenant()).toBe(true);
        expect(getCorrelationId()).toBe('');
        expect(getTenantId()).toBeUndefined();
      });
    });

    it('preserves existing tenant and correlation context while setting bypassTenant', () => {
      runWithContext('corr-bypass', () => {
        runWithTenant('tenant-bypass', () => {
          runBypassing(() => {
            expect(isBypassingTenant()).toBe(true);
            expect(getTenantId()).toBe('tenant-bypass');
            expect(getCorrelationId()).toBe('corr-bypass');
            expect(getTransactionId()).toBe('tx-bypass');
          });
        });
      }, 'tx-bypass');
    });
  });
});
