/**
 * Bridges stream reconciliation divergence events to PagerDuty.
 *
 * streamReconciliation.ts publishes "stream.divergence_detected" on the
 * eventBus without knowing about PagerDuty; this module is the sole
 * subscriber that turns those events into P2 incidents.
 */

import { eventBus, EventBus, Subscription } from "./eventBus";
import { alertStreamDivergence } from "../lib/pagerduty";
import type { StreamDivergenceDetectedPayload } from "./streamReconciliation";

export function registerStreamDivergenceAlerting(
  bus: EventBus = eventBus
): Subscription {
  return bus.subscribe<StreamDivergenceDetectedPayload>(
    "stream.divergence_detected",
    async (event) => {
      await alertStreamDivergence(event.payload);
    }
  );
}

registerStreamDivergenceAlerting();
