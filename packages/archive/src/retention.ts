import { DAY_MS, type Job } from '@bax-print/core';

/** Safety window in the trash before purge; aligns with common monthly billing and dispute cycles. */
export const DEFAULT_RETENTION_MS = 30 * DAY_MS;

export function isDueForPurge(job: Job, now: Date, retentionMs: number): boolean {
  if (job.lifecycle !== 'trashed' || job.legalHold || job.trashedAt === undefined) return false;
  const trashedMs = Date.parse(job.trashedAt);
  if (Number.isNaN(trashedMs)) return false;
  return now.getTime() - trashedMs > retentionMs;
}

/** Trashed jobs past the retention window. Jobs under legal hold are never selected. */
export function selectJobsToPurge(jobs: readonly Job[], now: Date, retentionMs: number): Job[] {
  return jobs.filter((job) => isDueForPurge(job, now, retentionMs));
}
