import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isTerminal,
  JOB_STATUSES,
  jobTransitionTable,
  nextStatuses,
  type JobStatus,
} from '../src/index.js';

/**
 * The Spec 001 job machine, written out independently of the implementation:
 * received → inspecting → ready → (held ⇄ queued) → processing → sent_to_device → printed → done,
 * sent_to_device → done, and any non-terminal status → failed | cancelled.
 */
const EXPECTED: Record<JobStatus, readonly JobStatus[]> = {
  received: ['inspecting', 'failed', 'cancelled'],
  inspecting: ['ready', 'failed', 'cancelled'],
  ready: ['held', 'queued', 'failed', 'cancelled'],
  held: ['queued', 'failed', 'cancelled'],
  queued: ['held', 'processing', 'failed', 'cancelled'],
  processing: ['sent_to_device', 'failed', 'cancelled'],
  sent_to_device: ['printed', 'done', 'failed', 'cancelled'],
  printed: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

const TERMINAL: readonly JobStatus[] = ['done', 'failed', 'cancelled'];

describe('job status transition table', () => {
  it('covers exactly the eleven Spec 001 statuses', () => {
    expect([...JOB_STATUSES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const from of JOB_STATUSES) {
    for (const to of JOB_STATUSES) {
      const allowed = EXPECTED[from].includes(to);
      it(`${from} → ${to} is ${allowed ? 'allowed' : 'rejected'}`, () => {
        expect(canTransition(from, to)).toBe(allowed);
        if (allowed) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          let thrown: unknown;
          try {
            assertTransition(from, to);
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(IllegalTransitionError);
          expect(thrown).toMatchObject({ code: 'ILLEGAL_TRANSITION', from, to });
        }
      });
    }
  }

  it('derives nextStatuses and the table from the same source', () => {
    const table = jobTransitionTable();
    for (const from of JOB_STATUSES) {
      expect([...nextStatuses(from)].sort()).toEqual([...EXPECTED[from]].sort());
      expect(table[from]).toEqual(nextStatuses(from));
    }
  });

  it('has no exits from terminal statuses and an exit to failed/cancelled from every other', () => {
    for (const status of JOB_STATUSES) {
      expect(isTerminal(status)).toBe(TERMINAL.includes(status));
      if (isTerminal(status)) {
        expect(nextStatuses(status)).toEqual([]);
      } else {
        expect(canTransition(status, 'failed')).toBe(true);
        expect(canTransition(status, 'cancelled')).toBe(true);
      }
    }
  });

  it('never allows a self-transition', () => {
    for (const status of JOB_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});
