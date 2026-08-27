/**
 * Pins PROJECTION_LAG_THRESHOLDS and determineThresholdStatus's boundary
 * behavior to the values documented in the projectionLagThresholds.ts
 * module docblock (WARNING 30-60s, CRITICAL > 60s), so the doc and the
 * constants can't silently drift apart again.
 */

import { describe, it, expect } from "vitest";
import {
  PROJECTION_LAG_THRESHOLDS,
  determineThresholdStatus,
} from "../projectionLagThresholds";

describe("PROJECTION_LAG_THRESHOLDS — matches the documented values", () => {
  it("pins WARNING to 30s and CRITICAL to 60s, as documented", () => {
    expect(PROJECTION_LAG_THRESHOLDS.WARNING).toBe(30000);
    expect(PROJECTION_LAG_THRESHOLDS.CRITICAL).toBe(60000);
  });

  it("returns 'healthy' just under the documented 30s WARNING boundary", () => {
    expect(determineThresholdStatus(29999, "default")).toBe("healthy");
  });

  it("returns 'warning' at the documented 30s lower boundary", () => {
    expect(determineThresholdStatus(30000, "default")).toBe("warning");
  });

  it("returns 'warning' just under the documented 60s CRITICAL boundary", () => {
    expect(determineThresholdStatus(59999, "default")).toBe("warning");
  });

  it("returns 'critical' at the documented 60s boundary", () => {
    expect(determineThresholdStatus(60000, "default")).toBe("critical");
  });
});
