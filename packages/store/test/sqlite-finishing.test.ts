import {
  completeStep,
  createFinishingPlan,
  skipStep,
  startStep,
  type FinishingPlan,
} from '@bax-print/core';
import { describe, expect, it } from 'vitest';
import {
  appliedMigrations,
  InvalidFinishingPlanError,
  openDatabase,
  parseFinishingPlanJson,
  SqliteFinishingPlanRepository,
  type Database,
} from '../src/index.js';

const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-01T09:30:00.000Z';
const T2 = '2026-03-01T10:00:00.000Z';

/** A clock that advances one second per call. */
function steppingClock(start = Date.UTC(2026, 0, 1)): () => Date {
  let tick = 0;
  return () => new Date(start + 1000 * tick++);
}

function openRepo(): { db: Database; repo: SqliteFinishingPlanRepository } {
  const db = openDatabase();
  return { db, repo: new SqliteFinishingPlanRepository(db, { now: steppingClock() }) };
}

function plan(jobId = 'job-1'): FinishingPlan {
  return createFinishingPlan(jobId, [{ kind: 'laminate' }, { kind: 'other', label: 'Box it' }], T0);
}

function insertRaw(db: Database, jobId: string, planJson: string): void {
  db.prepare('INSERT INTO finishing_plans (job_id, plan_json, updated_at) VALUES (?, ?, ?)').run(jobId, planJson, T0);
}

function caught(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectInvalid(work: () => unknown): void {
  const error = caught(work);
  expect(error).toBeInstanceOf(InvalidFinishingPlanError);
  expect(error).toMatchObject({ code: 'FINISHING_PLAN_INVALID' });
}

describe('SqliteFinishingPlanRepository', () => {
  it('applies the finishing plans migration', () => {
    const db = openDatabase();
    expect(appliedMigrations(db)).toEqual([1, 2, 3, 4, 5, 6]);
    db.close();
  });

  it('round-trips a plan, including step progress', () => {
    const { db, repo } = openRepo();
    const started = startStep(plan(), 0, 'ana', T1);
    const done = completeStep(started, 0, 'ana', T2);

    expect(repo.save(done)).toEqual(done);
    expect(repo.get('job-1')).toEqual(done);
    expect(repo.get('missing')).toBeUndefined();
    db.close();
  });

  it('upserts by job id', () => {
    const { db, repo } = openRepo();
    repo.save(plan());
    const skipped = skipStep(plan(), 0, 'ben', T1, 'not needed');
    repo.save(skipped);

    expect(repo.get('job-1')).toEqual(skipped);
    expect(db.prepare('SELECT COUNT(*) AS n FROM finishing_plans').get()).toEqual({ n: 1 });
    db.close();
  });

  it('stores only the known plan fields', () => {
    const { db, repo } = openRepo();
    const withExtra = { ...plan(), note: 'not part of a plan' };
    const saved = repo.save(withExtra);

    expect(saved).toEqual(plan());
    expect(JSON.stringify(repo.get('job-1'))).not.toContain('note');
    db.close();
  });

  it('deletes a plan', () => {
    const { db, repo } = openRepo();
    repo.save(plan());

    expect(repo.delete('job-1')).toBe(true);
    expect(repo.delete('job-1')).toBe(false);
    expect(repo.get('job-1')).toBeUndefined();
    db.close();
  });

  it('lists incomplete plans, least recently saved first', () => {
    const { db, repo } = openRepo();
    repo.save(plan('job-b'));
    const finished = skipStep(completeStep(startStep(plan('job-done'), 0, 'ana', T1), 0, 'ana', T1), 1, 'ana', T2, 'n/a');
    repo.save(finished);
    repo.save(startStep(plan('job-a'), 0, 'ana', T1));

    expect(repo.listIncomplete().map((p) => p.jobId)).toEqual(['job-b', 'job-a']);

    // Saving again moves a plan to the end.
    repo.save(plan('job-b'));
    expect(repo.listIncomplete().map((p) => p.jobId)).toEqual(['job-a', 'job-b']);
    expect(repo.get('job-done')).toEqual(finished);
    db.close();
  });

  it.each([
    ['a blank job id', (): FinishingPlan => ({ ...plan(), jobId: '  ' })],
    ['a bad timestamp', (): FinishingPlan => ({ ...plan(), updatedAt: 'yesterday' })],
    ['no steps', (): FinishingPlan => ({ ...plan(), steps: [] })],
    ['a step index out of place', (): FinishingPlan => ({ ...plan(), steps: [{ index: 3, kind: 'cut', status: 'pending' }] })],
    ['an "other" step without a label', (): FinishingPlan => ({ ...plan(), steps: [{ index: 0, kind: 'other', status: 'pending' }] })],
    [
      'a blank actor',
      (): FinishingPlan => ({
        ...plan(),
        steps: [{ index: 0, kind: 'cut', status: 'in_progress', startedBy: ' ', startedAt: T1 }],
      }),
    ],
    [
      'a bad step timestamp',
      (): FinishingPlan => ({
        ...plan(),
        steps: [{ index: 0, kind: 'cut', status: 'done', completedBy: 'ana', completedAt: 'later' }],
      }),
    ],
  ] as const)('rejects saving %s and writes nothing', (_label, build) => {
    const { db, repo } = openRepo();
    expectInvalid(() => repo.save(build()));
    expect(db.prepare('SELECT COUNT(*) AS n FROM finishing_plans').get()).toEqual({ n: 0 });
    db.close();
  });

  const STEP = { index: 0, kind: 'cut', status: 'pending' };
  const DOC = { jobId: 'job-1', createdAt: T0, updatedAt: T0, steps: [STEP] };

  it.each([
    ['JSON that does not parse', '{jobId'],
    ['JSON that is null', 'null'],
    ['a plan for another job', JSON.stringify({ ...DOC, jobId: 'job-2' })],
    ['steps that are not an array', JSON.stringify({ ...DOC, steps: {} })],
    ['an unknown kind', JSON.stringify({ ...DOC, steps: [{ ...STEP, kind: 'fold' }] })],
    ['an unknown status', JSON.stringify({ ...DOC, steps: [{ ...STEP, status: 'paused' }] })],
    ['a non-string optional field', JSON.stringify({ ...DOC, steps: [{ ...STEP, label: null }] })],
    ['a step that is not an object', JSON.stringify({ ...DOC, steps: ['cut'] })],
  ] as const)('rejects reading a stored plan with %s', (_label, planJson) => {
    const { db, repo } = openRepo();
    insertRaw(db, 'job-1', planJson);

    expectInvalid(() => repo.get('job-1'));
    expectInvalid(() => repo.listIncomplete());
    db.close();
  });

  it('reads a well-formed stored plan written outside the repository', () => {
    const { db, repo } = openRepo();
    insertRaw(db, 'job-1', JSON.stringify(DOC));

    expect(repo.get('job-1')).toEqual(DOC);
    expect(repo.listIncomplete()).toEqual([DOC]);
    db.close();
  });
});

describe('parseFinishingPlanJson', () => {
  it('parses a plan and checks the expected job id', () => {
    const text = JSON.stringify(plan());
    expect(parseFinishingPlanJson(text)).toEqual(plan());
    expect(parseFinishingPlanJson(text, 'job-1')).toEqual(plan());
    expectInvalid(() => parseFinishingPlanJson(text, 'job-2'));
  });
});
