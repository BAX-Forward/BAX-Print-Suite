/**
 * Spec 027c: {@link JobRepository} for PostgreSQL, written only against {@link DbPort}.
 *
 * Not wired into the server, and this build ships no PostgreSQL driver: nothing constructs a
 * port for it yet. The SQL uses `?` placeholders as DbPort documents; a driver adapter maps them
 * to its own form. The table layout matches the SQLite `jobs` table.
 */
import { normalizeJobInkLimit, normalizeJobScreening, normalizeJobWhiteInk, type Job } from '@bax-print/core';
import type { DbPort, DbRow } from './db-port.js';
import type { JobListFilter, JobRepository } from './job-repository.js';

const SELECT_BY_ID = 'SELECT doc FROM jobs WHERE id = ?';

const UPSERT = `INSERT INTO jobs (id, status, lifecycle, priority, hot_folder_id, source_sha256, created_at, updated_at, doc)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    lifecycle = EXCLUDED.lifecycle,
    priority = EXCLUDED.priority,
    hot_folder_id = EXCLUDED.hot_folder_id,
    source_sha256 = EXCLUDED.source_sha256,
    updated_at = EXCLUDED.updated_at,
    doc = EXCLUDED.doc`;

const DELETE_BY_ID = 'DELETE FROM jobs WHERE id = ?';

const LIST_ALL = 'SELECT doc FROM jobs ORDER BY created_at, id';

const LIST_BY_LIFECYCLE = 'SELECT doc FROM jobs WHERE lifecycle = ? ORDER BY created_at, id';

function isJobDoc(value: unknown): value is Job {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'id' in value &&
    typeof value.id === 'string'
  );
}

/**
 * The port returns unchecked rows, so the `doc` column is checked before it becomes a Job.
 * Spec 038c: a stored `whiteInk` that is not a valid setting reads back absent (white ink off).
 * Spec 039b: likewise a stored `screening` that is not a valid setting reads back absent.
 * Spec 040b: likewise a stored `inkLimit` that is not a valid setting reads back absent.
 */
function parse(row: DbRow): Job {
  const { doc } = row;
  if (typeof doc !== 'string') {
    throw new TypeError('jobs row has no doc text');
  }
  const value: unknown = JSON.parse(doc);
  if (!isJobDoc(value)) {
    throw new TypeError('jobs row doc is not a job document');
  }
  return normalizeJobInkLimit<Job>(normalizeJobScreening<Job>(normalizeJobWhiteInk<Job>(value)));
}

export class PgJobRepository implements JobRepository {
  constructor(private readonly port: DbPort) {}

  async get(id: string): Promise<Job | undefined> {
    const row = this.port.query(SELECT_BY_ID, [id])[0];
    return row ? parse(row) : undefined;
  }

  async save(job: Job): Promise<void> {
    this.port.exec(UPSERT, [
      job.id,
      job.status,
      job.lifecycle,
      job.priority,
      job.hotFolderId ?? null,
      job.sourceFiles[0]?.sha256 ?? null,
      job.createdAt,
      job.updatedAt,
      JSON.stringify(job),
    ]);
  }

  async delete(id: string): Promise<boolean> {
    return this.port.exec(DELETE_BY_ID, [id]) > 0;
  }

  async list(filter: JobListFilter = {}): Promise<Job[]> {
    const rows =
      filter.lifecycle === undefined
        ? this.port.query(LIST_ALL)
        : this.port.query(LIST_BY_LIFECYCLE, [filter.lifecycle]);
    return rows.map(parse);
  }
}
