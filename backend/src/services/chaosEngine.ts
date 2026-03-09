export interface ChaosScenario {
  seed: number;
  campaigns: number;
  executionsPerCampaign: number;
  faults: ChaosFault[];
}

export interface ChaosFault {
  type: "indexer_lag" | "duplicate_event" | "backend_outage" | "retry_storm";
  probability: number;
  duration?: number;
}

export interface ChaosResult {
  scenario: ChaosScenario;
  eventsProcessed: number;
  faultsInjected: number;
  finalConsistency: boolean;
  recoveryTime: number;
}

export class ChaosEngine {
  private seed: number;
  private random: () => number;

  constructor(seed: number) {
    this.seed = seed;
    this.random = this.seededRandom(seed);
  }

  private seededRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  shouldInjectFault(fault: ChaosFault): boolean {
    return this.random() < fault.probability;
  }

  generateInterleavedEvents(scenario: ChaosScenario) {
    const events: any[] = [];

    // Create campaigns
    for (let i = 1; i <= scenario.campaigns; i++) {
      events.push({
        type: "create",
        campaignId: i,
        timestamp: Date.now() + i * 100,
      });
    }

    // Generate executions
    for (let i = 1; i <= scenario.campaigns; i++) {
      for (let j = 1; j <= scenario.executionsPerCampaign; j++) {
        events.push({
          type: "execute",
          campaignId: i,
          executionId: `${i}-${j}`,
          amount: BigInt(Math.floor(this.random() * 10000) + 1000),
          timestamp: Date.now() + (i * 100 + j * 50),
        });
      }
    }

    // Shuffle events to simulate concurrent activity
    for (let i = events.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [events[i], events[j]] = [events[j], events[i]];
    }

    return events;
  }

  injectIndexerLag(events: any[], lagMs: number) {
    const laggedEvents = [...events];
    const lagCount = Math.floor(events.length * 0.2);

    for (let i = 0; i < lagCount; i++) {
      const idx = Math.floor(this.random() * laggedEvents.length);
      laggedEvents[idx] = {
        ...laggedEvents[idx],
        delayed: true,
        delayMs: lagMs,
      };
    }

    return laggedEvents;
  }

  injectDuplicateEvents(events: any[], duplicateRate: number) {
    const withDuplicates = [...events];
    const duplicateCount = Math.floor(events.length * duplicateRate);

    for (let i = 0; i < duplicateCount; i++) {
      const idx = Math.floor(this.random() * events.length);
      withDuplicates.push({ ...events[idx], duplicate: true });
    }

    return withDuplicates;
  }

  injectBackendOutage(events: any[], outageDuration: number) {
    const outageStart = Math.floor(this.random() * events.length * 0.5);
    const outageEnd = outageStart + Math.floor(events.length * 0.1);

    return events.map((event, idx) => ({
      ...event,
      outage: idx >= outageStart && idx < outageEnd,
    }));
  }

  injectRetryStorm(events: any[], retryRate: number) {
    const withRetries = [...events];
    const retryCount = Math.floor(events.length * retryRate);

    for (let i = 0; i < retryCount; i++) {
      const idx = Math.floor(this.random() * events.length);
      const retries = Math.floor(this.random() * 5) + 1;

      for (let j = 0; j < retries; j++) {
        withRetries.push({ ...events[idx], retry: j + 1 });
      }
    }

    return withRetries;
  }
}
