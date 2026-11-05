import { describe, expect, it } from 'vitest';
import { DAY_MS, ForbiddenError, InvalidLifecycleError, LegalHoldError, type Actor } from '@bax-print/core';
import { packageKey } from '@bax-print/store';
import { DEFAULT_RETENTION_MS, isDueForPurge, selectJobsToPurge } from '../src/index.js';
import { createHarness, makeJob, seedJob, typesOf } from './helpers.js';

const START = '2026-04-01T08:00:00.000Z';
const OPERATOR: Actor = { id: 'op-1', role: 'operator' };
const ADMIN: Actor = { id: 'admin-1', role: 'admin' };

describe('retention evaluator', () => {
  it('defaults to 30 days', () => {
    expect(DEFAULT_RETENTION_MS).toBe(30 * DAY_MS);
  });

  it('selects trashed jobs strictly past the window and never jobs under legal hold', () => {
    const now = new Date(Date.parse(START) + 30 * DAY_MS);
    const boundary = makeJob({ id: 'boundary', lifecycle: 'trashed', trashedAt: START });
    const jobs = [
      makeJob({ id: 'old', lifecycle: 'trashed', trashedAt: '2026-03-01T08:00:00.000Z' }),
      boundary,
      makeJob({ id: 'held', lifecycle: 'trashed', trashedAt: '2026-01-01T08:00:00.000Z', legalHold: true }),
      makeJob({ id: 'active', trashedAt: '2026-01-01T08:00:00.000Z' }),
    ];
    expect(selectJobsToPurge(jobs, now, DEFAULT_RETENTION_MS).map((job) => job.id)).toEqual(['old']);
    expect(isDueForPurge(boundary, new Date(now.getTime() + 1), DEFAULT_RETENTION_MS)).toBe(true);
  });
});

describe('trash purge on a fake clock', () => {
  it('purges expired trash except legal-hold jobs, emits job.purged and removes storage blobs', async () => {
    const h = createHarness({ start: START });
    await seedJob(h, { id: 'active-bin', artifacts: [{ role: 'cut', name: 'cut.svg', bytes: Buffer.from('<svg/>') }] });
    await seedJob(h, { id: 'archived-bin' });
    await seedJob(h, { id: 'disputed' });
    await seedJob(h, { id: 'late-bin' });

    await h.service.archive('archived-bin');
    expect(await h.archive.stat(packageKey('archived-bin'))).not.toBeNull();

    await h.service.trash('active-bin', OPERATOR);
    await h.service.trash('archived-bin', OPERATOR);
    await h.service.trash('disputed', OPERATOR);
    await h.service.setLegalHold('disputed', true, OPERATOR);
    expect(await h.blobs.list('jobs/active-bin/')).toHaveLength(2);
    expect(await h.index.get('archived-bin')).toBeUndefined();

    h.time.advance(10 * DAY_MS);
    await h.service.trash('late-bin', OPERATOR);

    // Exactly at the window nothing is purged yet.
    h.time.advance(20 * DAY_MS);
    expect(await h.service.purgeExpired()).toEqual([]);

    h.time.advance(1);
    expect(await h.service.purgeExpired()).toEqual(['active-bin', 'archived-bin']);

    for (const id of ['active-bin', 'archived-bin']) {
      expect(await h.jobs.get(id)).toBeUndefined();
      expect(await h.blobs.list(`jobs/${id}/`)).toEqual([]);
      expect(await h.archive.stat(packageKey(id))).toBeNull();
      expect(await h.index.get(id)).toBeUndefined();
    }
    const purged = h.outbox.list({ types: ['job.purged'] }).map((record) => record.event);
    expect(purged.map((event) => event.data)).toEqual([
      { jobId: 'active-bin', removedBlobs: 2, packageRemoved: false },
      { jobId: 'archived-bin', removedBlobs: 0, packageRemoved: true },
    ]);
    expect(purged.map((event) => event.subject)).toEqual(['active-bin', 'archived-bin']);

    // The held job and the job trashed later are still there.
    expect((await h.service.getJob('disputed')).lifecycle).toBe('trashed');
    expect(await h.blobs.list('jobs/disputed/')).toHaveLength(1);
    expect((await h.service.getJob('late-bin')).lifecycle).toBe('trashed');

    // Far in the future the hold still blocks purge; once an admin lifts it, the job goes.
    h.time.advance(365 * DAY_MS);
    expect(await h.service.purgeExpired()).toEqual(['late-bin']);
    await expect(h.service.setLegalHold('disputed', false, OPERATOR)).rejects.toThrow(ForbiddenError);
    await h.service.setLegalHold('disputed', false, ADMIN);
    expect(await h.service.purgeExpired()).toEqual(['disputed']);
    expect(await h.blobs.list('jobs/disputed/')).toEqual([]);
    expect(typesOf(h, ['job.purged'])).toHaveLength(4);
  });

  it('honours a configured retention window', async () => {
    const h = createHarness({ start: START, retentionMs: 7 * DAY_MS });
    await seedJob(h, { id: 'weekly' });
    await h.service.trash('weekly');
    h.time.advance(7 * DAY_MS + 1);
    expect(await h.service.purgeExpired()).toEqual(['weekly']);
    expect(() => createHarness({ retentionMs: 0 })).toThrow(/retentionMs/);
  });
});

describe('legal hold and trash', () => {
  it('blocks deletion while a hold is set', async () => {
    const h = createHarness({ start: START });
    await seedJob(h, { id: 'held' });
    await h.service.setLegalHold('held', true, OPERATOR);
    await expect(h.service.trash('held', ADMIN)).rejects.toThrow(LegalHoldError);
    expect((await h.service.getJob('held')).lifecycle).toBe('active');
    expect(typesOf(h, ['job.legalhold.changed'])).toEqual(['job.legalhold.changed']);
  });

  it('restores an archived job from the trash back into the archive and its index', async () => {
    const h = createHarness({ start: START });
    await seedJob(h, { id: 'oops', customerRef: 'C-9' });
    await h.service.archive('oops');
    await h.service.trash('oops');
    expect(await h.service.listTrash()).toHaveLength(1);

    const restored = await h.service.restoreFromTrash('oops', OPERATOR);
    expect(restored.lifecycle).toBe('archived');
    expect(restored.trashedAt).toBeUndefined();
    expect(await h.index.get('oops')).toMatchObject({ jobId: 'oops', customerRef: 'C-9' });
    expect(await h.service.listTrash()).toEqual([]);
    expect(h.outbox.list({ types: ['job.restored'] })[0]?.event.data).toMatchObject({ from: 'trash', lifecycle: 'archived' });
  });

  it('restores an active job from the trash to the active list', async () => {
    const h = createHarness({ start: START });
    await seedJob(h, { id: 'back' });
    await h.service.trash('back');
    expect((await h.service.restoreFromTrash('back')).lifecycle).toBe('active');
    await expect(h.service.restoreFromTrash('back')).rejects.toThrow(InvalidLifecycleError);
  });
});
