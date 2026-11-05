import { describe, expect, it } from 'vitest';
import {
  BpsError,
  completeStep,
  createFinishingPlan,
  finishingProgress,
  InvalidArgumentError,
  InvalidFinishingTransitionError,
  skipStep,
  startStep,
  type FinishingPlan,
  type FinishingStepInput,
} from '../src/index.js';

const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-01T11:00:00.000Z';
const T3 = '2026-03-01T12:00:00.000Z';

const STEPS: readonly FinishingStepInput[] = [{ kind: 'laminate', label: 'matte' }, { kind: 'cut' }, { kind: 'grommet' }];

function plan(steps: readonly FinishingStepInput[] = STEPS): FinishingPlan {
  return createFinishingPlan('job-1', steps, T0);
}

describe('createFinishingPlan', () => {
  it('builds ordered pending steps for a job', () => {
    const p = plan();
    expect(p).toMatchObject({ jobId: 'job-1', createdAt: T0, updatedAt: T0 });
    expect(p.steps.map((s) => [s.index, s.kind, s.status])).toEqual([
      [0, 'laminate', 'pending'],
      [1, 'cut', 'pending'],
      [2, 'grommet', 'pending'],
    ]);
    expect(p.steps[0]?.label).toBe('matte');
    expect(p.steps[1]).not.toHaveProperty('label');
  });

  it('accepts every step kind, with a label for other', () => {
    const p = plan([
      { kind: 'laminate' },
      { kind: 'mount' },
      { kind: 'cut' },
      { kind: 'weed' },
      { kind: 'hem' },
      { kind: 'grommet' },
      { kind: 'other', label: '  pole pocket ' },
    ]);
    expect(p.steps).toHaveLength(7);
    expect(p.steps[6]).toMatchObject({ kind: 'other', label: 'pole pocket' });
  });

  it('rejects bad input', () => {
    expect(() => plan([{ kind: 'other' }])).toThrow(InvalidArgumentError);
    expect(() => plan([{ kind: 'other', label: '   ' }])).toThrow(InvalidArgumentError);
    expect(() => plan([])).toThrow(InvalidArgumentError);
    expect(() => createFinishingPlan(' ', STEPS, T0)).toThrow(InvalidArgumentError);
    expect(() => createFinishingPlan('job-1', STEPS, 'yesterday')).toThrow(InvalidArgumentError);
    expect(() => createFinishingPlan('job-1', STEPS, '2026-13-45T99:00:00Z')).toThrow(InvalidArgumentError);
  });
});

