import { BpsError } from './errors.js';

export const JOB_STATUSES = [
  'received',
  'inspecting',
  'ready',
  'held',
  'queued',
  'processing',
  'sent_to_device',
  'printed',
  'done',
  'failed',
  'cancelled',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: readonly JobStatus[] = ['done', 'failed', 'cancelled'];

/** Allowed print-status transitions (ARCHITECTURE §4). Archive state is a separate axis. */
const ALLOWED: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  received: ['inspecting', 'failed', 'cancelled'],
  inspecting: ['ready', 'failed', 'cancelled'],
  ready: ['queued', 'held', 'failed', 'cancelled'],
  // Spec 007: releasing a preflight hold returns the job to `ready`. Queuing stays a separate step.
  held: ['ready', 'queued', 'failed', 'cancelled'],
  queued: ['held', 'processing', 'failed', 'cancelled'],
  processing: ['sent_to_device', 'failed', 'cancelled'],
  sent_to_device: ['printed', 'done', 'failed', 'cancelled'],
  printed: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export class IllegalTransitionError extends BpsError {
  readonly from: JobStatus;
  readonly to: JobStatus;

  constructor(from: JobStatus, to: JobStatus) {
    super('ILLEGAL_TRANSITION', `job status cannot change from ${from} to ${to}`);
    this.from = from;
    this.to = to;
  }
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}
