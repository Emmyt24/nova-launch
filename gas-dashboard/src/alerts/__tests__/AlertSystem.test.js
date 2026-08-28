import { describe, it, expect, vi, beforeEach } from 'vitest';
import AlertSystem from '../AlertSystem';

describe('AlertSystem', () => {
  let alertSystem;

  beforeEach(() => {
    alertSystem = new AlertSystem();
  });

  describe('checkGasIncrease', () => {
    it('returns null when fewer than 2 measurements are supplied', () => {
      expect(alertSystem.checkGasIncrease([])).toBeNull();
      expect(
        alertSystem.checkGasIncrease([[{ cpuInstructions: 100 }]])
      ).toBeNull();
    });

    it('returns null when gas increase is at or below warningIncrease', () => {
      // 5% increase (from 100 to 105), warning threshold is 10%
      const measurements = [
        [{ cpuInstructions: 105 }],
        [{ cpuInstructions: 100 }]
      ];
      expect(alertSystem.checkGasIncrease(measurements)).toBeNull();

      // Exactly 10% increase (no alert since condition is > warningIncrease)
      const exactlyWarning = [
        [{ cpuInstructions: 110 }],
        [{ cpuInstructions: 100 }]
      ];
      expect(alertSystem.checkGasIncrease(exactlyWarning)).toBeNull();

      // Gas decrease
      const decrease = [
        [{ cpuInstructions: 90 }],
        [{ cpuInstructions: 100 }]
      ];
      expect(alertSystem.checkGasIncrease(decrease)).toBeNull();
    });

    it('returns a warning alert when gas increase is between warningIncrease and criticalIncrease', () => {
      // 15% increase (warning threshold 10%, critical threshold 20%)
      const measurements = [
        [{ cpuInstructions: 115 }],
        [{ cpuInstructions: 100 }]
      ];
      const alert = alertSystem.checkGasIncrease(measurements);

      expect(alert).not.toBeNull();
      expect(alert.severity).toBe('warning');
      expect(alert.type).toBe('gas_increase');
      expect(alert.message).toContain('Warning: Gas cost increased by 15.0%');
      expect(alert.details).toEqual({
        current: 115,
        previous: 100,
        increase: '15.0'
      });
      expect(alert.timestamp).toBeDefined();
    });

    it('returns a critical alert when gas increase is above criticalIncrease', () => {
      // 25% increase (critical threshold 20%)
      const measurements = [
        [{ cpuInstructions: 125 }],
        [{ cpuInstructions: 100 }]
      ];
      const alert = alertSystem.checkGasIncrease(measurements);

      expect(alert).not.toBeNull();
      expect(alert.severity).toBe('critical');
      expect(alert.type).toBe('gas_increase');
      expect(alert.message).toContain('Critical: Gas cost increased by 25.0%');
      expect(alert.details).toEqual({
        current: 125,
        previous: 100,
        increase: '25.0'
      });
      expect(alert.timestamp).toBeDefined();
    });

    it('respects custom threshold configurations', () => {
      const customAlertSystem = new AlertSystem({
        warningIncrease: 5,
        criticalIncrease: 15
      });

      const measurements = [
        [{ cpuInstructions: 108 }],
        [{ cpuInstructions: 100 }]
      ];
      const alert = customAlertSystem.checkGasIncrease(measurements);

      expect(alert).not.toBeNull();
      expect(alert.severity).toBe('warning');
    });
  });

  describe('checkRegression', () => {
    it('returns null when there is no optimizations entry', async () => {
      vi.spyOn(alertSystem, 'loadOptimizations').mockResolvedValue([]);

      const measurements = [[{ cpuInstructions: 150 }]];
      const alert = await alertSystem.checkRegression(measurements);

      expect(alert).toBeNull();
    });

    it('returns null when the latest optimization is not status: "deployed"', async () => {
      vi.spyOn(alertSystem, 'loadOptimizations').mockResolvedValue([
        {
          name: 'loop-unrolling',
          status: 'in_progress',
          gasBefore: 100,
          gasAfter: 80
        }
      ]);

      const measurements = [[{ cpuInstructions: 150 }]];
      const alert = await alertSystem.checkRegression(measurements);

      expect(alert).toBeNull();
    });

    it('returns null when current gas does not exceed gasBefore of deployed optimization', async () => {
      vi.spyOn(alertSystem, 'loadOptimizations').mockResolvedValue([
        {
          name: 'caching-opt',
          status: 'deployed',
          gasBefore: 200,
          gasAfter: 150
        }
      ]);

      const measurements = [[{ cpuInstructions: 180 }]];
      const alert = await alertSystem.checkRegression(measurements);

      expect(alert).toBeNull();
    });

    it('returns a critical regression alert when current gas exceeds recentOpt.gasBefore', async () => {
      vi.spyOn(alertSystem, 'loadOptimizations').mockResolvedValue([
        {
          name: 'caching-opt',
          status: 'deployed',
          gasBefore: 200,
          gasAfter: 150
        }
      ]);

      const measurements = [[{ cpuInstructions: 250 }]];
      const alert = await alertSystem.checkRegression(measurements);

      expect(alert).not.toBeNull();
      expect(alert.severity).toBe('critical');
      expect(alert.type).toBe('regression');
      expect(alert.message).toBe('Regression detected: Gas higher than before optimization');
      expect(alert.details).toEqual({
        optimization: 'caching-opt',
        expected: 150,
        actual: 250
      });
      expect(alert.timestamp).toBeDefined();
    });
  });

  describe('checkAnomalies', () => {
    it('returns null when z-score is at or below 3', () => {
      // Measurements with low variance / uniform values (zScore = 0)
      const measurements = Array.from({ length: 10 }, () => [
        { cpuInstructions: 100 }
      ]);

      const alert = alertSystem.checkAnomalies(measurements);
      expect(alert).toBeNull();
    });

    it('returns a warning alert when z-score is above 3', () => {
      // Construct a distribution where the latest value has z-score > 3
      // e.g., 30 baseline measurements around 100, and latest measurement is 1000
      const baseline = Array.from({ length: 30 }, () => [
        { cpuInstructions: 100 }
      ]);
      const spike = [{ cpuInstructions: 1000 }];
      const measurements = [spike, ...baseline];

      const alert = alertSystem.checkAnomalies(measurements);

      expect(alert).not.toBeNull();
      expect(alert.severity).toBe('warning');
      expect(alert.type).toBe('anomaly');
      expect(alert.message).toBe('Anomaly detected: Gas cost deviates significantly');
      expect(alert.details).toBeDefined();
      expect(alert.details.current).toBe(1000);
      expect(parseFloat(alert.details.zScore)).toBeGreaterThan(3);
      expect(alert.timestamp).toBeDefined();
    });
  });
});
