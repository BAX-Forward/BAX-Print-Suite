import type { JobStatus } from '../src/api/types';

/**
 * Mock copy of the core job state machine (ARCHITECTURE §4, Spec 001). The real server answers
 * `GET /jobs/:id/transitions` from packages/core; the UI never hard-codes these rules.
 */

const TERMINAL: readonly JobStatus[] = ['done', 'failed', 'cancelled'];

const FORWARD: Record<JobStatus, readonly JobStatus[]> = {
  received: ['inspecting'],
  inspecting: ['ready'],
  ready: ['held', 'queued'],
  held: ['queued'],
  queued: ['held', 'processing'],
  processing: ['sent_to_device'],
  // `sent_to_device → done`: output whose print confirmation is not observable (handoff).
  sent_to_device: ['printed', 'done'],
  printed: ['done'],
  done: [],
  failed: [],
  cancelled: [],
};

/** `failed` and `cancelled` are reachable from any non-terminal status. */
export function allowedTransitions(from: JobStatus): JobStatus[] {
  if (TERMINAL.includes(from)) return [];
  return [...FORWARD[from], 'failed', 'cancelled'];
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return allowedTransitions(from).includes(to);
}
