/**
 * Network-Partition Chaos Framework Tests (#1629)
 *
 * Covers three canonical partition scenarios:
 *   1. contract RPC ↔ backend
 *   2. backend ↔ gateway
 *   3. contract RPC ↔ gateway
 *
 * For each scenario the test verifies:
 *   - zeroPermanentLoss === true  (no events lost after healing + replay)
 *   - projectionsConverged === true  (all projections reconverge)
 */

import { describe, it, expect } from "vitest";

import {
  NetworkPartitionChaosEngine,
  PartitionProxy,
  PartitionScenarioResult,
  SCENARIO_CONTRACT_BACKEND,
  SCENARIO_BACKEND_GATEWAY,
  SCENARIO_CONTRACT_GATEWAY,
  type EventReplayBuffer,
  type ProjectionVerifier,
} from "../../services/networkPartitionChaosEngine";

// ─── Injectable test doubles ──────────────────────────────────────────────────

class InMemoryEventReplayBuffer implements EventReplayBuffer {
  private events: string[] = [];
  private replayed = 0;

  fill(count: number): void {
    for (let i = 0; i < count; i++) {
      this.events.push(`event-${i}`);
    }
  }

  async getBufferedEvents(): Promise<string[]> { return [...this.events]; }
  async replayAll(): Promise<void> { this.replayed += this.events.length; this.events = []; }
  async bufferedCount(): Promise<number> { return this.events.length; }
  async clear(): Promise<void> { this.events = []; }
  getReplayedCount(): number { return this.replayed; }
}

class StubProjectionVerifier implements ProjectionVerifier {
  async verifyConvergence(_ids: string[]): Promise<Array<{ id: string; field: string }>> {
    return []; // immediate convergence in tests
  }
}

function buildEngine(seed: number, bufferFill = 5) {
  const buffer = new InMemoryEventReplayBuffer();
  buffer.fill(bufferFill);
  const verifier = new StubProjectionVerifier();
  const proxy = new PartitionProxy();
  let t = 0;
  const clock = () => t++;
  const engine = new NetworkPartitionChaosEngine(seed, proxy, buffer, verifier, clock);
  return { engine, buffer, proxy };
}

const PROJECTION_IDS = ["campaign-1", "campaign-2", "campaign-3"];

