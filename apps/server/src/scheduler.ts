import type { ArchiveService, PolicyRunResult } from '@bax-print/archive';

export const DEFAULT_SCHEDULER_INTERVAL_MS = 15 * 60_000;

export interface SchedulerRun {
  readonly policy: PolicyRunResult;
  readonly purged: readonly string[];
}

export interface ArchiveScheduler {
  /** Runs the archive policy and the trash purge once; overlapping calls share one run. */
  runOnce(): Promise<SchedulerRun>;
  stop(): void;
}

export interface SchedulerOptions {
  readonly intervalMs?: number;
  readonly onRun?: (run: SchedulerRun) => void;
  readonly onError?: (error: unknown) => void;
}

export function startArchiveScheduler(service: ArchiveService, options: SchedulerOptions = {}): ArchiveScheduler {
  let running: Promise<SchedulerRun> | undefined;

  const runOnce = (): Promise<SchedulerRun> => {
    running ??= (async () => {
      try {
        const policy = await service.runArchivePolicy();
        const purged = await service.purgeExpired();
        const run = { policy, purged };
        options.onRun?.(run);
        return run;
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  const timer = setInterval(() => {
    runOnce().catch((error: unknown) => {
      (options.onError ?? ((e: unknown) => console.error('archive scheduler run failed', e)))(error);
    });
  }, options.intervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS);
  timer.unref();

  return {
    runOnce,
    stop: () => clearInterval(timer),
  };
}
