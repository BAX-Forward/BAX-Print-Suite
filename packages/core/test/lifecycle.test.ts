import { describe, expect, it } from 'vitest';
import {
  assertPurgeable,
  IllegalTransitionError,
  InvalidLifecycleError,
  LegalHoldError,
  markArchived,
  markRestored,
  markTrashed,
  markUntrashed,
  withLegalHold,
  withStatus,
  type Job,
} from '../src/index.js';

const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-02T09:00:00.000Z';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Banner',
    status: 'done',
    priority: 0,
    sourceFiles: [],
    artifacts: [],
    ticket: { intent: { quantity: 1 }, process: {} },
    tags: [],
    metadata: {},
    createdAt: T0,
    updatedAt: T0,
    doneAt: T0,
    lifecycle: 'active',
    legalHold: false,
    ...overrides,
  };
}

describe('print status and lifecycle stay orthogonal', () => {
  it('records doneAt when the status machine reaches done and rejects illegal moves', () => {
    const printed = job({ status: 'printed', doneAt: undefined });
    const done = withStatus(printed, 'done', T1);
    expect(done).toMatchObject({ status: 'done', doneAt: T1, updatedAt: T1, lifecycle: 'active' });
    expect(printed.status).toBe('printed');
    expect(() => withStatus(done, 'queued', T1)).toThrow(IllegalTransitionError);
  });

  it('archives only finished active jobs and leaves the print status alone', () => {
    const archived = markArchived(job(), T1);
    expect(archived).toMatchObject({ lifecycle: 'archived', archivedAt: T1, status: 'done' });
    expect(() => markArchived(archived, T1)).toThrow(InvalidLifecycleError);
    expect(() => markArchived(job({ status: 'processing' }), T1)).toThrow(InvalidLifecycleError);
  });

  it('restores an archived job to active', () => {
    const restored = markRestored(markArchived(job(), T0), T1);
    expect(restored.lifecycle).toBe('active');
    expect(restored.archivedAt).toBeUndefined();
    expect(() => markRestored(job(), T1)).toThrow(InvalidLifecycleError);
  });
});

describe('trash and legal hold', () => {
  it('trashes a finished job and untrashes it back to where it came from', () => {
    const fromActive = markTrashed(job(), T1);
    expect(fromActive).toMatchObject({ lifecycle: 'trashed', trashedAt: T1 });
    expect(markUntrashed(fromActive, T1).lifecycle).toBe('active');

    const fromArchive = markTrashed(markArchived(job(), T0), T1);
    expect(markUntrashed(fromArchive, T1)).toMatchObject({ lifecycle: 'archived', trashedAt: undefined });
  });

  it('refuses to trash a running job or one already in the trash', () => {
    expect(() => markTrashed(job({ status: 'queued' }), T1)).toThrow(InvalidLifecycleError);
    expect(() => markTrashed(markTrashed(job(), T0), T1)).toThrow(InvalidLifecycleError);
    expect(() => markUntrashed(job(), T1)).toThrow(InvalidLifecycleError);
  });

  it('blocks deletion and purge while a legal hold is set', () => {
    const held = withLegalHold(job(), true, T1);
    expect(() => markTrashed(held, T1)).toThrow(LegalHoldError);

    const trashedThenHeld = withLegalHold(markTrashed(job(), T0), true, T1);
    expect(() => assertPurgeable(trashedThenHeld)).toThrow(LegalHoldError);
    expect(() => assertPurgeable(withLegalHold(trashedThenHeld, false, T1))).not.toThrow();
  });

  it('purges only trashed jobs', () => {
    expect(() => assertPurgeable(job())).toThrow(InvalidLifecycleError);
    expect(() => assertPurgeable(markArchived(job(), T1))).toThrow(InvalidLifecycleError);
  });
});
