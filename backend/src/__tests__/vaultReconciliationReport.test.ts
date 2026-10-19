/**
 * Vault event reconciliation report (#2208): on-chain vault state folded from
 * Horizon events, compared with the `Stream` projection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import {
  OnChainDataFetcher,
  OnChainProjectionVerifier,
  type OnChainVaultState,
} from "../services/consistency/onchainProjectionVerifier";

vi.mock("axios");

const CREATOR = "GCREATOR";
const RECIPIENT = "GRECIPIENT";

function makeStream(o: Record<string, unknown> = {}) {
  return {
    streamId: 1,
    creator: CREATOR,
    recipient: RECIPIENT,
    amount: BigInt(1000),
    status: "CREATED",
    ...o,
  };
}

function vault(o: Partial<OnChainVaultState> = {}): OnChainVaultState {
  return {
    streamId: 1,
    creator: CREATOR,
    recipient: RECIPIENT,
    amount: BigInt(1000),
    status: "CREATED",
    ...o,
  };
}

function makeVerifier(streams: unknown[]) {
  const prisma = {
    stream: { findMany: vi.fn().mockResolvedValue(streams) },
  } as any;
  return { verifier: new OnChainProjectionVerifier(prisma), prisma };
}

function mockVaultStates(states: OnChainVaultState[] | null) {
  vi.spyOn(OnChainDataFetcher.prototype, "fetchVaultStates").mockResolvedValue(
    states === null ? null : new Map(states.map((s) => [s.streamId, s]))
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(axios.get).mockReset();
});

describe("OnChainDataFetcher.fetchVaultStates", () => {
  it("returns null when no factory contract is configured", async () => {
    const prev = process.env.FACTORY_CONTRACT_ID;
    delete process.env.FACTORY_CONTRACT_ID;
    try {
      expect(await new OnChainDataFetcher({}).fetchVaultStates()).toBeNull();
    } finally {
      if (prev !== undefined) process.env.FACTORY_CONTRACT_ID = prev;
    }
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("folds create / claim / cancel events into per-vault state", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        _embedded: {
          records: [
            {
              topic: ["vlt_cr_v1", "1"],
              value: { stream_id: 1, creator: CREATOR, recipient: RECIPIENT, amount: "1000" },
            },
            {
              topic: ["vlt_cr_v1", "2"],
              value: { stream_id: 2, creator: CREATOR, recipient: RECIPIENT, amount: "50" },
            },
            { topic: ["vlt_cl_v1", "1"], value: { stream_id: 1 } },
            { topic: ["vlt_cn_v1", "2"], value: { stream_id: 2 } },
            // Unrelated and orphan events are ignored.
            { topic: ["tok_burn", "CTOKEN"], value: { amount: "5" } },
            { topic: ["vlt_cl_v1", "9"], value: { stream_id: 9 } },
          ],
        },
      },
    });

    const fetcher = new OnChainDataFetcher({ factoryContractId: "CFACTORY" });
    const states = await fetcher.fetchVaultStates();

    expect(states?.size).toBe(2);
    expect(states?.get(1)).toEqual(vault({ status: "CLAIMED" }));
    expect(states?.get(2)).toEqual(vault({ streamId: 2, amount: BigInt(50), status: "CANCELLED" }));
  });

  it("follows paging tokens until a short page", async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      topic: ["vlt_cr_v1", String(i)],
      value: { stream_id: i, creator: CREATOR, recipient: RECIPIENT, amount: "1" },
      paging_token: `pt-${i}`,
    }));
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { _embedded: { records: fullPage } } })
      .mockResolvedValueOnce({
        data: {
          _embedded: {
            records: [
              {
                topic: ["vlt_cr_v1", "200"],
                value: { stream_id: 200, creator: CREATOR, recipient: RECIPIENT, amount: "1" },
              },
            ],
          },
        },
      });

    const states = await new OnChainDataFetcher({ factoryContractId: "CFACTORY" }).fetchVaultStates();

    expect(states?.size).toBe(201);
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(vi.mocked(axios.get).mock.calls[1][1]?.params).toMatchObject({ cursor: "pt-199" });
  });

  it("returns null when Horizon fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(axios.get).mockRejectedValue(new Error("timeout"));
    const states = await new OnChainDataFetcher({ factoryContractId: "CFACTORY" }).fetchVaultStates();
    expect(states).toBeNull();
  });
});

describe("OnChainProjectionVerifier.buildVaultReconciliationReport", () => {
  it("reports consistent when projection matches chain", async () => {
    const { verifier } = makeVerifier([makeStream()]);
    mockVaultStates([vault()]);

    const report = await verifier.buildVaultReconciliationReport();

    expect(report.consistent).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(report.summary).toMatchObject({
      projectedVaults: 1,
      onChainVaults: 1,
      mismatchedVaults: 0,
      totalMismatches: 0,
    });
  });

  it("reports field mismatches with both values", async () => {
    const { verifier } = makeVerifier([makeStream({ status: "CREATED", amount: BigInt(999) })]);
    mockVaultStates([vault({ status: "CLAIMED" })]);

    const report = await verifier.buildVaultReconciliationReport();

    expect(report.consistent).toBe(false);
    expect(report.mismatches).toEqual(
      expect.arrayContaining([
        {
          streamId: 1,
          kind: "field_mismatch",
          field: "status",
          projectionValue: "CREATED",
          onChainValue: "CLAIMED",
          severity: "error",
        },
        {
          streamId: 1,
          kind: "field_mismatch",
          field: "amount",
          projectionValue: "999",
          onChainValue: "1000",
          severity: "error",
        },
      ])
    );
    expect(report.summary).toMatchObject({ mismatchedVaults: 1, fieldMismatches: 2 });
  });

  it("reports a creator / recipient mismatch", async () => {
    const { verifier } = makeVerifier([makeStream({ recipient: "GOTHER" })]);
    mockVaultStates([vault()]);

    const report = await verifier.buildVaultReconciliationReport();
    expect(report.mismatches).toEqual([
      expect.objectContaining({ field: "recipient", projectionValue: "GOTHER", onChainValue: RECIPIENT }),
    ]);
  });

  it("separates vaults missing on-chain from vaults missing in the projection", async () => {
    const { verifier } = makeVerifier([makeStream({ streamId: 1 })]);
    mockVaultStates([
      vault({ streamId: 2, status: "CREATED" }),
      vault({ streamId: 3, status: "CLAIMED" }),
    ]);

    const report = await verifier.buildVaultReconciliationReport();

    expect(report.mismatches).toEqual([
      expect.objectContaining({ streamId: 1, kind: "missing_on_chain", projectionValue: "exists", onChainValue: null, severity: "error" }),
      // Freshly created vaults may not be ingested yet → warning.
      expect.objectContaining({ streamId: 2, kind: "missing_in_projection", severity: "warning" }),
      expect.objectContaining({ streamId: 3, kind: "missing_in_projection", severity: "error" }),
    ]);
    expect(report.summary).toMatchObject({
      projectedVaults: 1,
      onChainVaults: 2,
      missingOnChain: 1,
      missingInProjection: 2,
      mismatchedVaults: 3,
    });
  });

  it("reports an error, not every vault as missing, when chain state is unavailable", async () => {
    const { verifier } = makeVerifier([makeStream()]);
    mockVaultStates(null);

    const report = await verifier.buildVaultReconciliationReport();

    expect(report.consistent).toBe(false);
    expect(report.mismatches).toEqual([]);
    expect(report.errors).toEqual(["Could not fetch on-chain vault state"]);
    expect(report.summary.errors).toBe(1);
  });

  it("captures projection read failures as errors", async () => {
    const prisma = { stream: { findMany: vi.fn().mockRejectedValue(new Error("db down")) } } as any;
    const verifier = new OnChainProjectionVerifier(prisma);
    mockVaultStates([]);

    const report = await verifier.buildVaultReconciliationReport();
    expect(report.errors[0]).toContain("db down");
  });
});