async function assertClean(result: PartitionScenarioResult): Promise<void> {
  expect(result.zeroPermanentLoss).toBe(true);
  expect(result.projectionsConverged).toBe(true);
  expect(result.error).toBeUndefined();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Network-Partition Chaos Framework (#1629)", () => {

  describe("PartitionProxy", () => {
    it("blocks and unblocks bidirectional traffic", () => {
      const proxy = new PartitionProxy();
      const { heal } = proxy.partition({ from: "contract_rpc", to: "backend", durationMs: 1000 }, Date.now);
      expect(proxy.isPartitioned("contract_rpc", "backend")).toBe(true);
      expect(proxy.isPartitioned("backend", "contract_rpc")).toBe(true);
      heal();
      expect(proxy.isPartitioned("contract_rpc", "backend")).toBe(false);
    });

    it("unidirectional partition only blocks one direction", () => {
      const proxy = new PartitionProxy();
      const { heal } = proxy.partition({ from: "contract_rpc", to: "backend", bidirectional: false, durationMs: 1000 }, Date.now);
      expect(proxy.isPartitioned("contract_rpc", "backend")).toBe(true);
      expect(proxy.isPartitioned("backend", "contract_rpc")).toBe(false);
      heal();
    });

    it("tracks active partition keys", () => {
      const proxy = new PartitionProxy();
      proxy.partition({ from: "backend", to: "gateway", durationMs: 1000 }, Date.now);
      expect(proxy.activePartitions()).toHaveLength(2);
    });
  });

  describe("Scenario 1: contract_rpc ↔ backend", () => {
    it("heals with zero permanent loss and full convergence", async () => {
      const { engine } = buildEngine(12345, 8);
      const result = await engine.runPartitionScenario("contract_rpc↔backend", SCENARIO_CONTRACT_BACKEND, PROJECTION_IDS);
      await assertClean(result);
    });

    it("partition is cleared after scenario completes", async () => {
      const { engine, proxy } = buildEngine(99999, 3);
      await engine.runPartitionScenario("contract_rpc↔backend", SCENARIO_CONTRACT_BACKEND, PROJECTION_IDS);
      expect(proxy.isPartitioned("contract_rpc", "backend")).toBe(false);
    });
  });

  describe("Scenario 2: backend ↔ gateway", () => {
    it("heals with zero permanent loss and full convergence", async () => {
      const { engine } = buildEngine(54321, 5);
      const result = await engine.runPartitionScenario("backend↔gateway", SCENARIO_BACKEND_GATEWAY, PROJECTION_IDS);
      await assertClean(result);
    });

    it("partition is cleared after healing", async () => {
      const { engine, proxy } = buildEngine(11111, 2);
      await engine.runPartitionScenario("backend↔gateway", SCENARIO_BACKEND_GATEWAY, PROJECTION_IDS);
      expect(proxy.isPartitioned("backend", "gateway")).toBe(false);
    });
  });

  describe("Scenario 3: contract_rpc ↔ gateway", () => {
    it("heals with zero permanent loss and full convergence", async () => {
      const { engine } = buildEngine(22222, 6);
      const result = await engine.runPartitionScenario("contract_rpc↔gateway", SCENARIO_CONTRACT_GATEWAY, PROJECTION_IDS);
      await assertClean(result);
    });

    it("partition is cleared after healing", async () => {
      const { engine, proxy } = buildEngine(33333, 4);
      await engine.runPartitionScenario("contract_rpc↔gateway", SCENARIO_CONTRACT_GATEWAY, PROJECTION_IDS);
      expect(proxy.isPartitioned("contract_rpc", "gateway")).toBe(false);
    });
  });

  describe("All three scenarios back-to-back", () => {
    it("all three scenarios pass with the same engine instance", async () => {
      const { engine } = buildEngine(44444, 4);
      for (const [name, spec] of [
        ["contract_rpc↔backend", SCENARIO_CONTRACT_BACKEND],
        ["backend↔gateway",      SCENARIO_BACKEND_GATEWAY],
        ["contract_rpc↔gateway", SCENARIO_CONTRACT_GATEWAY],
      ] as const) {
        const result = await engine.runPartitionScenario(name, spec, PROJECTION_IDS);
        expect(result.zeroPermanentLoss).toBe(true);
        expect(result.projectionsConverged).toBe(true);
      }
    });
  });

  describe("Buffered event replay", () => {
    it("replays all buffered events after healing", async () => {
      const { engine, buffer } = buildEngine(55555, 10);
      expect(await buffer.bufferedCount()).toBe(10);
      await engine.runPartitionScenario("contract_rpc↔backend", SCENARIO_CONTRACT_BACKEND, PROJECTION_IDS);
      expect(await buffer.bufferedCount()).toBe(0);
      expect(buffer.getReplayedCount()).toBeGreaterThan(0);
    });

    it("zero buffered events still yields zeroPermanentLoss", async () => {
      const { engine } = buildEngine(66666, 0);
      const result = await engine.runPartitionScenario("backend↔gateway", SCENARIO_BACKEND_GATEWAY, PROJECTION_IDS);
      expect(result.zeroPermanentLoss).toBe(true);
    });
  });

  describe("Seeded randomness", () => {
    it.each([12345, 54321, 11111, 22222, 33333, 44444, 99999])(
      "seed %i produces zero permanent loss",
      async (seed) => {
        const { engine } = buildEngine(seed, 3);
        const result = await engine.runPartitionScenario("backend↔gateway", SCENARIO_BACKEND_GATEWAY, PROJECTION_IDS);
        expect(result.zeroPermanentLoss).toBe(true);
        expect(result.projectionsConverged).toBe(true);
      }
    );
  });
});
