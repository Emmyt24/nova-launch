import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrismaClient,
  SagaCompensationStatus,
  SagaStatus,
} from "@prisma/client";
import { SagaCoordinator, type SagaDefinition } from "../sagaCoordinator";

function makePrisma() {
  return {
    sagaExecution: {
      create: vi.fn().mockResolvedValue({ id: "saga-1" }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaClient;
}

describe("SagaCoordinator", () => {
  let prisma: PrismaClient;
  let coordinator: SagaCoordinator;

  beforeEach(() => {
    prisma = makePrisma();
    coordinator = new SagaCoordinator(prisma);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs registered steps in order and merges their context patches", async () => {
    const firstExecute = vi.fn().mockResolvedValue({ tokenId: "token-1" });
    const secondExecute = vi.fn().mockResolvedValue({ registered: true });
    const definition: SagaDefinition<Record<string, unknown>> = {
      sagaType: "deploy-token",
      steps: [
        { name: "deploy", execute: firstExecute, compensate: vi.fn() },
        { name: "register", execute: secondExecute, compensate: vi.fn() },
      ],
    };
    coordinator.registerSaga(definition);

    const result = await coordinator.run("deploy-token", { issuer: "GISSUER" });

    expect(result).toEqual({
      sagaId: "saga-1",
      status: SagaStatus.COMPLETED,
      context: { issuer: "GISSUER", tokenId: "token-1", registered: true },
    });
    expect(firstExecute.mock.invocationCallOrder[0]).toBeLessThan(
      secondExecute.mock.invocationCallOrder[0],
    );
    expect(secondExecute).toHaveBeenCalledWith({ issuer: "GISSUER", tokenId: "token-1" });
    expect(prisma.sagaExecution.update).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "saga-1" },
      data: expect.objectContaining({ status: SagaStatus.COMPLETED }),
    }));
  });

  it("compensates completed steps in reverse order after a step fails", async () => {
    const compensationOrder: string[] = [];
    const first: SagaDefinition<Record<string, unknown>>["steps"][number] = {
      name: "first",
      execute: vi.fn().mockResolvedValue({ firstDone: true }),
      compensate: vi.fn(async () => { compensationOrder.push("first"); }),
    };
    const second: SagaDefinition<Record<string, unknown>>["steps"][number] = {
      name: "second",
      execute: vi.fn().mockResolvedValue({ secondDone: true }),
      compensate: vi.fn(async () => { compensationOrder.push("second"); }),
    };
    const failing: SagaDefinition<Record<string, unknown>>["steps"][number] = {
      name: "third",
      execute: vi.fn().mockRejectedValue(new Error("registration failed")),
      compensate: vi.fn(),
    };
    coordinator.registerSaga({ sagaType: "multi-step", steps: [first, second, failing] });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await coordinator.run("multi-step", {});

    expect(result.status).toBe(SagaStatus.COMPENSATED);
    expect(result.error).toBe("registration failed");
    expect(compensationOrder).toEqual(["second", "first"]);
    expect(failing.compensate).not.toHaveBeenCalled();
    expect(prisma.sagaExecution.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: SagaStatus.COMPENSATING,
        error: "registration failed",
      }),
    }));
  });

  it("rejects attempts to run an unregistered saga", async () => {
    await expect(coordinator.run("missing", {})).rejects.toThrow(
      'No saga definition registered for sagaType "missing"',
    );
    expect(prisma.sagaExecution.create).not.toHaveBeenCalled();
  });

  it("resumes running sagas from their persisted step and skips unknown definitions", async () => {
    const firstExecute = vi.fn();
    const resumedExecute = vi.fn().mockResolvedValue({ resumed: true });
    coordinator.registerSaga({
      sagaType: "recoverable",
      steps: [
        { name: "completed", execute: firstExecute, compensate: vi.fn() },
        { name: "pending", execute: resumedExecute, compensate: vi.fn() },
      ],
    });
    vi.mocked(prisma.sagaExecution.findMany).mockResolvedValue([
      {
        id: "saga-running",
        sagaType: "recoverable",
        status: SagaStatus.RUNNING,
        context: { created: true },
        currentStepIndex: 1,
        compensatedStepIndex: null,
      },
      {
        id: "saga-unknown",
        sagaType: "missing-definition",
        status: SagaStatus.RUNNING,
        context: {},
        currentStepIndex: 0,
        compensatedStepIndex: null,
      },
    ] as any);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(coordinator.recoverInterruptedSagas()).resolves.toBeUndefined();

    expect(firstExecute).not.toHaveBeenCalled();
    expect(resumedExecute).toHaveBeenCalledWith({ created: true });
    expect(prisma.sagaExecution.findMany).toHaveBeenCalledWith({
      where: { status: { in: [SagaStatus.RUNNING, SagaStatus.COMPENSATING] } },
    });
  });

  it("continues interrupted compensation from the persisted compensation index", async () => {
    const compensationOrder: string[] = [];
    coordinator.registerSaga({
      sagaType: "compensating",
      steps: [
        { name: "one", execute: vi.fn(), compensate: vi.fn(async () => { compensationOrder.push("one"); }) },
        { name: "two", execute: vi.fn(), compensate: vi.fn(async () => { compensationOrder.push("two"); }) },
      ],
    });
    vi.mocked(prisma.sagaExecution.findMany).mockResolvedValue([{
      id: "saga-compensating",
      sagaType: "compensating",
      status: SagaStatus.COMPENSATING,
      context: {},
      currentStepIndex: 2,
      compensatedStepIndex: 1,
    }] as any);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await coordinator.recoverInterruptedSagas();

    expect(compensationOrder).toEqual(["one"]);
    expect(prisma.sagaExecution.update).toHaveBeenLastCalledWith({
      where: { id: "saga-compensating" },
      data: {
        status: SagaStatus.COMPENSATED,
        compensationStatus: SagaCompensationStatus.COMPLETED,
      },
    });
  });
});