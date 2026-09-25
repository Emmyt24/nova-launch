import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";

// ---------------------------------------------------------------------------
// Fake Horizon ledger stream
// ---------------------------------------------------------------------------
const streamState = vi.hoisted(() => ({
  streamCalls: 0,
  stopCalls: 0,
  onmessage: null as ((ledger: { sequence: number }) => void) | null,
}));

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<any>("@stellar/stellar-sdk");

  class FakeHorizonServer {
    ledgers() {
      return {
        order: () => ({
          cursor: () => ({
            stream: (opts: { onmessage: (ledger: { sequence: number }) => void }) => {
              streamState.streamCalls += 1;
              streamState.onmessage = opts.onmessage;
              return () => {
                streamState.stopCalls += 1;
              };
            },
          }),
        }),
      };
    }

    loadAccount = vi.fn();
  }

  class FakeSorobanServer {}

  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: FakeHorizonServer },
    rpc: { ...actual.rpc, Server: FakeSorobanServer },
  };
});

import { StellarService } from "../stellar.service";

function createService(): StellarService {
  const configService = { get: vi.fn().mockReturnValue(undefined) } as unknown as ConfigService;
  return new StellarService(configService);
}

describe("StellarService ledger-close subscription", () => {
  beforeEach(() => {
    streamState.streamCalls = 0;
    streamState.stopCalls = 0;
    streamState.onmessage = null;
  });

  it("starts the ledger-close subscription on module init", () => {
    const service = createService();

    service.onModuleInit();

    expect(streamState.streamCalls).toBe(1);
    expect(streamState.onmessage).toBeTypeOf("function");

    service.onModuleDestroy();
  });

  it("invalidates cached sequence numbers when a ledger closes", () => {
    const service = createService();
    service.onModuleInit();

    const cache = (service as any).sequenceCache;
    const accountId = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    cache.set(accountId, "100");
    expect(cache.get(accountId)).toBe("100");

    streamState.onmessage!({ sequence: 1 });

    expect(cache.get(accountId)).toBeNull();

    service.onModuleDestroy();
  });

  it("stops the subscription cleanly on module destroy", () => {
    const service = createService();
    service.onModuleInit();

    service.onModuleDestroy();

    expect(streamState.stopCalls).toBe(1);

    // A second destroy must not attempt to stop an already-stopped stream
    service.onModuleDestroy();
    expect(streamState.stopCalls).toBe(1);
  });
});
