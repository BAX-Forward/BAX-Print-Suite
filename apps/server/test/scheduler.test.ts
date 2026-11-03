import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobNotFoundError, type ArchiveService, type PolicyRunResult } from '@bax-print/archive';
import { DAY_MS } from '@bax-print/core';
import { startArchiveScheduler, type ArchiveScheduler, type SchedulerRun } from '../src/scheduler.js';
import { createServerHarness, finishedJob } from './helpers.js';

const EMPTY_POLICY: PolicyRunResult = { archived: [], failed: [] };

/** Only the two methods the scheduler calls. */
function stubService(overrides: Partial<Pick<ArchiveService, 'runArchivePolicy' | 'purgeExpired'>> = {}): ArchiveService {
  return {
    runArchivePolicy: vi.fn(async () => EMPTY_POLICY),
    purgeExpired: vi.fn(async () => []),
    ...overrides,
  } as unknown as ArchiveService;
}

describe('archive scheduler', () => {
  let scheduler: ArchiveScheduler | undefined;
  afterEach(() => {
    scheduler?.stop();
    scheduler = undefined;
    vi.useRealTimers();
  });

  it('archives jobs past the default window and purges expired trash in one run', async () => {
    const h = createServerHarness();
    const old = await finishedJob(h, { name: 'Old order' });
    const binned = await finishedJob(h, { name: 'Binned order' });
    await h.archive.trash(binned);

    scheduler = startArchiveScheduler(h.archive);
    h.time.advance(14 * DAY_MS);
    expect(await scheduler.runOnce()).toEqual({ policy: EMPTY_POLICY, purged: [] });

    h.time.advance(16 * DAY_MS + 1);
    const run = await scheduler.runOnce();
    expect(run).toEqual({ policy: { archived: [old], failed: [] }, purged: [binned] });
    expect((await h.archive.getJob(old)).lifecycle).toBe('archived');
    await expect(h.archive.getJob(binned)).rejects.toThrow(JobNotFoundError);
  });

  it('shares one run between overlapping calls', async () => {
    let release: (value: PolicyRunResult) => void = () => undefined;
    const runArchivePolicy = vi
      .fn<() => Promise<PolicyRunResult>>(async () => EMPTY_POLICY)
      .mockImplementationOnce(() => new Promise<PolicyRunResult>((resolve) => (release = resolve)));
    const service = stubService({ runArchivePolicy });
    scheduler = startArchiveScheduler(service);

    const first = scheduler.runOnce();
    const second = scheduler.runOnce();
    expect(second).toBe(first);
    release(EMPTY_POLICY);
    await first;
    expect(runArchivePolicy).toHaveBeenCalledTimes(1);

    await scheduler.runOnce();
    expect(runArchivePolicy).toHaveBeenCalledTimes(2);
  });

  it('runs on its interval, reports runs and errors, and stops', async () => {
    vi.useFakeTimers();
    const runs: SchedulerRun[] = [];
    const errors: unknown[] = [];
    const failure = new Error('storage offline');
    const purgeExpired = vi.fn<() => Promise<string[]>>().mockResolvedValueOnce(['job-1']).mockRejectedValueOnce(failure);
    scheduler = startArchiveScheduler(stubService({ purgeExpired }), {
      intervalMs: 1_000,
      onRun: (run) => runs.push(run),
      onError: (error) => errors.push(error),
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual([{ policy: EMPTY_POLICY, purged: ['job-1'] }]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(errors).toEqual([failure]);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(purgeExpired).toHaveBeenCalledTimes(2);
  });
});
