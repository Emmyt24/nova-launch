import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  observePinataRequestDuration,
  pinata429RetriesCounter,
  pinataInFlightGauge,
  pinataQueueDepthGauge,
  pinataRequestDurationHistogram,
  pinataThrottledCounter,
  recordPinataMetrics,
} from "../pinataMetrics";
import type { PinataQueueMetrics } from "../../ipfs/pinataQueue";

const metricMocks = vi.hoisted(() => ({
  gauges: [] as Array<{ set: ReturnType<typeof vi.fn> }>,
  counters: [] as Array<{ inc: ReturnType<typeof vi.fn> }>,
  histograms: [] as Array<{ observe: ReturnType<typeof vi.fn> }>,
}));

vi.mock("prom-client", () => ({
  Gauge: class MockGauge {
    set = vi.fn();
    constructor() {
      metricMocks.gauges.push(this);
    }
  },
  Counter: class MockCounter {
    inc = vi.fn();
    constructor() {
      metricMocks.counters.push(this);
    }
  },
  Histogram: class MockHistogram {
    observe = vi.fn();
    constructor() {
      metricMocks.histograms.push(this);
    }
  },
}));

vi.mock("../../metrics/index.js", () => ({ register: {} }));

function snapshot(
  overrides: Partial<PinataQueueMetrics> = {}
): PinataQueueMetrics {
  return {
    queueDepth: 0,
    inFlight: 0,
    throttledCount: 0,
    retried429Count: 0,
    avgLatencyMs: 0,
    ...overrides,
  };
}

describe("Pinata metrics", () => {
  beforeEach(() => {
    for (const metric of [...metricMocks.gauges, ...metricMocks.counters]) {
      const mock = "set" in metric ? metric.set : metric.inc;
      mock.mockClear();
    }
    for (const histogram of metricMocks.histograms) {
      histogram.observe.mockClear().mockReset();
    }
  });

  it("records queue gauges and only positive counter deltas", () => {
    recordPinataMetrics(
      snapshot({
        queueDepth: 4,
        inFlight: 2,
        throttledCount: 3,
        retried429Count: 1,
      })
    );
    recordPinataMetrics(
      snapshot({
        queueDepth: 1,
        inFlight: 0,
        throttledCount: 3,
        retried429Count: 0,
      })
    );
    recordPinataMetrics(snapshot({ throttledCount: 5, retried429Count: 4 }));

    expect(pinataQueueDepthGauge.set).toHaveBeenNthCalledWith(1, 4);
    expect(pinataQueueDepthGauge.set).toHaveBeenLastCalledWith(0);
    expect(pinataInFlightGauge.set).toHaveBeenNthCalledWith(1, 2);
    expect(pinataInFlightGauge.set).toHaveBeenLastCalledWith(0);
    expect(pinataThrottledCounter.inc).toHaveBeenNthCalledWith(1, 3);
    expect(pinataThrottledCounter.inc).toHaveBeenNthCalledWith(2, 2);
    expect(pinata429RetriesCounter.inc).toHaveBeenNthCalledWith(1, 1);
    expect(pinata429RetriesCounter.inc).toHaveBeenNthCalledWith(2, 3);
  });

  it("records request duration samples", () => {
    observePinataRequestDuration(275);

    expect(pinataRequestDurationHistogram.observe).toHaveBeenCalledWith(275);
  });

  it("propagates histogram errors rather than hiding failed observations", () => {
    const failure = new Error("metric registry unavailable");
    vi.mocked(pinataRequestDurationHistogram.observe).mockImplementation(() => {
      throw failure;
    });

    expect(() => observePinataRequestDuration(100)).toThrow(failure);
  });
});