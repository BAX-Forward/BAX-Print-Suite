import { describe, expect, it } from 'vitest';
import { DAY_MS, InvalidArgumentError } from '@bax-print/core';
import { packageKey } from '@bax-print/store';
import {
  archiveAfterFor,
  DEFAULT_ARCHIVE_AFTER_MS,
  isDueForArchive,
  parseDuration,
  selectJobsToArchive,
  unpack,
  validateRules,
} from '../src/index.js';
import { createHarness, makeJob, seedJob, typesOf } from './helpers.js';

const DONE = '2026-03-01T08:00:00.000Z';
const at = (ms: number): Date => new Date(Date.parse(DONE) + ms);

describe('archive policy evaluator', () => {
  it('defaults to 14 days', () => {
    expect(DEFAULT_ARCHIVE_AFTER_MS).toBe(14 * DAY_MS);
    expect(archiveAfterFor(makeJob({ id: 'a' }), [])).toBe(14 * DAY_MS);
  });

  it('archives exactly the jobs whose done time is older than the rule', () => {
    const jobs = [
      makeJob({ id: 'old', doneAt: '2026-02-10T08:00:00.000Z' }),
      makeJob({ id: 'boundary', doneAt: '2026-02-15T08:00:00.000Z' }),
      makeJob({ id: 'just-past', doneAt: '2026-02-15T07:59:59.999Z' }),
      makeJob({ id: 'fresh', doneAt: '2026-02-28T08:00:00.000Z' }),
      makeJob({ id: 'failed', status: 'failed', doneAt: undefined }),
      makeJob({ id: 'printing', status: 'processing', doneAt: undefined }),
      makeJob({ id: 'already', lifecycle: 'archived', doneAt: '2026-01-01T08:00:00.000Z' }),
      makeJob({ id: 'trashed', lifecycle: 'trashed', doneAt: '2026-01-01T08:00:00.000Z' }),
    ];
    const due = selectJobsToArchive(jobs, [], new Date(DONE));
    expect(due.map((job) => job.id)).toEqual(['old', 'just-past']);
  });

  it('uses a strict boundary on the fake clock', () => {
    const job = makeJob({ id: 'j', doneAt: DONE });
    const rules = [{ archiveAfterMs: 2 * DAY_MS }];
    expect(isDueForArchive(job, rules, at(2 * DAY_MS))).toBe(false);
    expect(isDueForArchive(job, rules, at(2 * DAY_MS + 1))).toBe(true);
  });

  it('lets a hot-folder rule win over the global rule', () => {
    const rules = validateRules([{ archiveAfterMs: 30 * DAY_MS }, { hotFolderId: 'banners', archiveAfterMs: DAY_MS }]);
    const banner = makeJob({ id: 'banner', hotFolderId: 'banners', doneAt: DONE });
    const decal = makeJob({ id: 'decal', hotFolderId: 'decals', doneAt: DONE });
    const manual = makeJob({ id: 'manual', doneAt: DONE });

    expect(archiveAfterFor(banner, rules)).toBe(DAY_MS);
    expect(archiveAfterFor(decal, rules)).toBe(30 * DAY_MS);
    expect(selectJobsToArchive([banner, decal, manual], rules, at(2 * DAY_MS)).map((j) => j.id)).toEqual(['banner']);
    expect(selectJobsToArchive([banner, decal, manual], rules, at(31 * DAY_MS)).map((j) => j.id)).toEqual([
      'banner',
      'decal',
      'manual',
    ]);
  });

  it('rejects invalid or duplicate rules', () => {
    expect(() => validateRules([{ archiveAfterMs: 0 }])).toThrow(InvalidArgumentError);
    expect(() => validateRules([{ archiveAfterMs: Number.NaN }])).toThrow(InvalidArgumentError);
    expect(() => validateRules([{ archiveAfterMs: DAY_MS }, { archiveAfterMs: 2 * DAY_MS }])).toThrow(/global scope/);
    expect(() =>
      validateRules([
        { hotFolderId: 'x', archiveAfterMs: DAY_MS },
        { hotFolderId: 'x', archiveAfterMs: 2 * DAY_MS },
      ]),
    ).toThrow(/hot folder x/);
  });
});

