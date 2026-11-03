import { BpsError } from './errors.js';
import type { Job } from './job.js';
import { assertTransition, isTerminal, type JobStatus } from './status.js';

export class InvalidLifecycleError extends BpsError {
  constructor(message: string) {
    super('INVALID_LIFECYCLE', message);
  }
}

export class LegalHoldError extends BpsError {
  readonly jobId: string;

  constructor(jobId: string, action: string) {
    super('LEGAL_HOLD', `job ${jobId} is under legal hold; ${action} is blocked until an admin removes the hold`);
    this.jobId = jobId;
  }
}

/** Returns a copy with the new print status, validated by the status machine. */
export function withStatus(job: Job, to: JobStatus, at: string): Job {
  assertTransition(job.status, to);
  return { ...job, status: to, updatedAt: at, doneAt: to === 'done' ? at : job.doneAt };
}

export function markArchived(job: Job, at: string): Job {
  if (job.lifecycle !== 'active') {
    throw new InvalidLifecycleError(`job ${job.id} is ${job.lifecycle}; only active jobs can be archived`);
  }
  if (!isTerminal(job.status)) {
    throw new InvalidLifecycleError(`job ${job.id} is ${job.status}; only finished jobs can be archived`);
  }
  return { ...job, lifecycle: 'archived', archivedAt: at, updatedAt: at };
}

export function markRestored(job: Job, at: string): Job {
  if (job.lifecycle !== 'archived') {
    throw new InvalidLifecycleError(`job ${job.id} is ${job.lifecycle}; only archived jobs can be restored`);
  }
  return { ...job, lifecycle: 'active', archivedAt: undefined, updatedAt: at };
}

export function markTrashed(job: Job, at: string): Job {
  if (job.legalHold) {
    throw new LegalHoldError(job.id, 'deletion');
  }
  if (job.lifecycle === 'trashed') {
    throw new InvalidLifecycleError(`job ${job.id} is already in the trash`);
  }
  if (!isTerminal(job.status)) {
    throw new InvalidLifecycleError(`job ${job.id} is ${job.status}; cancel it before deleting`);
  }
  return { ...job, lifecycle: 'trashed', trashedAt: at, updatedAt: at };
}

/** Takes a job out of the trash, back to the archive if it had been archived. */
export function markUntrashed(job: Job, at: string): Job {
  if (job.lifecycle !== 'trashed') {
    throw new InvalidLifecycleError(`job ${job.id} is ${job.lifecycle}, not in the trash`);
  }
  return { ...job, lifecycle: job.archivedAt ? 'archived' : 'active', trashedAt: undefined, updatedAt: at };
}

export function withLegalHold(job: Job, hold: boolean, at: string): Job {
  return { ...job, legalHold: hold, updatedAt: at };
}

export function assertPurgeable(job: Job): void {
  if (job.lifecycle !== 'trashed') {
    throw new InvalidLifecycleError(`job ${job.id} is ${job.lifecycle}; only trashed jobs can be purged`);
  }
  if (job.legalHold) {
    throw new LegalHoldError(job.id, 'purge');
  }
}
