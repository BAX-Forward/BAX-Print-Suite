import {
  DEFAULT_SITE_ID,
  normalizeJobInkLimit,
  normalizeJobPlaneCurves,
  normalizeJobScreening,
  normalizeJobTiling,
  normalizeJobWhiteInk,
  TERMINAL_STATUSES,
  type Job,
} from '@bax-print/core';
import type { Database } from './database.js';
import {
  DEFAULT_JOB_PAGE_SIZE,
  MAX_JOB_PAGE_SIZE,
  type JobQueueIndex,
  type JobQueuePage,
  type JobQueueQuery,
} from './interfaces.js';
import {
  assertPageLimit,
  type ActiveJobPageQuery,
  type ActiveJobPages,
  type JobListFilter,
  type JobRepository,
} from './job-repository.js';

interface DocRow {
  doc: string;
}

function docRow(row: unknown): DocRow {
  if (typeof row === 'object' && row !== null && 'doc' in row && typeof row.doc === 'string') return { doc: row.doc };
  throw new TypeError('jobs row has no doc text');
}

interface Statement {
  readonly sql: string;
  readonly params: Array<string | number>;
}

/**
 * Spec 052c: one keyset page of active jobs, newest first. The site of a job is its ticket
 * `siteId`, or `DEFAULT_SITE_ID` without one; every value is a bound parameter.
 */
export function sqliteActivePageStatement(query: ActiveJobPageQuery): Statement {
  const where = ['lifecycle = ?'];
  const params: Array<string | number> = ['active'];
  if (query.siteIds !== undefined) {
    where.push(`COALESCE(json_extract(doc, '$.ticket.siteId'), ?) IN (${query.siteIds.map(() => '?').join(', ')})`);
    params.push(DEFAULT_SITE_ID, ...query.siteIds);
  }
  if (query.after !== undefined) {
    where.push('(created_at, id) < (?, ?)');
    params.push(query.after.createdAt, query.after.id);
  }
  params.push(query.limit);
  return {
    sql: `SELECT doc FROM jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    params,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_JOB_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_JOB_PAGE_SIZE);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

/**
 * Spec 038c: a stored `whiteInk` that is not a valid setting reads back absent (white ink off).
 * Spec 039b: likewise a stored `screening` that is not a valid setting reads back absent.
 * Spec 040b: likewise a stored `inkLimit` that is not a valid setting reads back absent.
 * Spec 044b: likewise a stored `planeCurves` that is not a valid setting reads back absent.
 * Spec 050a: likewise a stored `tiling` that is not a valid setting reads back absent.
 */
function parse(row: DocRow): Job {
  return normalizeJobTiling<Job>(
    normalizeJobPlaneCurves<Job>(
      normalizeJobInkLimit<Job>(normalizeJobScreening<Job>(normalizeJobWhiteInk<Job>(JSON.parse(row.doc) as Job))),
    ),
  );
}

/**
 * Spec 008 {@link JobRepository} on SQLite. Each job is a JSON document with the queried fields
 * mirrored into columns. node:sqlite is synchronous, so every method is one atomic step.
 */
export class SqliteJobRepository implements JobRepository, JobQueueIndex, ActiveJobPages {
  constructor(private readonly db: Database) {}

  async get(id: string): Promise<Job | undefined> {
    const row = this.db.prepare('SELECT doc FROM jobs WHERE id = ?').get(id) as DocRow | undefined;
    return row ? parse(row) : undefined;
  }

  async save(job: Job): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO jobs (id, status, lifecycle, priority, hot_folder_id, source_sha256, created_at, updated_at, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           lifecycle = excluded.lifecycle,
           priority = excluded.priority,
           hot_folder_id = excluded.hot_folder_id,
           source_sha256 = excluded.source_sha256,
           updated_at = excluded.updated_at,
           doc = excluded.doc`,
      )
      .run(
        job.id,
        job.status,
        job.lifecycle,
        job.priority,
        job.hotFolderId ?? null,
        job.sourceFiles[0]?.sha256 ?? null,
        job.createdAt,
        job.updatedAt,
        JSON.stringify(job),
      );
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  async list(filter: JobListFilter = {}): Promise<Job[]> {
    const rows = (
      filter.lifecycle === undefined
        ? this.db.prepare('SELECT doc FROM jobs ORDER BY created_at, id').all()
        : this.db
            .prepare('SELECT doc FROM jobs WHERE lifecycle = ? ORDER BY created_at, id')
            .all(filter.lifecycle)
    ) as unknown as DocRow[];
    return rows.map(parse);
  }

  async listActivePage(query: ActiveJobPageQuery): Promise<Job[]> {
    assertPageLimit(query.limit);
    // `IN ()` is not valid SQL; no granted site means no job.
    if (query.siteIds?.length === 0) return [];
    const { sql, params } = sqliteActivePageStatement(query);
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parse(docRow(row)));
  }

  async queue(query: JobQueueQuery = {}): Promise<JobQueuePage> {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (query.status && query.status.length > 0) {
      where.push(`status IN (${query.status.map(() => '?').join(', ')})`);
      params.push(...query.status);
    }
    if (query.lifecycle !== undefined) {
      where.push('lifecycle = ?');
      params.push(query.lifecycle);
    }
    if (query.hotFolderId !== undefined) {
      where.push('hot_folder_id = ?');
      params.push(query.hotFolderId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM jobs ${clause}`).get(...params) as {
      total: number | bigint;
    };
    const rows = this.db
      .prepare(
        `SELECT doc FROM jobs ${clause} ORDER BY priority DESC, created_at ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as DocRow[];
    return { items: rows.map(parse), total: Number(totalRow.total), limit, offset };
  }

  async findLiveBySha256(hotFolderId: string, sha256: string): Promise<Job | undefined> {
    const row = this.db
      .prepare(
        `SELECT doc FROM jobs WHERE hot_folder_id = ? AND source_sha256 = ? AND lifecycle = 'active'
         AND status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')})
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(hotFolderId, sha256, ...TERMINAL_STATUSES) as DocRow | undefined;
    return row ? parse(row) : undefined;
  }
}
