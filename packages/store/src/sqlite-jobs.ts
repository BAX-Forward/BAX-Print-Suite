import { normalizeJobScreening, normalizeJobWhiteInk, TERMINAL_STATUSES, type Job } from '@bax-print/core';
import type { Database } from './database.js';
import {
  DEFAULT_JOB_PAGE_SIZE,
  MAX_JOB_PAGE_SIZE,
  type JobQueueIndex,
  type JobQueuePage,
  type JobQueueQuery,
} from './interfaces.js';
import type { JobListFilter, JobRepository } from './job-repository.js';

interface DocRow {
  doc: string;
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
 */
function parse(row: DocRow): Job {
  return normalizeJobScreening<Job>(normalizeJobWhiteInk<Job>(JSON.parse(row.doc) as Job));
}

/**
 * Spec 008 {@link JobRepository} on SQLite. Each job is a JSON document with the queried fields
 * mirrored into columns. node:sqlite is synchronous, so every method is one atomic step.
 */
export class SqliteJobRepository implements JobRepository, JobQueueIndex {
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
