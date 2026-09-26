import { describe, expect, it, vi } from "vitest";
import {
  NetworkPartitionChaosEngine,
  PartitionProxy,
  SCENARIO_BACKEND_GATEWAY,
  type EventReplayBuffer,
  type ProjectionVerifier,
} from "../networkPartitionChaosEngine";

function makeBuffer(): EventReplayBuffer & { events: string[]; replayed: number } {
  const buffer = {
    events: [] as string[],
    replayed: 0,
    async getBufferedEvents() { return [...this.events]; },
    async bufferEvent(event: string) { this.events.push(event); },
    async replayAll() { this.replayed += this.events.length; this.events = []; },
    async bufferedCount() { return this.events.length; },
    async clear() { this.events = []; },
  };
  return buffer;
}

describe("PartitionProxy", () => {
  it("records a bidirectional partition and heals both routes", () => {
    const proxy = new PartitionProxy();
    const partition = proxy.partition({ from: "backend", to: "gateway", durationMs: 100 }, () => 42);

    expect(partition.startedAt).toBe(42);
    expect(proxy.isPartitioned("backend", "gateway")).toBe(true);
    expect(proxy.isPartitioned("gateway", "backend")).toBe(true);
    expect(proxy.activePartitions()).toHaveLength(2);
    partition.heal();
    expect(proxy.isPartitioned("backend", "gateway")).toBe(false);
    expect(proxy.activePartitions()).toEqual([]);
  });

  it("keeps an explicitly unidirectional partition one-way", () => {
    const proxy = new PartitionProxy();
    proxy.partition({ from: "backend", to: "gateway", bidirectional: false, durationMs: 100 }, () => 1);

    expect(proxy.isPartitioned("backend", "gateway")).toBe(true);
    expect(proxy.isPartitioned("gateway", "backend")).toBe(false);
  });
});

describe("NetworkPartitionChaosEngine", () => {
  it("buffers generated events, replays them, and verifies convergence", async () => {
    const buffer = makeBuffer();
    const verifier: ProjectionVerifier = { verifyConvergence: vi.fn().mockResolvedValue([]) };
    const proxy = new PartitionProxy();
    let now = 0;
    const engine = new NetworkPartitionChaosEngine(123, proxy, buffer, verifier, () => now++);

    const result = await engine.runPartitionScenario("backend-gateway", SCENARIO_BACKEND_GATEWAY, ["campaign-1"]);

    expect(result.eventsInFlight).toBe(15);
    expect(result.eventsDelivered).toBe(15);
    expect(result.zeroPermanentLoss).toBe(true);
    expect(result.projectionsConverged).toBe(true);
    expect(await buffer.bufferedCount()).toBe(0);
    expect(buffer.replayed).toBe(15);
    expect(verifier.verifyConvergence).toHaveBeenCalledWith(["campaign-1"]);
    expect(engine.getProxy()).toBe(proxy);
    expect(proxy.isPartitioned("backend", "gateway")).toBe(false);
  });

  it("reports non-convergence when the verifier still sees projection diffs", async () => {
    const verifier: ProjectionVerifier = {
      verifyConvergence: vi.fn().mockResolvedValue([{ id: "campaign-1", field: "balance" }]),
    };
    const engine = new NetworkPartitionChaosEngine(123, new PartitionProxy(), makeBuffer(), verifier, () => 0);

    const result = await engine.runPartitionScenario("backend-gateway", SCENARIO_BACKEND_GATEWAY, ["campaign-1"]);

    expect(result.projectionsConverged).toBe(false);
    expect(result.zeroPermanentLoss).toBe(true);
  });

  it("propagates replay-buffer failures", async () => {
    const buffer = makeBuffer();
    vi.spyOn(buffer, "bufferEvent").mockRejectedValue(new Error("buffer unavailable"));
    const verifier: ProjectionVerifier = { verifyConvergence: vi.fn().mockResolvedValue([]) };
    const proxy = new PartitionProxy();
    const engine = new NetworkPartitionChaosEngine(123, proxy, buffer, verifier);

    await expect(engine.runPartitionScenario("backend-gateway", SCENARIO_BACKEND_GATEWAY, []))
      .rejects.toThrow("buffer unavailable");
    expect(proxy.isPartitioned("backend", "gateway")).toBe(false);
  });
});