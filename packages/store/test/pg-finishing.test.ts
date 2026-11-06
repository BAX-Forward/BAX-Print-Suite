import {
  completeStep,
  createFinishingPlan,
  skipStep,
  startStep,
  type FinishingPlan,
} from '@bax-print/core';
import { describe, expect, it } from 'vitest';
import {
  InvalidFinishingPlanError,
  PgFinishingPlanRepository,
  type DbPort,
  type DbRow,
  type DbValue,
} from '../src/index.js';

const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-01T09:30:00.000Z';
const T2 = '2026-03-01T10:00:00.000Z';

/** A clock that advances one second per call. */
function steppingClock(start = Date.UTC(2026, 0, 1)): () => Date {
  let tick = 0;
  return () => new Date(start + 1000 * tick++);
}

function plan(jobId = 'job-1'): FinishingPlan {
  return createFinishingPlan(jobId, [{ kind: 'laminate' }, { kind: 'other', label: 'Box it' }], T0);
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** The exact statements PgFinishingPlanRepository issues, whitespace-normalized. */
const SQL = {
  selectByJobId: 'SELECT job_id, plan_json::text AS plan_json FROM finishing_plans WHERE job_id = ?',
  upsert: normalize(`INSERT INTO finishing_plans (job_id, plan_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (job_id) DO UPDATE SET
      plan_json = EXCLUDED.plan_json,
      updated_at = EXCLUDED.updated_at`),
  deleteByJobId: 'DELETE FROM finishing_plans WHERE job_id = ?',
  listAll:
    'SELECT job_id, plan_json::text AS plan_json FROM finishing_plans ORDER BY updated_at COLLATE "C", job_id COLLATE "C"',
};

interface StoredRow {
  /** Unchecked, so a test can store a malformed row. */
  readonly jobId: unknown;
  readonly planJson: unknown;
  readonly updatedAt: string;
}

interface Call {
  readonly sql: string;
  readonly params: readonly DbValue[];
}

function text(value: DbValue | undefined): string {
  if (typeof value !== 'string') throw new TypeError(`expected text, got ${String(value)}`);
  return value;
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function toPlanRow(row: StoredRow): DbRow {
  return { job_id: row.jobId, plan_json: row.planJson };
}

/** In-memory DbPort that answers only the statements the repository issues and records every call. */
class FakeDbPort implements DbPort {
  rows = new Map<string, StoredRow>();
  readonly calls: Call[] = [];

  query(sql: string, params: readonly DbValue[] = []): DbRow[] {
    const statement = this.record(sql, params);
    switch (statement) {
      case SQL.selectByJobId: {
        const row = this.rows.get(text(params[0]));
        return row ? [toPlanRow(row)] : [];
      }
      case SQL.listAll:
        return [...this.rows.entries()]
          .sort(([keyA, a], [keyB, b]) => compare(a.updatedAt, b.updatedAt) || compare(keyA, keyB))
          .map(([, row]) => toPlanRow(row));
      default:
        throw new Error(`fake port cannot answer query: ${statement}`);
    }
  }

  exec(sql: string, params: readonly DbValue[] = []): number {
    const statement = this.record(sql, params);
    switch (statement) {
      case SQL.upsert: {
        const [jobId, planJson, updatedAt] = params;
        const key = text(jobId);
        this.rows.set(key, { jobId: key, planJson: text(planJson), updatedAt: text(updatedAt) });
        return 1;
      }
      case SQL.deleteByJobId:
        return this.rows.delete(text(params[0])) ? 1 : 0;
      default:
        throw new Error(`fake port cannot run statement: ${statement}`);
    }
  }

  transaction<T>(work: () => T): T {
    const snapshot = new Map(this.rows);
    try {
      return work();
    } catch (error) {
      this.rows = snapshot;
      throw error;
    }
  }

  private record(sql: string, params: readonly DbValue[]): string {
    const statement = normalize(sql);
    this.calls.push({ sql: statement, params: [...params] });
    return statement;
  }
}

function openRepo(): { port: FakeDbPort; repo: PgFinishingPlanRepository } {
  const port = new FakeDbPort();
  return { port, repo: new PgFinishingPlanRepository(port, { now: steppingClock() }) };
}

function caught(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectInvalid(work: () => unknown): InvalidFinishingPlanError {
  const error = caught(work);
  expect(error).toBeInstanceOf(InvalidFinishingPlanError);
  if (!(error instanceof InvalidFinishingPlanError)) {
    throw new Error('expected an InvalidFinishingPlanError');
  }
  expect(error.code).toBe('FINISHING_PLAN_INVALID');
  return error;
}

describe('PgFinishingPlanRepository', () => {
  it('saves with one upsert in column order and round-trips step progress', () => {
    const { port, repo } = openRepo();
    const done = completeStep(startStep(plan(), 0, 'ana', T1), 0, 'ana', T2);

    expect(repo.save(done)).toEqual(done);
    expect(port.calls).toHaveLength(1);
    const [call] = port.calls;
    expect(call?.sql).toBe(SQL.upsert);
    expect(call?.params[0]).toBe('job-1');
    expect(JSON.parse(String(call?.params[1]))).toEqual(done);
    expect(call?.params[2]).toBe('2026-01-01T00:00:00.000Z');
    expect(repo.get('job-1')).toEqual(done);
    expect(port.calls.at(-1)).toStrictEqual({ sql: SQL.selectByJobId, params: ['job-1'] });
  });

  it('returns undefined, false and an empty list for a missing job', () => {
    const { repo } = openRepo();
    expect(repo.get('missing')).toBeUndefined();
    expect(repo.delete('missing')).toBe(false);
    expect(repo.listIncomplete()).toStrictEqual([]);
  });

  it('overwrites a plan on a second save', () => {
    const { port, repo } = openRepo();
    repo.save(plan());
    const skipped = skipStep(plan(), 0, 'ben', T1, 'not needed');
    repo.save(skipped);

    expect(repo.get('job-1')).toEqual(skipped);
    expect(port.rows.size).toBe(1);
    expect(port.rows.get('job-1')?.updatedAt).toBe('2026-01-01T00:00:01.000Z');
  });

  it('stores only the known plan fields', () => {
    const { port, repo } = openRepo();
    const withExtra = { ...plan(), note: 'not part of a plan' };
    const saved = repo.save(withExtra);

    expect(saved).toEqual(plan());
    expect(port.rows.get('job-1')?.planJson).not.toContain('note');
  });

  it('deletes a plan once', () => {
    const { port, repo } = openRepo();
    repo.save(plan());

    expect(repo.delete('job-1')).toBe(true);
    expect(port.calls.at(-1)).toStrictEqual({ sql: SQL.deleteByJobId, params: ['job-1'] });
    expect(repo.delete('job-1')).toBe(false);
    expect(repo.get('job-1')).toBeUndefined();
  });

  it('lists incomplete plans, least recently saved first', () => {
    const { port, repo } = openRepo();
    repo.save(plan('job-b'));
    const finished = skipStep(completeStep(startStep(plan('job-done'), 0, 'ana', T1), 0, 'ana', T1), 1, 'ana', T2, 'n/a');
    repo.save(finished);
    repo.save(startStep(plan('job-a'), 0, 'ana', T1));

    expect(repo.listIncomplete().map((p) => p.jobId)).toEqual(['job-b', 'job-a']);
    expect(port.calls.at(-1)).toStrictEqual({ sql: SQL.listAll, params: [] });

    // Saving again moves a plan to the end.
    repo.save(plan('job-b'));
    expect(repo.listIncomplete().map((p) => p.jobId)).toEqual(['job-a', 'job-b']);
    expect(repo.get('job-done')).toEqual(finished);
  });

  it('breaks updated_at ties by job id', () => {
    const port = new FakeDbPort();
    const repo = new PgFinishingPlanRepository(port, { now: () => new Date(T0) });
    repo.save(plan('job-c'));
    repo.save(plan('job-a'));
    repo.save(plan('job-b'));

    expect(repo.listIncomplete().map((p) => p.jobId)).toEqual(['job-a', 'job-b', 'job-c']);
  });

  it.each([
    ['a blank job id', (): FinishingPlan => ({ ...plan(), jobId: '  ' })],
    ['a bad timestamp', (): FinishingPlan => ({ ...plan(), updatedAt: 'yesterday' })],
    ['no steps', (): FinishingPlan => ({ ...plan(), steps: [] })],
    ['a step index out of place', (): FinishingPlan => ({ ...plan(), steps: [{ index: 3, kind: 'cut', status: 'pending' }] })],
    ['an "other" step without a label', (): FinishingPlan => ({ ...plan(), steps: [{ index: 0, kind: 'other', status: 'pending' }] })],
  ] as const)('rejects saving %s and issues no statement', (_label, build) => {
    const { port, repo } = openRepo();
    expectInvalid(() => repo.save(build()));
    expect(port.calls).toStrictEqual([]);
    expect(port.rows.size).toBe(0);
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
    const { port, repo } = openRepo();
    port.rows.set('job-1', { jobId: 'job-1', planJson, updatedAt: T0 });

    expect(expectInvalid(() => repo.get('job-1')).message).toContain('stored finishing plan for job job-1 is invalid');
    expectInvalid(() => repo.listIncomplete());
  });

  it.each([
    ['a non-text plan_json', { jobId: 'job-1', planJson: DOC }],
    ['a missing plan_json', { jobId: 'job-1', planJson: undefined }],
    ['a non-text job_id', { jobId: 7, planJson: JSON.stringify(DOC) }],
    ['a null job_id', { jobId: null, planJson: JSON.stringify(DOC) }],
  ] as const)('rejects a row with %s', (_label, columns) => {
    const { port, repo } = openRepo();
    port.rows.set('job-1', { ...columns, updatedAt: T0 });

    expect(expectInvalid(() => repo.get('job-1')).message).toBe('stored finishing plan row is malformed');
    expectInvalid(() => repo.listIncomplete());
  });

  it('reads a well-formed stored plan written outside the repository', () => {
    const { port, repo } = openRepo();
    port.rows.set('job-1', { jobId: 'job-1', planJson: JSON.stringify(DOC), updatedAt: T0 });

    expect(repo.get('job-1')).toEqual(DOC);
    expect(repo.listIncomplete()).toEqual([DOC]);
  });

  it('rolls back writes made inside a port transaction that throws', () => {
    const { port, repo } = openRepo();
    repo.save(plan('kept'));

    expect(() =>
      port.transaction(() => {
        repo.save(plan('lost'));
        repo.delete('kept');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(repo.get('lost')).toBeUndefined();
    expect(repo.get('kept')).toEqual(plan('kept'));

    port.transaction(() => repo.save(plan('committed')));
    expect(repo.get('committed')).toEqual(plan('committed'));
  });
});
