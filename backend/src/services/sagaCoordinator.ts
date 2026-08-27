/**
 * Distributed saga coordinator for multi-step, cross-contract operations.
 *
 * Some backend-orchestrated operations span multiple independent state
 * machines (e.g. an on-chain token deploy followed by a governance
 * registration) with no built-in all-or-nothing guarantee. A failure partway
 * through can otherwise leave partial state behind with no automated way to
 * detect or correct it.
 *
 * A saga models such an operation as an ordered sequence of steps, each with
 * a matching compensating (undo) action. Saga state — which step is next,
 * and the accumulated context produced by completed steps — is persisted to
 * the `SagaExecution` table after every step transition, so an in-flight
 * saga survives a process restart: `recoverInterruptedSagas()` resumes a
 * `RUNNING` saga forward from its last completed step, or continues a
 * `COMPENSATING` saga's rollback from its last successfully undone step.
 *
 * Requirements this implementation is built around:
 *   - Compensation runs in strict reverse order of completed steps.
 *   - Compensations MUST be idempotent: the coordinator may re-invoke a
 *     step's `compensate()` for a step whose undo already completed (the
 *     narrow crash window between a compensation succeeding and that fact
 *     being persisted), and that must not double-undo. This is a property
 *     each step's `compensate()` implementation must provide — e.g. "delete
 *     if exists" / "delete where id in [...]" rather than a relative
 *     decrement — the coordinator cannot enforce this for arbitrary step
 *     logic, only guarantee it will call compensate() at-least-once per
 *     completed step, in reverse order.
 *   - Similarly, `execute()` may be re-invoked for the step in progress when
 *     a crash occurs between a step succeeding and that being persisted, so
 *     step actions should be safe to retry (standard saga-pattern
 *     assumption, not enforced by the coordinator).
 *
 * Issue: #1621
 */

import { PrismaClient, SagaStatus, SagaCompensationStatus } from "@prisma/client";

export interface SagaStepDefinition<TContext = Record<string, unknown>> {
  /** Human-readable step name, used in logs and for debugging persisted state. */
  name: string;
  /**
   * Performs the step's forward action. May return a partial context patch
   * that is merged into the saga's persisted context for subsequent steps
   * (and for the eventual compensation pass) to read.
   */
  execute(context: TContext): Promise<Partial<TContext> | void>;
  /**
   * Undoes this step's forward action. Must be idempotent (safe to call
   * more than once for the same context) — see module-level docs.
   */
  compensate(context: TContext): Promise<void>;
}

export interface SagaDefinition<TContext = Record<string, unknown>> {
  /** Unique identifier for this saga definition, persisted as `SagaExecution.sagaType`. */
  sagaType: string;
  steps: SagaStepDefinition<TContext>[];
}

export interface SagaResult<TContext = Record<string, unknown>> {
  sagaId: string;
  status: SagaStatus;
  context: TContext;
  error?: string;
}

export class SagaCoordinator {
  private readonly prisma: PrismaClient;
  private readonly definitions = new Map<string, SagaDefinition<any>>();

  constructor(prisma: PrismaClient = new PrismaClient()) {
    this.prisma = prisma;
  }

  /** Registers a saga definition so it can be run by `run()` and resumed by `recoverInterruptedSagas()`. */
  registerSaga<TContext>(definition: SagaDefinition<TContext>): void {
    this.definitions.set(definition.sagaType, definition);
  }

  private getDefinition(sagaType: string): SagaDefinition<any> {
    const definition = this.definitions.get(sagaType);
    if (!definition) {
      throw new Error(`No saga definition registered for sagaType "${sagaType}"`);
    }
    return definition;
  }

  /** Starts a new saga execution and runs it to completion or compensation. */
  async run<TContext extends Record<string, unknown>>(
    sagaType: string,
    initialContext: TContext,
  ): Promise<SagaResult<TContext>> {
    const definition = this.getDefinition(sagaType);

    const saga = await this.prisma.sagaExecution.create({
      data: {
        sagaType,
        stepCount: definition.steps.length,
        context: initialContext as any,
        status: SagaStatus.RUNNING,
        currentStepIndex: 0,
      },
    });

    return this.executeFrom(saga.id, definition, initialContext, 0);
  }

