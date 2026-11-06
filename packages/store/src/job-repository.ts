import {
  DEFAULT_SITE_ID,
  normalizeJobInkLimit,
  normalizeJobPlaneCurves,
  normalizeJobScreening,
  normalizeJobTiling,
  normalizeJobWhiteInk,
  type Job,
  type JobLifecycle,
} from '@bax-print/core';

export interface JobListFilter {
  readonly lifecycle?: JobLifecycle;
}

export interface JobRepository {
  get(id: string): Promise<Job | undefined>;
  save(job: Job): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(filter?: JobListFilter): Promise<Job[]>;
}

/** Spec 052c: the position of a job in the newest-first order. */
export interface JobPageKey {
  readonly createdAt: string;
  readonly id: string;
}

export interface ActiveJobPageQuery {
  /** Most jobs returned; a positive safe integer. */
  readonly limit: number;
  /** Only jobs strictly after this key in the newest-first order. */
  readonly after?: JobPageKey;
  /** Only jobs of these sites (the ticket `siteId`, or `DEFAULT_SITE_ID` without one); absent for every site. */
  readonly siteIds?: readonly string[];
}

/**
 * Spec 052c: keyset paging of the active jobs, newest first: `createdAt` descending, then `id`
 * descending. The site filter applies before the limit, so hidden jobs never shorten a page.
 */
export interface ActiveJobPages {
  listActivePage(query: ActiveJobPageQuery): Promise<Job[]>;
}

/** Throws unless `limit` is a positive safe integer. */
export function assertPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`page limit must be a positive integer, got ${String(limit)}`);
  }
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Newest first: `createdAt` descending, then `id` descending, compared as code units like SQL BINARY text. */
export function compareNewestFirst(a: JobPageKey, b: JobPageKey): number {
  return a.createdAt === b.createdAt ? compareText(b.id, a.id) : compareText(b.createdAt, a.createdAt);
}

/**
 * Spec 038c: a stored `whiteInk` that is not a valid setting reads back absent (white ink off).
 * Spec 039b: likewise a stored `screening` that is not a valid setting reads back absent.
 * Spec 040b: likewise a stored `inkLimit` that is not a valid setting reads back absent.
 * Spec 044b: likewise a stored `planeCurves` that is not a valid setting reads back absent.
 * Spec 050a: likewise a stored `tiling` that is not a valid setting reads back absent.
 */
function readBack(job: Job): Job {
  return normalizeJobTiling<Job>(
    normalizeJobPlaneCurves<Job>(
      normalizeJobInkLimit<Job>(normalizeJobScreening<Job>(normalizeJobWhiteInk<Job>(structuredClone(job)))),
    ),
  );
}

/** In-memory repository; stores structured clones so callers cannot mutate stored rows. */
export class MemoryJobRepository implements JobRepository, ActiveJobPages {
  private readonly jobs = new Map<string, Job>();

  async get(id: string): Promise<Job | undefined> {
    const job = this.jobs.get(id);
    return job ? readBack(job) : undefined;
  }

  async save(job: Job): Promise<void> {
    this.jobs.set(job.id, structuredClone(job));
  }

  async delete(id: string): Promise<boolean> {
    return this.jobs.delete(id);
  }

  async list(filter: JobListFilter = {}): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter((job) => filter.lifecycle === undefined || job.lifecycle === filter.lifecycle)
      .map(readBack);
  }

  async listActivePage(query: ActiveJobPageQuery): Promise<Job[]> {
    assertPageLimit(query.limit);
    const { after, siteIds } = query;
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.lifecycle === 'active' &&
          (siteIds === undefined || siteIds.includes(job.ticket.siteId ?? DEFAULT_SITE_ID)) &&
          (after === undefined || compareNewestFirst(job, after) > 0),
      )
      .sort(compareNewestFirst)
      .slice(0, query.limit)
      .map(readBack);
  }
}
