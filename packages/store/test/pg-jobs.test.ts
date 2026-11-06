import { describe, expect, it } from 'vitest';
import type { Job } from '@bax-print/core';
import { PgJobRepository, type DbPort, type DbRow, type DbValue } from '../src/index.js';

const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-01T09:00:01.000Z';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Banner.pdf',
    status: 'received',
    priority: 50,
    hotFolderId: 'hf-1',
    sourceFiles: [{ name: 'Banner.pdf', sha256: 'a'.repeat(64), sizeBytes: 1234, storageKey: 'jobs/job-1/source/0-Banner.pdf' }],
    artifacts: [],
    ticket: { intent: { quantity: 2, finishedSize: { widthMm: 1000, heightMm: 500 } }, process: {} },
    tags: ['rush'],
    metadata: { customer: 'C-1' },
    createdAt: T0,
    updatedAt: T0,
    lifecycle: 'active',
    legalHold: false,
    ...overrides,
  };
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** The exact statements PgJobRepository issues, whitespace-normalized. */
const SQL = {
  selectById: 'SELECT doc FROM jobs WHERE id = ?',
  upsert: normalize(`INSERT INTO jobs (id, status, lifecycle, priority, hot_folder_id, source_sha256, created_at, updated_at, doc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      lifecycle = EXCLUDED.lifecycle,
      priority = EXCLUDED.priority,
      hot_folder_id = EXCLUDED.hot_folder_id,
      source_sha256 = EXCLUDED.source_sha256,
      updated_at = EXCLUDED.updated_at,
      doc = EXCLUDED.doc`),
  deleteById: 'DELETE FROM jobs WHERE id = ?',
  listAll: 'SELECT doc FROM jobs ORDER BY created_at, id',
  listByLifecycle: 'SELECT doc FROM jobs WHERE lifecycle = ? ORDER BY created_at, id',
};

interface StoredRow {
  readonly id: string;
  readonly status: string;
  readonly lifecycle: string;
  readonly priority: number;
  readonly hotFolderId: string | null;
  readonly sourceSha256: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Unchecked, so a test can store a malformed document. */
  readonly doc: unknown;
}

interface Call {
  readonly sql: string;
  readonly params: readonly DbValue[];
}

function text(value: DbValue | undefined): string {
  if (typeof value !== 'string') throw new TypeError(`expected text, got ${String(value)}`);
  return value;
}

function textOrNull(value: DbValue | undefined): string | null {
  return value === null ? null : text(value);
}

function integer(value: DbValue | undefined): number {
  if (typeof value !== 'number') throw new TypeError(`expected a number, got ${String(value)}`);
  return value;
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function toDocRows(rows: readonly StoredRow[]): DbRow[] {
  return [...rows]
    .sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id))
    .map((row) => ({ doc: row.doc }));
}

/** In-memory DbPort that answers only the statements the repository issues and records every call. */
class FakeDbPort implements DbPort {
  rows = new Map<string, StoredRow>();
  readonly calls: Call[] = [];

  query(sql: string, params: readonly DbValue[] = []): DbRow[] {
    const statement = this.record(sql, params);
    switch (statement) {
      case SQL.selectById: {
        const row = this.rows.get(text(params[0]));
        return row ? [{ doc: row.doc }] : [];
      }
      case SQL.listAll:
        return toDocRows([...this.rows.values()]);
      case SQL.listByLifecycle: {
        const lifecycle = text(params[0]);
        return toDocRows([...this.rows.values()].filter((row) => row.lifecycle === lifecycle));
      }
      default:
        throw new Error(`fake port cannot answer query: ${statement}`);
    }
  }

