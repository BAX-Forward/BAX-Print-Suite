import {
  normalizeJobInkLimit,
  normalizeJobScreening,
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

/**
 * Spec 038c: a stored `whiteInk` that is not a valid setting reads back absent (white ink off).
 * Spec 039b: likewise a stored `screening` that is not a valid setting reads back absent.
 * Spec 040b: likewise a stored `inkLimit` that is not a valid setting reads back absent.
 */
function readBack(job: Job): Job {
  return normalizeJobInkLimit<Job>(normalizeJobScreening<Job>(normalizeJobWhiteInk<Job>(structuredClone(job))));
}

/** In-memory repository; stores structured clones so callers cannot mutate stored rows. */
export class MemoryJobRepository implements JobRepository {
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
}