describe('step transitions', () => {
  it('pending -> in_progress -> done records actor and timestamps', () => {
    const p0 = plan();
    const p1 = startStep(p0, 0, 'ana', T1);
    expect(p1.steps[0]).toMatchObject({ status: 'in_progress', startedBy: 'ana', startedAt: T1 });
    expect(p1.updatedAt).toBe(T1);

    const p2 = completeStep(p1, 0, 'ben', T2);
    expect(p2.steps[0]).toMatchObject({
      status: 'done',
      startedBy: 'ana',
      startedAt: T1,
      completedBy: 'ben',
      completedAt: T2,
    });
    expect(p2.updatedAt).toBe(T2);
  });

  it('pending -> skipped records actor, time and reason', () => {
    const p = skipStep(plan(), 1, 'ana', T1, ' customer declined ');
    expect(p.steps[1]).toMatchObject({ status: 'skipped', skippedBy: 'ana', skippedAt: T1, skipReason: 'customer declined' });
  });

  it('in_progress -> skipped', () => {
    const p = skipStep(startStep(plan(), 0, 'ana', T1), 0, 'ana', T2, 'film jammed, sent unlaminated');
    expect(p.steps[0]).toMatchObject({ status: 'skipped', startedAt: T1, skippedAt: T2 });
  });

  it('never mutates the input plan', () => {
    const p0 = plan();
    const snapshot = { ...p0, steps: p0.steps.map((s) => ({ ...s })) };
    const p1 = startStep(p0, 0, 'ana', T1);
    completeStep(p1, 0, 'ana', T2);
    skipStep(p0, 1, 'ana', T1, 'not needed');
    expect(p0).toEqual(snapshot);
    expect(p1.steps[0]?.status).toBe('in_progress');
    expect(p1.steps[1]).toBe(p0.steps[1]);
  });

  it('rejects illegal moves with InvalidFinishingTransitionError', () => {
    const started = startStep(plan(), 0, 'ana', T1);
    const done = completeStep(started, 0, 'ana', T2);
    const skipped = skipStep(plan(), 0, 'ana', T1, 'n/a');

    expect(() => completeStep(plan(), 0, 'ana', T1)).toThrow(InvalidFinishingTransitionError);
    expect(() => startStep(started, 0, 'ana', T2)).toThrow(InvalidFinishingTransitionError);
    expect(() => startStep(done, 0, 'ana', T3)).toThrow(InvalidFinishingTransitionError);
    expect(() => completeStep(done, 0, 'ana', T3)).toThrow(InvalidFinishingTransitionError);
    expect(() => skipStep(done, 0, 'ana', T3, 'late')).toThrow(InvalidFinishingTransitionError);
    expect(() => startStep(skipped, 0, 'ana', T2)).toThrow(InvalidFinishingTransitionError);
    expect(() => completeStep(skipped, 0, 'ana', T2)).toThrow(InvalidFinishingTransitionError);
    expect(() => skipStep(skipped, 0, 'ana', T2, 'again')).toThrow(InvalidFinishingTransitionError);

    let caught: unknown;
    try {
      completeStep(plan(), 0, 'ana', T1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BpsError);
    expect(caught).toMatchObject({ code: 'INVALID_FINISHING_TRANSITION', details: { jobId: 'job-1', index: 0, status: 'pending' } });
  });
});

describe('ordering', () => {
  it('cannot start step n+1 while step n is pending or in progress', () => {
    const p = plan();
    expect(() => startStep(p, 1, 'ana', T1)).toThrow(InvalidFinishingTransitionError);
    const started = startStep(p, 0, 'ana', T1);
    expect(() => startStep(started, 1, 'ana', T2)).toThrow(InvalidFinishingTransitionError);
    expect(() => startStep(p, 2, 'ana', T1)).toThrow(/while step 0 is pending/);
  });

  it('can start step n+1 once step n is done or skipped', () => {
    const afterDone = completeStep(startStep(plan(), 0, 'ana', T1), 0, 'ana', T2);
    expect(startStep(afterDone, 1, 'ana', T3).steps[1]?.status).toBe('in_progress');

    const afterSkip = skipStep(plan(), 0, 'ana', T1, 'no film');
    expect(startStep(afterSkip, 1, 'ana', T2).steps[1]?.status).toBe('in_progress');
  });

  it('a skipped later step does not unblock an earlier pending one', () => {
    const p = skipStep(plan(), 1, 'ana', T1, 'not needed');
    expect(() => startStep(p, 2, 'ana', T2)).toThrow(/while step 0 is pending/);
  });
});

describe('validation', () => {
  it('rejects unknown step indexes', () => {
    expect(() => startStep(plan(), 3, 'ana', T1)).toThrow(InvalidArgumentError);
    expect(() => startStep(plan(), -1, 'ana', T1)).toThrow(InvalidArgumentError);
    expect(() => completeStep(plan(), 0.5, 'ana', T1)).toThrow(InvalidArgumentError);
    expect(() => skipStep(plan(), 9, 'ana', T1, 'x')).toThrow(InvalidArgumentError);
  });

  it('requires an actor, an ISO timestamp and a skip reason', () => {
    expect(() => startStep(plan(), 0, '', T1)).toThrow(InvalidArgumentError);
    expect(() => startStep(plan(), 0, 'ana', 'now')).toThrow(InvalidArgumentError);
    expect(() => completeStep(startStep(plan(), 0, 'ana', T1), 0, ' ', T2)).toThrow(InvalidArgumentError);
    expect(() => skipStep(plan(), 0, 'ana', T1, '')).toThrow(InvalidArgumentError);
    expect(() => skipStep(plan(), 0, 'ana', T1, '   ')).toThrow(InvalidArgumentError);
  });

  it('rejects timestamps that go back in time', () => {
    const started = startStep(plan(), 0, 'ana', T2);
    expect(() => completeStep(started, 0, 'ana', T1)).toThrow(InvalidArgumentError);
    expect(() => skipStep(started, 1, 'ana', T1, 'x')).toThrow(InvalidArgumentError);
    expect(completeStep(started, 0, 'ana', T2).steps[0]?.completedAt).toBe(T2);
  });

  it('accepts offset timestamps', () => {
    expect(startStep(plan(), 0, 'ana', '2026-03-01T11:30:00+01:00').steps[0]?.startedAt).toBe('2026-03-01T11:30:00+01:00');
  });
});

describe('finishingProgress', () => {
  it('counts statuses and points at the next unresolved step', () => {
    const fresh = finishingProgress(plan());
    expect(fresh).toMatchObject({ total: 3, pending: 3, inProgress: 0, done: 0, skipped: 0, isComplete: false });
    expect(fresh.nextStep?.index).toBe(0);

    const p1 = startStep(skipStep(plan(), 0, 'ana', T1, 'no film'), 1, 'ana', T2);
    const mid = finishingProgress(p1);
    expect(mid).toMatchObject({ pending: 1, inProgress: 1, done: 0, skipped: 1, isComplete: false });
    expect(mid.nextStep?.index).toBe(1);
  });

  it('is complete once every step is done or skipped', () => {
    let p = completeStep(startStep(plan(), 0, 'ana', T1), 0, 'ana', T1);
    p = completeStep(startStep(p, 1, 'ana', T2), 1, 'ana', T2);
    p = skipStep(p, 2, 'ana', T3, 'customer hangs it with tape');
    const progress = finishingProgress(p);
    expect(progress).toMatchObject({ total: 3, pending: 0, inProgress: 0, done: 2, skipped: 1, isComplete: true });
    expect(progress.nextStep).toBeUndefined();
  });
});
