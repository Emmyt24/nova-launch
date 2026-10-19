/**
 * Ordered, time-bounded graceful shutdown.
 *
 * Steps run sequentially (stop intake first, release connections last). A
 * failing step is logged and does not prevent later steps from running, and an
 * overall timeout forces exit so a hung step can never block termination.
 */

export interface ShutdownStep {
  name: string;
  run: () => Promise<void> | void;
}

export interface GracefulShutdownOptions {
  steps: ShutdownStep[];
  /** Hard upper bound for the whole sequence. */
  timeoutMs?: number;
  exit?: (code: number) => void;
  log?: Pick<Console, "log" | "error" | "warn">;
}

export function createGracefulShutdown(opts: GracefulShutdownOptions) {
  const { steps, timeoutMs = 30_000, exit = process.exit, log = console } = opts;
  let inProgress: Promise<void> | null = null;

  return (signal: string): Promise<void> => {
    if (inProgress) return inProgress;

    log.log(`${signal} received, shutting down gracefully`);
    let failed = false;

    const sequence = (async () => {
      for (const step of steps) {
        try {
          await step.run();
          log.log(`[shutdown] ${step.name} done`);
        } catch (err) {
          failed = true;
          log.error(`[shutdown] ${step.name} failed:`, err);
        }
      }
    })();

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    inProgress = Promise.race([sequence.then(() => "done" as const), timeout]).then(
      (outcome) => {
        clearTimeout(timer);
        if (outcome === "timeout") {
          log.warn(`[shutdown] timed out after ${timeoutMs}ms, forcing exit`);
          exit(1);
        } else {
          exit(failed ? 1 : 0);
        }
      }
    );
    return inProgress;
  };
}