  /** Scans for sagas left `RUNNING` or `COMPENSATING` by a prior process (crash/restart) and resumes them. */
  async recoverInterruptedSagas(): Promise<void> {
    const interrupted = await this.prisma.sagaExecution.findMany({
      where: { status: { in: [SagaStatus.RUNNING, SagaStatus.COMPENSATING] } },
    });

    for (const saga of interrupted) {
      const definition = this.definitions.get(saga.sagaType);
      if (!definition) {
        console.error(
          `[SagaCoordinator] cannot recover saga ${saga.id}: no definition registered for sagaType "${saga.sagaType}"`,
        );
        continue;
      }

      console.log(
        `[SagaCoordinator] recovering saga ${saga.id} (type=${saga.sagaType}, status=${saga.status}, stepIndex=${saga.currentStepIndex})`,
      );

      try {
        if (saga.status === SagaStatus.RUNNING) {
          await this.executeFrom(saga.id, definition, saga.context as any, saga.currentStepIndex);
        } else {
          const resumeFrom = saga.compensatedStepIndex ?? saga.currentStepIndex;
          await this.runCompensation(saga.id, definition, saga.context as any, resumeFrom);
        }
      } catch (err) {
        console.error(`[SagaCoordinator] recovery failed for saga ${saga.id}:`, err);
      }
    }
  }

  /** Executes `definition.steps[fromIndex..]` in order, persisting progress after each step. */
  private async executeFrom<TContext extends Record<string, unknown>>(
    sagaId: string,
    definition: SagaDefinition<TContext>,
    context: TContext,
    fromIndex: number,
  ): Promise<SagaResult<TContext>> {
    let ctx = context;

    for (let i = fromIndex; i < definition.steps.length; i++) {
      const step = definition.steps[i];
      try {
        const patch = await step.execute(ctx);
        ctx = { ...ctx, ...(patch ?? {}) };

        await this.prisma.sagaExecution.update({
          where: { id: sagaId },
          data: { currentStepIndex: i + 1, context: ctx as any },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Saga step failed";
        console.error(`[SagaCoordinator] saga ${sagaId} step "${step.name}" (index ${i}) failed: ${message}`);

        await this.prisma.sagaExecution.update({
          where: { id: sagaId },
          data: {
            status: SagaStatus.COMPENSATING,
            error: message,
            context: ctx as any,
            currentStepIndex: i,
          },
        });

        await this.runCompensation(sagaId, definition, ctx, i);

        return { sagaId, status: SagaStatus.COMPENSATED, context: ctx, error: message };
      }
    }

    await this.prisma.sagaExecution.update({
      where: { id: sagaId },
      data: { status: SagaStatus.COMPLETED, completedAt: new Date(), context: ctx as any },
    });

    return { sagaId, status: SagaStatus.COMPLETED, context: ctx };
  }

  /**
   * Compensates completed steps `[failedIndex - 1 .. 0]` in reverse order.
   * `failedIndex` is the index of the step that failed (or, on recovery, the
   * step compensation was already in progress at) — that step's own
   * `compensate()` is not called, only steps that had actually completed.
   */
  private async runCompensation<TContext extends Record<string, unknown>>(
    sagaId: string,
    definition: SagaDefinition<TContext>,
    context: TContext,
    failedIndex: number,
  ): Promise<void> {
    for (let i = failedIndex - 1; i >= 0; i--) {
      const step = definition.steps[i];
      await step.compensate(context);

      await this.prisma.sagaExecution.update({
        where: { id: sagaId },
        data: { compensationStatus: SagaCompensationStatus.IN_PROGRESS, compensatedStepIndex: i },
      });
    }

    await this.prisma.sagaExecution.update({
      where: { id: sagaId },
      data: { status: SagaStatus.COMPENSATED, compensationStatus: SagaCompensationStatus.COMPLETED },
    });
  }
}

export const sagaCoordinator = new SagaCoordinator();
export default sagaCoordinator;
