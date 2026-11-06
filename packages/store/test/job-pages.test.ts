import { describe, expect, it } from 'vitest';
import { DEFAULT_SITE_ID, type Job } from '@bax-print/core';
import {
  MemoryJobRepository,
  openDatabase,
  PgJobRepository,
  pgActivePageStatement,
  SqliteDbPort,
  SqliteJobRepository,
  sqliteActivePageStatement,
  type ActiveJobPages,
  type DbPort,
  type DbRow,
  type DbValue,
  type JobRepository,
} from '../src/index.js';

const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-01T09:00:01.000Z';
const T2 = '2026-03-01T09:00:02.000Z';

function job(id: string, createdAt: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    name: `${id}.pdf`,
    status: 'received',
    priority: 50,
    sourceFiles: [],
    artifacts: [],
    ticket: { intent: { quantity: 1 }, process: {} },
    tags: [],
    metadata: {},
    createdAt,
    updatedAt: createdAt,
    lifecycle: 'active',
    legalHold: false,
    ...overrides,
  };
}

function sited(id: string, createdAt: string, siteId: string): Job {
  return job(id, createdAt, { ticket: { intent: { quantity: 1 }, process: {}, siteId } });
}

/** A DbPort that runs the PostgreSQL repository's SQL on SQLite (which has `->`, `->>` and row values) and records it. */
class RecordingPort implements DbPort {
  readonly calls: { readonly sql: string; readonly params: readonly DbValue[] }[] = [];
  private readonly inner = new SqliteDbPort(openDatabase());

  query(sql: string, params: readonly DbValue[] = []): DbRow[] {
    this.calls.push({ sql, params: [...params] });
    return this.inner.query(sql, params);
  }

  exec(sql: string, params: readonly DbValue[] = []): number {
    return this.inner.exec(sql, params);
  }

  transaction<T>(work: () => T): T {
    return this.inner.transaction(work);
  }
}

type PagedRepository = JobRepository & ActiveJobPages;

const implementations: readonly (readonly [string, () => PagedRepository])[] = [
  ['MemoryJobRepository', () => new MemoryJobRepository()],
  ['SqliteJobRepository', () => new SqliteJobRepository(openDatabase())],
  ['PgJobRepository', () => new PgJobRepository(new RecordingPort())],
];

async function seeded(create: () => PagedRepository, jobs: readonly Job[]): Promise<PagedRepository> {
  const repo = create();
  for (const item of jobs) await repo.save(item);
  return repo;
}

const ids = (jobs: readonly Job[]): string[] => jobs.map((item) => item.id);

describe.each(implementations)('%s.listActivePage (Spec 052c)', (_name, create) => {
  const timeline = [
    job('a', T0),
    job('b', T1),
    job('c', T1),
    job('d', T2),
    job('gone', T2, { lifecycle: 'archived', status: 'done', archivedAt: T2 }),
  ];

  it('lists active jobs newest first, ties broken by id descending', async () => {
    const repo = await seeded(create, timeline);

    expect(ids(await repo.listActivePage({ limit: 10 }))).toEqual(['d', 'c', 'b', 'a']);
  });

  it('pages with a (createdAt, id) key, also across equal creation times', async () => {
    const repo = await seeded(create, timeline);

    const first = await repo.listActivePage({ limit: 2 });
    const last = first.at(-1);
    expect(ids(first)).toEqual(['d', 'c']);
    if (last === undefined) throw new Error('expected a first page');
    const second = await repo.listActivePage({ limit: 2, after: { createdAt: last.createdAt, id: last.id } });
    expect(ids(second)).toEqual(['b', 'a']);
    expect(await repo.listActivePage({ limit: 2, after: { createdAt: T0, id: 'a' } })).toEqual([]);
  });

  it('returns jobs equal to the stored ones', async () => {
    const repo = await seeded(create, [job('a', T0)]);

    expect(await repo.listActivePage({ limit: 1 })).toStrictEqual([job('a', T0)]);
  });

  it('filters by site before the limit, counting a job without a site as the default site', async () => {
    const repo = await seeded(create, [
      sited('north-old', T0, 'north'),
      job('unsited', T1),
      sited('south-new', T2, 'south'),
      sited('south-newer', '2026-03-01T09:00:03.000Z', 'south'),
    ]);

    expect(ids(await repo.listActivePage({ limit: 1, siteIds: ['north'] }))).toEqual(['north-old']);
    expect(ids(await repo.listActivePage({ limit: 5, siteIds: [DEFAULT_SITE_ID, 'north'] }))).toEqual([
      'unsited',
      'north-old',
    ]);
    expect(
      ids(await repo.listActivePage({ limit: 1, siteIds: ['south'], after: { createdAt: '2026-03-01T09:00:03.000Z', id: 'south-newer' } })),
    ).toEqual(['south-new']);
    expect(await repo.listActivePage({ limit: 5, siteIds: [] })).toEqual([]);
  });

  it('treats a site id as data, never as SQL', async () => {
    const repo = await seeded(create, [sited('n', T0, 'north')]);

    expect(await repo.listActivePage({ limit: 5, siteIds: ["north') OR 1=1 --"] })).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects the limit %s', async (limit) => {
    const repo = create();

    await expect(repo.listActivePage({ limit })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('active page statements (Spec 052c)', () => {
  const query = { limit: 3, after: { createdAt: T1, id: 'job-9' }, siteIds: ['north', 'south'] } as const;

  it('binds every value as a parameter in SQLite', () => {
    expect(sqliteActivePageStatement(query)).toEqual({
      sql:
        "SELECT doc FROM jobs WHERE lifecycle = ? AND COALESCE(json_extract(doc, '$.ticket.siteId'), ?) IN (?, ?)" +
        ' AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?',
      params: ['active', DEFAULT_SITE_ID, 'north', 'south', T1, 'job-9', 3],
    });
    expect(sqliteActivePageStatement({ limit: 1 })).toEqual({
      sql: 'SELECT doc FROM jobs WHERE lifecycle = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      params: ['active', 1],
    });
  });

  it('binds every value as a parameter over DbPort and sends that statement', async () => {
    const statement = pgActivePageStatement(query);
    expect(statement).toEqual({
      sql:
        "SELECT doc FROM jobs WHERE lifecycle = ? AND COALESCE(doc -> 'ticket' ->> 'siteId', ?) IN (?, ?)" +
        ' AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?',
      params: ['active', DEFAULT_SITE_ID, 'north', 'south', T1, 'job-9', 3],
    });

    const port = new RecordingPort();
    await new PgJobRepository(port).listActivePage(query);
    expect(port.calls).toEqual([statement]);
  });

  it('sends no statement when no site is granted', async () => {
    const port = new RecordingPort();

    expect(await new PgJobRepository(port).listActivePage({ limit: 1, siteIds: [] })).toEqual([]);
    expect(port.calls).toEqual([]);
  });
});
