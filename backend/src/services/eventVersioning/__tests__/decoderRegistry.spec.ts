import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeEvent,
  isKnownTopic,
  kindForTopic,
  type RawStellarEvent,
} from "../decoderRegistry";

function makeEvent(overrides: Partial<RawStellarEvent> = {}): RawStellarEvent {
  return {
    type: "contract",
    ledger: 42,
    ledger_close_time: "2026-09-26T12:00:00.000Z",
    contract_id: "CABC",
    id: "event-1",
    paging_token: "42-1",
    topic: ["tok_reg", "GASSET"],
    value: {
      creator: "GCREATOR",
      name: "Example Token",
      symbol: "EXT",
      decimals: "7",
      initial_supply: "1000000",
    },
    in_successful_contract_call: true,
    transaction_hash: "tx-123",
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("decodeEvent", () => {
  it("normalizes a recognized token event and coerces numeric fields", () => {
    const decoded = decodeEvent(makeEvent());

    expect(decoded).toMatchObject({
      kind: "token_created",
      tokenAddress: "GASSET",
      creator: "GCREATOR",
      decimals: 7,
      initialSupply: "1000000",
      txHash: "tx-123",
      ledger: 42,
      contractId: "CABC",
    });
    expect(decoded.timestamp).toEqual(new Date("2026-09-26T12:00:00.000Z"));
  });

  it("returns an unknown event and logs when the topic is not registered", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(decodeEvent(makeEvent({ topic: ["future_topic"] }))).toMatchObject({
      kind: "unknown",
      topic: "future_topic",
      ledger: 42,
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("topic lookup helpers", () => {
  it("reports known and unknown topics", () => {
    expect(isKnownTopic("tok_reg")).toBe(true);
    expect(isKnownTopic("future_topic")).toBe(false);
  });

  it("returns the canonical kind or null for an unknown topic", () => {
    expect(kindForTopic("prop_cr_v1")).toBe("proposal_created");
    expect(kindForTopic("future_topic")).toBeNull();
  });
});