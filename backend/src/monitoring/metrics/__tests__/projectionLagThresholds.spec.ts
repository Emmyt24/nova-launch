/**
 * Tests for LagWindow — the rolling-window lag aggregator's pruning behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LagWindow } from "../projectionLagThresholds";

describe("LagWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("empty window", () => {
    it("getMaxLag returns 0 when no measurements recorded", () => {
      const window = new LagWindow();
      expect(window.getMaxLag()).toBe(0);
    });

    it("getAverageLag returns 0 when no measurements recorded", () => {
      const window = new LagWindow();
      expect(window.getAverageLag()).toBe(0);
    });

    it("getCount returns 0 when no measurements recorded", () => {
      const window = new LagWindow();
      expect(window.getCount()).toBe(0);
    });
  });

  describe("pruning at the window boundary", () => {
    it("prunes a measurement exactly at the window boundary", () => {
      const window = new LagWindow(60000);
      window.record(1000);

      // Advance exactly to the window size — `now - timestamp < windowSizeMs`
      // is false at the boundary, so the measurement must be pruned.
      vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
      window.record(2000);

      expect(window.getCount()).toBe(1);
      expect(window.getMaxLag()).toBe(2000);
    });

    it("retains a measurement just inside the window boundary", () => {
      const window = new LagWindow(60000);
      window.record(1000);

      vi.setSystemTime(new Date("2026-01-01T00:00:59.999Z"));
      window.record(2000);

      expect(window.getCount()).toBe(2);
      expect(window.getMaxLag()).toBe(2000);
    });

    it("prunes measurements older than the window while retaining recent ones", () => {
      const window = new LagWindow(60000);
      window.record(100); // t=0
      vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
      window.record(200); // t=30s
      vi.setSystemTime(new Date("2026-01-01T00:01:10.000Z")); // t=70s, prunes t=0 (70s old, > 60s window)
      window.record(300);

      expect(window.getCount()).toBe(2);
      expect(window.getMaxLag()).toBe(300);
      expect(window.getAverageLag()).toBe(250);
    });
  });

  describe("record / getMaxLag / getAverageLag / getCount", () => {
    it("tracks max lag across multiple measurements", () => {
      const window = new LagWindow(60000);
      window.record(500);
      window.record(1500);
      window.record(800);

      expect(window.getMaxLag()).toBe(1500);
    });

    it("computes the average lag across multiple measurements", () => {
      const window = new LagWindow(60000);
      window.record(100);
      window.record(200);
      window.record(300);

      expect(window.getAverageLag()).toBe(200);
    });

    it("counts only measurements still within the window", () => {
      const window = new LagWindow(10000);
      window.record(100); // t=0
      vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
      window.record(200); // t=5s
      vi.setSystemTime(new Date("2026-01-01T00:00:15.000Z")); // t=15s, prunes t=0 and t=5s (both >= 10s old)
      window.record(300);

      expect(window.getCount()).toBe(1);
    });

    it("accepts measurements added out of chronological order", () => {
      const window = new LagWindow(60000);
      vi.setSystemTime(new Date("2026-01-01T00:00:20.000Z"));
      window.record(200);
      vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
      window.record(100);

      expect(window.getCount()).toBe(2);
      expect(window.getMaxLag()).toBe(200);
      expect(window.getAverageLag()).toBe(150);
    });
  });

  describe("clear", () => {
    it("resets getMaxLag, getAverageLag and getCount to their empty-state values", () => {
      const window = new LagWindow();
      window.record(100);
      window.record(200);

      window.clear();

      expect(window.getMaxLag()).toBe(0);
      expect(window.getAverageLag()).toBe(0);
      expect(window.getCount()).toBe(0);
    });
  });
});
