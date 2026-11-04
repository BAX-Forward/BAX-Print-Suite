import { canTransition, JOB_STATUSES, type JobStatus } from './status.js';

/**
 * Read-only views of the job status machine. The table itself lives in status.ts; these helpers
 * derive from it so there is a single source of truth.
 */

/** Statuses reachable from `from` in one step, in JOB_STATUSES order. */
export function nextStatuses(from: JobStatus): readonly JobStatus[] {
  return JOB_STATUSES.filter((to) => canTransition(from, to));
}

/** The full transition table, derived from {@link canTransition}. */
export function jobTransitionTable(): Readonly<Record<JobStatus, readonly JobStatus[]>> {
  return Object.fromEntries(JOB_STATUSES.map((from) => [from, nextStatuses(from)])) as Record<
    JobStatus,
    readonly JobStatus[]
  >;
}
