/**
 * Projection Lag Threshold Configuration
 *
 * Defines operational thresholds for backend indexing lag detection.
 * Projection lag represents the delay between on-chain transaction confirmation
 * (ledger_close_time) and backend event processing.
 *
 * This is a core production risk for user trust, as users expect their token
 * deployments to be reflected immediately in the UI.
 *
 * Thresholds breakdown:
 * - NORMAL (< 5s): Expected ingestion latency. Typical Horizon + processing + DB
 * - WARNING (5-30s): Degradation detected. Operators should monitor closely
 * - CRITICAL (> 30s): Severe issue. Indexing falling behind on-chain progress
 *
 * Base calculations:
 * - Stellar ledgers close ~5 seconds apart
 * - Horizon API typically has events within 1-2 seconds of closure
 * - Database write should complete in milliseconds
 * - Expected lag: 2-5 seconds in normal operation
 *
 * Design decisions:
 * - Measured in milliseconds for precision
 * - Lag = now() - ledger_close_time
 * - Thresholds prevent false positives from network jitter (5s buffer before warning)
 * - Critical threshold is deliberately conservative to catch real issues early
 */

export interface ProjectionLagMetrics {
  currentLag: number; // milliseconds
  maxLagInWindow: number; // milliseconds (rolling window)
  averageLagInWindow: number; // milliseconds (rolling window)
  eventKind: string; // e.g., 'token_created', 'campaign_updated', etc.
  ledgerCloseTime: Date;
  processedAt: Date;
  thresholdStatus: 'healthy' | 'warning' | 'critical';
}

export interface ThresholdAlert {
  severity: 'warning' | 'critical';
  currentLag: number;
  threshold: number;
  eventKind: string;
  timestamp: Date;
  message: string;
}

export interface ThresholdSet {
  NORMAL: number;
  WARNING: number;
  CRITICAL: number;
}

/**
 * Projection Lag Thresholds (in milliseconds)
 */
export const PROJECTION_LAG_THRESHOLDS: ThresholdSet = {
  /**
   * Normal operating lag
   * Typical: 2-5 seconds for Horizon delivery + processing
   * Allows for normal network variability
   */
  NORMAL: 5000,

  /**
   * Warning threshold
   * Indicates potential degradation
   * Difference from normal = 5000ms (5s buffer)
   * Should trigger investigation but not immediate alarm
   */
  WARNING: 30000,

  /**
   * Critical threshold
   * Indicates significant indexing lag
   * Typically means backend is processing events > 30s after on-chain confirmation
   * Requires immediate operator attention
   */
  CRITICAL: 60000,
};

/**
 * Event-specific lag tolerances
 * Some event types may have legitimate reasons for higher lag
 * (e.g., webhook delivery, complex projection calculations)
 */
export const EVENT_LAG_TOLERANCES: Record<string, ThresholdSet> = {
  // Token events typically process quickly
  token_created: {
    NORMAL: 5000,
    WARNING: 25000,
    CRITICAL: 60000,
  },
  token_burned: {
    NORMAL: 5000,
    WARNING: 25000,
    CRITICAL: 60000,
  },
  token_admin_burned: {
    NORMAL: 5000,
    WARNING: 25000,
    CRITICAL: 60000,
  },

  // Governance events may have complex calculations
  proposal_created: {
    NORMAL: 8000,
    WARNING: 35000,
    CRITICAL: 90000,
  },
  vote_cast: {
    NORMAL: 8000,
    WARNING: 35000,
    CRITICAL: 90000,
  },

  // Campaign/Stream events
  campaign_started: {
    NORMAL: 6000,
    WARNING: 30000,
    CRITICAL: 75000,
  },
  vault_created: {
    NORMAL: 6000,
    WARNING: 30000,
    CRITICAL: 75000,
  },
};

/**
 * Calculate lag threshold for a given event kind
 * Falls back to default PROJECTION_LAG_THRESHOLDS if no specific tolerance exists
 */
export function getLagThresholdsForEventKind(
  eventKind: string
): ThresholdSet {
  return EVENT_LAG_TOLERANCES[eventKind] || PROJECTION_LAG_THRESHOLDS;
}

/**
 * Determine threshold status based on current lag
 */
export function determineThresholdStatus(
  lagMs: number,
  eventKind: string = 'default'
): 'healthy' | 'warning' | 'critical' {
  const thresholds = getLagThresholdsForEventKind(eventKind);

  if (lagMs >= thresholds.CRITICAL) {
    return 'critical';
  }
  if (lagMs >= thresholds.WARNING) {
    return 'warning';
  }
  return 'healthy';
}

/**
 * Generate threshold alert if lag exceeds warning or critical thresholds
 */
export function generateThresholdAlert(
  lagMs: number,
  eventKind: string,
  ledgerCloseTime: Date
): ThresholdAlert | null {
  const thresholds = getLagThresholdsForEventKind(eventKind);
  const status = determineThresholdStatus(lagMs, eventKind);

  if (status === 'critical') {
    return {
      severity: 'critical',
      currentLag: lagMs,
      threshold: thresholds.CRITICAL,
      eventKind,
      timestamp: new Date(),
      message: `Critical projection lag detected: ${eventKind} lag is ${lagMs}ms (threshold: ${thresholds.CRITICAL}ms)`,
    };
  }

  if (status === 'warning') {
    return {
      severity: 'warning',
      currentLag: lagMs,
      threshold: thresholds.WARNING,
      eventKind,
      timestamp: new Date(),
      message: `Warning: projection lag elevated: ${eventKind} lag is ${lagMs}ms (threshold: ${thresholds.WARNING}ms)`,
    };
  }

  return null;
}

/**
 * Rolling window aggregator for lag metrics
 * Maintains max and average lag over a time window
 */
export class LagWindow {
  private measurements: Array<{ lag: number; timestamp: Date }> = [];
  private windowSizeMs: number;

  constructor(windowSizeMs: number = 60000) {
    // 1 minute window by default
    this.windowSizeMs = windowSizeMs;
  }

  /**
   * Record a lag measurement
   */
  record(lag: number): void {
    const now = new Date();
    this.measurements.push({ lag, timestamp: now });
    this.pruneOldMeasurements();
  }

  /**
   * Remove measurements outside the window
   */
  private pruneOldMeasurements(): void {
    const now = Date.now();
    this.measurements = this.measurements.filter(
      (m) => now - m.timestamp.getTime() < this.windowSizeMs
    );
  }

  /**
   * Get maximum lag in window
   */
  getMaxLag(): number {
    if (this.measurements.length === 0) return 0;
    return Math.max(...this.measurements.map((m) => m.lag));
  }

  /**
   * Get average lag in window
   */
  getAverageLag(): number {
    if (this.measurements.length === 0) return 0;
    const total = this.measurements.reduce((sum, m) => sum + m.lag, 0);
    return total / this.measurements.length;
  }

  /**
   * Get count of measurements in window
   */
  getCount(): number {
    return this.measurements.length;
  }

  /**
   * Clear all measurements
   */
  clear(): void {
    this.measurements = [];
  }
}
