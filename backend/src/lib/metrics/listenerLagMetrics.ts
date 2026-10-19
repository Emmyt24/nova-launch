/**
 * Prometheus metrics for Stellar event listener lag (#2200).
 *
 * Tracks the latest ledger reported by Horizon (chain head) against the
 * ledger of the most recently processed event, and exposes the difference
 * as a gauge so operators can alert when ingestion falls behind.
 *
 * Exported helpers
 * ────────────────
 *  listenerLagTracker.recordChainHead(ledger)       — latest ledger from Horizon
 *  listenerLagTracker.recordProcessedLedger(ledger) — ledger of a processed event
 *  listenerLagTracker.recordHeadFetchFailure()      — Horizon head lookup failed
 *  listenerLagTracker.snapshot()                    — current values (debug/tests)
 */

import { Counter, Gauge } from "prom-client";
import { register } from "./index";

// ── Gauges ───────────────────────────────────────────────────────────────────

export const listenerLatestLedgerGauge = new Gauge({
  name: "stellar_listener_latest_ledger",
  help: "Latest ledger sequence reported by Horizon (chain head).",
  registers: [register],
});

export const listenerProcessedLedgerGauge = new Gauge({
  name: "stellar_listener_processed_ledger",
  help: "Ledger sequence of the most recent event processed by the listener.",
  registers: [register],
});

export const listenerLedgerLagGauge = new Gauge({
  name: "stellar_listener_ledger_lag",
  help: "Number of ledgers the listener's processed ledger is behind the chain head.",
  registers: [register],
});

export const listenerLastHeadUpdateGauge = new Gauge({
  name: "stellar_listener_head_last_updated_timestamp_seconds",
  help: "Unix timestamp of the last successful chain head lookup.",
  registers: [register],
});

// ── Counters ─────────────────────────────────────────────────────────────────

export const listenerLedgersProcessedCounter = new Counter({
  name: "stellar_listener_ledgers_processed_total",
  help: "Total number of ledgers the listener's processed ledger has advanced by.",
  registers: [register],
});

export const listenerHeadFetchFailuresCounter = new Counter({
  name: "stellar_listener_head_fetch_failures_total",
  help: "Total number of failed chain head lookups against Horizon.",
  registers: [register],
});

// ── Tracker ──────────────────────────────────────────────────────────────────

export interface ListenerLagSnapshot {
  latestLedger: number | null;
  processedLedger: number | null;
  lag: number | null;
}

export class ListenerLagTracker {
  private latestLedger: number | null = null;
  private processedLedger: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  recordChainHead(ledger: number): void {
    if (!Number.isFinite(ledger) || ledger < 0) return;
    // The head never moves backwards; ignore stale responses from a lagging node.
    if (this.latestLedger !== null && ledger < this.latestLedger) return;

    this.latestLedger = ledger;
    listenerLatestLedgerGauge.set(ledger);
    listenerLastHeadUpdateGauge.set(Math.floor(this.now() / 1000));
    this.updateLag();
  }

  recordProcessedLedger(ledger: number): void {
    if (!Number.isFinite(ledger) || ledger < 0) return;

    if (this.processedLedger !== null) {
      if (ledger <= this.processedLedger) return;
      listenerLedgersProcessedCounter.inc(ledger - this.processedLedger);
    }

    this.processedLedger = ledger;
    listenerProcessedLedgerGauge.set(ledger);

    // An event ledger beyond the last known head means the head is stale.
    if (this.latestLedger === null || ledger > this.latestLedger) {
      this.latestLedger = ledger;
      listenerLatestLedgerGauge.set(ledger);
    }
    this.updateLag();
  }

  recordHeadFetchFailure(): void {
    listenerHeadFetchFailuresCounter.inc();
  }

  snapshot(): ListenerLagSnapshot {
    return {
      latestLedger: this.latestLedger,
      processedLedger: this.processedLedger,
      lag: this.computeLag(),
    };
  }

  /** Test-only: forget tracked ledgers. */
  reset(): void {
    this.latestLedger = null;
    this.processedLedger = null;
  }

  private computeLag(): number | null {
    if (this.latestLedger === null || this.processedLedger === null) return null;
    return Math.max(0, this.latestLedger - this.processedLedger);
  }

  private updateLag(): void {
    const lag = this.computeLag();
    if (lag !== null) listenerLedgerLagGauge.set(lag);
  }
}

export const listenerLagTracker = new ListenerLagTracker();