  exec(sql: string, params: readonly DbValue[] = []): number {
    const statement = this.record(sql, params);
    switch (statement) {
      case SQL.upsert: {
        const [id, status, lifecycle, priority, hotFolderId, sourceSha256, createdAt, updatedAt, doc] = params;
        const key = text(id);
        const existing = this.rows.get(key);
        // ON CONFLICT keeps the original created_at.
        this.rows.set(key, {
          id: key,
          status: text(status),
          lifecycle: text(lifecycle),
          priority: integer(priority),
          hotFolderId: textOrNull(hotFolderId),
          sourceSha256: textOrNull(sourceSha256),
          createdAt: existing?.createdAt ?? text(createdAt),
          updatedAt: text(updatedAt),
          doc: text(doc),
        });
        return 1;
      }
      case SQL.deleteById:
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

function storedRow(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id: 'bad',
    status: 'received',
    lifecycle: 'active',
    priority: 50,
    hotFolderId: null,
    sourceSha256: null,
    createdAt: T0,
    updatedAt: T0,
    doc: null,
    ...overrides,
  };
}

describe('PgJobRepository', () => {
  it('saves with one upsert in column order and round-trips the document', async () => {
    const port = new FakeDbPort();
    const repo = new PgJobRepository(port);
    const original = job({ pageCount: 1, pages: [{ index: 0, widthPt: 595, heightPt: 842 }] });

    await repo.save(original);

    expect(port.calls).toStrictEqual([
      {
        sql: SQL.upsert,
        params: ['job-1', 'received', 'active', 50, 'hf-1', 'a'.repeat(64), T0, T0, JSON.stringify(original)],
      },
    ]);
    expect(await repo.get('job-1')).toStrictEqual(original);
    expect(port.calls.at(-1)).toStrictEqual({ sql: SQL.selectById, params: ['job-1'] });
  });

  it('binds null for a job without a hot folder or source files', async () => {
    const port = new FakeDbPort();
    const repo = new PgJobRepository(port);
    const { hotFolderId: _unused, ...rest } = job({ sourceFiles: [] });

    await repo.save(rest);

    expect(port.calls[0]?.params.slice(4, 6)).toStrictEqual([null, null]);
    expect(await repo.get('job-1')).toStrictEqual(rest);
  });

  it('returns undefined and false for a missing job', async () => {
    const repo = new PgJobRepository(new FakeDbPort());
    expect(await repo.get('missing')).toBeUndefined();
    expect(await repo.delete('missing')).toBe(false);
    expect(await repo.list()).toStrictEqual([]);
  });

  it('overwrites a job on a second save', async () => {
    const port = new FakeDbPort();
    const repo = new PgJobRepository(port);
    await repo.save(job());
    await repo.save(job({ status: 'inspecting', updatedAt: T1 }));

    expect(await repo.get('job-1')).toMatchObject({ status: 'inspecting', updatedAt: T1, createdAt: T0 });
    expect(await repo.list()).toHaveLength(1);
    expect(port.rows.get('job-1')).toMatchObject({ status: 'inspecting', updatedAt: T1, createdAt: T0 });
  });

  it('filters list by lifecycle and orders by creation time, then id', async () => {
    const port = new FakeDbPort();
    const repo = new PgJobRepository(port);
    await repo.save(job({ id: 'c', createdAt: T1 }));
    await repo.save(job({ id: 'a', status: 'done', lifecycle: 'archived', archivedAt: T1 }));
    await repo.save(job({ id: 'b', createdAt: T1 }));

    expect((await repo.list()).map((j) => j.id)).toStrictEqual(['a', 'b', 'c']);
    expect(port.calls.at(-1)).toStrictEqual({ sql: SQL.listAll, params: [] });
    expect((await repo.list({ lifecycle: 'active' })).map((j) => j.id)).toStrictEqual(['b', 'c']);
    expect(port.calls.at(-1)).toStrictEqual({ sql: SQL.listByLifecycle, params: ['active'] });
    expect((await repo.list({ lifecycle: 'archived' })).map((j) => j.id)).toStrictEqual(['a']);
  });

  it('deletes a job once', async () => {
    const port = new FakeDbPort();
    const repo = new PgJobRepository(port);
    await repo.save(job());

    expect(await repo.delete('job-1')).toBe(true);
    expect(port.calls.at(-1)).toStrictEqual({ sql: SQL.deleteById, params: ['job-1'] });
    expect(await repo.delete('job-1')).toBe(false);
    expect(await repo.get('job-1')).toBeUndefined();
  });

  it('rejects rows whose doc is not a job document', async () => {
    const port = new FakeDbPort();
    const repo = new PgJobRepository(port);

    port.rows.set('bad', storedRow({ doc: 42 }));
    await expect(repo.get('bad')).rejects.toBeInstanceOf(TypeError);
    await expect(repo.list()).rejects.toBeInstanceOf(TypeError);

    for (const doc of ['null', '[]', '"job"', '{"name":"no id"}', '{"id":7}']) {
      port.rows.set('bad', storedRow({ doc }));
      await expect(repo.get('bad')).rejects.toBeInstanceOf(TypeError);
    }

    port.rows.set('bad', storedRow({ doc: 'not json' }));
    await expect(repo.get('bad')).rejects.toBeInstanceOf(SyntaxError);
  });

  it('round-trips a valid whiteInk and leaves an absent one absent (spec 038c)', async () => {
    const repo = new PgJobRepository(new FakeDbPort());
    const withWhite = job({ id: 'white', whiteInk: { mode: 'spot', threshold: 128, invert: true, separationName: 'White' } });
    await repo.save(withWhite);
    await repo.save(job({ id: 'plain' }));

    expect(await repo.get('white')).toStrictEqual(withWhite);
    const plain = await repo.get('plain');
    expect(plain).toStrictEqual(job({ id: 'plain' }));
    expect(plain !== undefined && 'whiteInk' in plain).toBe(false);
  });

  it.each([['yes'], [{ mode: 'x' }], [{ mode: 'flood', unknown: 1 }], [null]])(
    'reads a stored invalid whiteInk %j back with no whiteInk (spec 038c)',
    async (whiteInk) => {
      const port = new FakeDbPort();
      const repo = new PgJobRepository(port);
      port.rows.set('job-1', storedRow({ id: 'job-1', doc: JSON.stringify({ ...job(), whiteInk }) }));

      expect(await repo.get('job-1')).toStrictEqual(job());
      expect(await repo.list()).toStrictEqual([job()]);
    },
  );

  it('round-trips a valid screening, keeps whiteInk, and leaves an absent one absent (spec 039b)', async () => {
    const repo = new PgJobRepository(new FakeDbPort());
    const bayer = job({ id: 'bayer', screening: { kind: 'bayer', size: 2 } });
    const blue = job({
      id: 'blue',
      whiteInk: { mode: 'choke', chokePx: 2 },
      screening: { kind: 'blue-noise', size: 2, seed: 0 },
    });
    await repo.save(bayer);
    await repo.save(blue);
    await repo.save(job({ id: 'plain' }));

    expect(await repo.get('bayer')).toStrictEqual(bayer);
    expect(await repo.get('blue')).toStrictEqual(blue);
    const plain = await repo.get('plain');
    expect(plain).toStrictEqual(job({ id: 'plain' }));
    expect(plain !== undefined && 'screening' in plain).toBe(false);
  });

  it.each<unknown>([
    'yes',
    { kind: 'x' },
    { kind: 'bayer', size: 3 },
    { kind: 'blue-noise', size: 300, seed: 1 },
    { kind: 'blue-noise', size: 64, seed: 1, extra: 1 },
  ])('reads a stored invalid screening %j back with no screening (spec 039b)', async (screening) => {
    const port = new FakeDbPort();
    const repo = new PgJobRepository(port);
    const expected = job({ whiteInk: { mode: 'flood' } });
    port.rows.set('job-1', storedRow({ id: 'job-1', doc: JSON.stringify({ ...expected, screening }) }));

    expect(await repo.get('job-1')).toStrictEqual(expected);
    expect(await repo.list()).toStrictEqual([expected]);
  });

  it('rolls back writes made inside a port transaction that throws', async () => {
    const port = new FakeDbPort();
    const repo = new PgJobRepository(port);
    await repo.save(job({ id: 'kept' }));
    const pending: Promise<unknown>[] = [];

    expect(() =>
      port.transaction(() => {
        pending.push(repo.save(job({ id: 'lost' })), repo.delete('kept'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    await Promise.all(pending);

    expect(await repo.get('lost')).toBeUndefined();
    expect((await repo.get('kept'))?.id).toBe('kept');

    port.transaction(() => {
      pending.push(repo.save(job({ id: 'committed' })));
    });
    await Promise.all(pending);
    expect((await repo.get('committed'))?.id).toBe('committed');
  });
});
