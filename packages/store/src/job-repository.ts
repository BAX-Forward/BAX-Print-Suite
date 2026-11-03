import type { Job, JobLifecycle } from '@bax-print/core';

export interface JobListFilter {
  readonly lifecycle?: JobLifecycle;
}

export interface JobRepository {
  get(id: string): Promise<Job | undefined>;
  save(job: Job): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(filter?: JobListFilter): Promise<Job[]>;
}

/** In-memory repository; stores structured clones so callers cannot mutate stored rows. */
export class MemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, Job>();

  async get(id: string): Promise<Job | undefined> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
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
      .map((job) => structuredClone(job));
  }
}