describe('parseDuration', () => {
  it('reads short and ISO 8601 forms', () => {
    expect(parseDuration('14d')).toBe(14 * DAY_MS);
    expect(parseDuration('36h')).toBe(1.5 * DAY_MS);
    expect(parseDuration('2w')).toBe(14 * DAY_MS);
    expect(parseDuration(' 90m ')).toBe(90 * 60_000);
    expect(parseDuration('P14D')).toBe(14 * DAY_MS);
    expect(parseDuration('PT36H')).toBe(1.5 * DAY_MS);
    expect(parseDuration('P1W2DT3H')).toBe(9 * DAY_MS + 3 * 3_600_000);
  });

  it('rejects nonsense and non-positive values', () => {
    for (const text of ['', 'P', 'PT', '0d', '-1d', '14 days', 'soon']) {
      expect(() => parseDuration(text)).toThrow(InvalidArgumentError);
    }
  });
});

describe('scheduled policy run', () => {
  it('archives due jobs into packages, keeps fresh ones active, and records job.archived', async () => {
    const h = createHarness({ start: DONE });
    await seedJob(h, { id: 'due-1', doneAt: '2026-02-01T08:00:00.000Z' });
    await seedJob(h, { id: 'due-2', doneAt: '2026-02-14T00:00:00.000Z' });
    await seedJob(h, { id: 'fresh', doneAt: '2026-02-25T08:00:00.000Z' });
    await seedJob(h, { id: 'failed', status: 'failed', doneAt: undefined });

    const first = await h.service.runArchivePolicy();
    expect(first).toEqual({ archived: ['due-1', 'due-2'], failed: [] });

    for (const id of ['due-1', 'due-2']) {
      const job = await h.service.getJob(id);
      expect(job.lifecycle).toBe('archived');
      expect(job.archivedAt).toBe(DONE);
      expect(await h.blobs.list(`jobs/${id}/`)).toEqual([]);
      expect(unpack(await h.archive.get(packageKey(id))).manifest.jobId).toBe(id);
      expect(await h.index.get(id)).toMatchObject({ jobId: id, packageKey: packageKey(id) });
    }
    expect((await h.service.getJob('fresh')).lifecycle).toBe('active');
    expect((await h.service.getJob('failed')).lifecycle).toBe('active');
    expect(typesOf(h, ['job.archived'])).toHaveLength(2);

    h.time.advance(13 * DAY_MS);
    expect((await h.service.runArchivePolicy()).archived).toEqual(['fresh']);
    expect((await h.service.runArchivePolicy()).archived).toEqual([]);
  });

  it('always allows a manual archive of a finished job, but not of one still in production', async () => {
    const h = createHarness({ start: DONE });
    await seedJob(h, { id: 'just-done', doneAt: DONE });
    await seedJob(h, { id: 'cancelled', status: 'cancelled', doneAt: undefined });
    await seedJob(h, { id: 'running', status: 'processing', doneAt: undefined });

    expect((await h.service.archive('just-done')).job.lifecycle).toBe('archived');
    expect((await h.service.archive('cancelled')).job.lifecycle).toBe('archived');
    await expect(h.service.archive('running')).rejects.toThrow(/only finished jobs/);
    await expect(h.service.archive('just-done')).rejects.toThrow(/only active jobs/);
  });

  it('reports a job it cannot archive and carries on with the rest', async () => {
    const h = createHarness({ start: DONE });
    const broken = await seedJob(h, { id: 'broken', doneAt: '2026-02-01T08:00:00.000Z' });
    await seedJob(h, { id: 'fine', doneAt: '2026-02-01T08:00:00.000Z' });
    await h.blobs.delete(broken.sourceFiles[0].storageKey);

    const run = await h.service.runArchivePolicy();
    expect(run.archived).toEqual(['fine']);
    expect(run.failed).toHaveLength(1);
    expect(run.failed[0].jobId).toBe('broken');
    expect((await h.service.getJob('broken')).lifecycle).toBe('active');
  });
});
