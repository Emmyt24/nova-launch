import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { eventBus } from "../../eventBus";
import {
  callStellarDeploy,
  type TokenDeployInput,
} from "../../batchTokenDeployService";
import sagaCoordinator from "../../sagaCoordinator";
import {
  BATCH_DEPLOY_GOVERNANCE_SAGA_TYPE,
  createBatchDeployGovernanceSaga,
  deployTokensWithGovernanceRegistration,
  type BatchDeployGovernanceContext,
} from "../batchDeployGovernanceSaga";

vi.mock("../../sagaCoordinator", () => ({
  default: { registerSaga: vi.fn(), run: vi.fn() },
}));
vi.mock("../../../lib/prisma", () => ({ prisma: {} }));
vi.mock("../../batchTokenDeployService", () => ({
  callStellarDeploy: vi.fn(),
}));
vi.mock("../../eventBus", () => ({
  eventBus: { publish: vi.fn() },
}));

const inputs: TokenDeployInput[] = [
  {
    creator: "GCREATOR",
    name: "Example Token",
    symbol: "EXT",
    decimals: 7,
    initialSupply: "1000000",
  },
];

function makePrismaClient() {
  const token = {
    create: vi.fn(({ data }) =>
      Promise.resolve({ id: "token-1", ...data }),
    ),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const tokenGovernanceRegistration = {
    upsert: vi.fn().mockResolvedValue({ tokenId: "token-1" }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const $transaction = vi.fn((operations: Promise<unknown>[]) =>
    Promise.all(operations),
  );

  return {
    client: { token, tokenGovernanceRegistration, $transaction } as unknown as PrismaClient,
    token,
    tokenGovernanceRegistration,
    $transaction,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(callStellarDeploy).mockResolvedValue({ address: "GASSET" });
  vi.mocked(eventBus.publish).mockResolvedValue(undefined);
});

describe("createBatchDeployGovernanceSaga", () => {
  it("deploys tokens, registers governance, and compensates completed steps", async () => {
    const prisma = makePrismaClient();
    const definition = createBatchDeployGovernanceSaga(prisma.client);
    const context: BatchDeployGovernanceContext = { inputs };

    const deploymentPatch = await definition.steps[0].execute(context);
    expect(deploymentPatch).toMatchObject({
      deployedTokenIds: ["token-1"],
      deployedAddresses: ["GASSET"],
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(eventBus.publish).toHaveBeenCalledOnce();

    const deployedContext = { ...context, ...(deploymentPatch ?? {}) };
    await definition.steps[1].execute(deployedContext);
    expect(prisma.tokenGovernanceRegistration.upsert).toHaveBeenCalledWith({
      where: { tokenId: "token-1" },
      create: { tokenId: "token-1" },
      update: {},
    });

    await definition.steps[1].compensate(deployedContext);
    await definition.steps[0].compensate(deployedContext);
    expect(prisma.tokenGovernanceRegistration.deleteMany).toHaveBeenCalledWith({
      where: { tokenId: { in: ["token-1"] } },
    });
    expect(prisma.token.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["token-1"] } },
    });
  });

  it("does not write database records when an on-chain deployment fails", async () => {
    const prisma = makePrismaClient();
    const definition = createBatchDeployGovernanceSaga(prisma.client);
    vi.mocked(callStellarDeploy).mockRejectedValueOnce(new Error("RPC unavailable"));

    await expect(definition.steps[0].execute({ inputs })).rejects.toThrow(
      "RPC unavailable",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("deployTokensWithGovernanceRegistration", () => {
  it("delegates the requested inputs to the registered saga type", async () => {
    const result = {
      sagaId: "saga-1",
      status: "COMPLETED",
      context: { inputs },
    };
    vi.mocked(sagaCoordinator.run).mockResolvedValueOnce(result as never);

    await expect(deployTokensWithGovernanceRegistration(inputs)).resolves.toEqual(
      result,
    );
    expect(sagaCoordinator.run).toHaveBeenCalledWith(
      BATCH_DEPLOY_GOVERNANCE_SAGA_TYPE,
      { inputs },
    );
  });

  it("propagates a coordinator failure", async () => {
    vi.mocked(sagaCoordinator.run).mockRejectedValueOnce(
      new Error("coordinator unavailable"),
    );

    await expect(deployTokensWithGovernanceRegistration(inputs)).rejects.toThrow(
      "coordinator unavailable",
    );
  });
});