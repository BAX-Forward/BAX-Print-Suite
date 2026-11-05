import { describe, expect, it } from 'vitest';
import type { Job } from '@bax-print/core';
import {
  appliedMigrations,
  DuplicateHotFolderError,
  HotFolderNotFoundError,
  openDatabase,
  SqliteHotFolderRepository,
  SqliteJobRepository,
} from '../src/index.js';

const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-01T09:00:01.000Z';
const T2 = '2026-03-01T09:00:02.000Z';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Banner.pdf',
    status: 'received',
    priority: 50,
    hotFolderId: 'hf-1',
    sourceFiles: [{ name: 'Banner.pdf', sha256: 'a'.repeat(64), sizeBytes: 1234, storageKey: 'jobs/job-1/source/0-Banner.pdf' }],
    artifacts: [],
    ticket: { intent: { quantity: 2, finishedSize: { widthMm: 1000, heightMm: 500 } }, process: {} },
    tags: ['rush'],
    metadata: { customer: 'C-1' },
    createdAt: T0,
    updatedAt: T0,
    lifecycle: 'active',
    legalHold: false,
    ...overrides,
  };
}

describe('database migrations', () => {
  it('applies every migration once', () => {
    const db = openDatabase();
    expect(appliedMigrations(db)).toEqual([1, 2, 3]);
  });
});

describe('SqliteJobRepository', () => {
  it('round-trips a full job document', async () => {
    const repo = new SqliteJobRepository(openDatabase());
    const original = job({
      pageCount: 1,
      pages: [{ index: 0, widthPt: 595, heightPt: 842, trimBox: { x: 9, y: 9, width: 577, height: 824 } }],
      steps: [
        {
          id: 'step-1',
          stage: 'preflight',
          status: 'completed',
          pluginId: 'builtin.inspect',
          inputs: ['jobs/job-1/source/0-Banner.pdf'],
          outputs: [],
          startedAt: T0,
          finishedAt: T1,
        },
      ],
    });
    await repo.save(original);
    expect(await repo.get('job-1')).toStrictEqual(original);
    expect(await repo.get('missing')).toBeUndefined();
  });

  it('replaces a job on save and deletes it', async () => {
    const repo = new SqliteJobRepository(openDatabase());
    await repo.save(job());
    await repo.save(job({ status: 'inspecting', updatedAt: T1 }));
    expect(await repo.get('job-1')).toMatchObject({ status: 'inspecting', updatedAt: T1, createdAt: T0 });
    expect(await repo.list()).toHaveLength(1);
    expect(await repo.delete('job-1')).toBe(true);
    expect(await repo.delete('job-1')).toBe(false);
    expect(await repo.get('job-1')).toBeUndefined();
  });

  it('filters list by lifecycle', async () => {
    const repo = new SqliteJobRepository(openDatabase());
    await repo.save(job({ id: 'a', status: 'done', lifecycle: 'archived', archivedAt: T1 }));
    await repo.save(job({ id: 'b', createdAt: T1 }));
    expect((await repo.list({ lifecycle: 'active' })).map((j) => j.id)).toEqual(['b']);
    expect((await repo.list({ lifecycle: 'archived' })).map((j) => j.id)).toEqual(['a']);
    expect((await repo.list()).map((j) => j.id)).toEqual(['a', 'b']);
  });

  it('pages the queue by priority, then age', async () => {
    const repo = new SqliteJobRepository(openDatabase());
    await repo.save(job({ id: 'low', priority: 10, createdAt: T0 }));
    await repo.save(job({ id: 'high-new', priority: 90, createdAt: T2 }));
    await repo.save(job({ id: 'high-old', priority: 90, createdAt: T1 }));
    await repo.save(job({ id: 'done', priority: 99, status: 'done', createdAt: T0 }));

    const all = await repo.queue();
    expect(all.items.map((j) => j.id)).toEqual(['done', 'high-old', 'high-new', 'low']);
    expect(all.total).toBe(4);

    const page = await repo.queue({ status: ['received'], limit: 1, offset: 1 });
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(page.items.map((j) => j.id)).toEqual(['high-new']);

    expect((await repo.queue({ limit: 10_000 })).limit).toBe(500);
    expect((await repo.queue({ hotFolderId: 'other' })).total).toBe(0);
  });

  it('finds only live jobs from the same hot folder for dedupe', async () => {
    const repo = new SqliteJobRepository(openDatabase());
    const sha = 'a'.repeat(64);
    await repo.save(job({ id: 'finished', status: 'done' }));
    expect(await repo.findLiveBySha256('hf-1', sha)).toBeUndefined();
    await repo.save(job({ id: 'live', status: 'queued', createdAt: T1 }));
    expect((await repo.findLiveBySha256('hf-1', sha))?.id).toBe('live');
    expect(await repo.findLiveBySha256('hf-2', sha)).toBeUndefined();
    expect(await repo.findLiveBySha256('hf-1', 'b'.repeat(64))).toBeUndefined();
  });
});

describe('SqliteHotFolderRepository', () => {
  const clock = () => new Date(T0);

  it('round-trips a hot folder with default settings', async () => {
    const repo = new SqliteHotFolderRepository(openDatabase(), clock);
    const created = await repo.create({ name: 'Banners', path: '/srv/hot/banners' });
    expect(created).toMatchObject({
      name: 'Banners',
      path: '/srv/hot/banners',
      enabled: true,
      createdAt: T0,
      settings: { moveProcessedTo: '_processed', defaultPriority: 50, filePatterns: ['*.pdf'], dedupe: true },
    });
    expect(await repo.get(created.id)).toStrictEqual(created);
    expect(await repo.findByPath('/srv/hot/banners/')).toStrictEqual(created);
    expect(await repo.list()).toStrictEqual([created]);
  });

  it('keeps a ticket template and merges settings on update', async () => {
    const repo = new SqliteHotFolderRepository(openDatabase(), clock);
    const ticketTemplate = { intent: { quantity: 3 }, process: { cut: { contour: true } } };
    const created = await repo.create({
      id: 'hf-1',
      name: 'Stickers',
      path: '/srv/hot/stickers',
      settings: { filePatterns: ['*.pdf', '*.PDF'], ticketTemplate },
    });
    const updated = await repo.update(created.id, { enabled: false, settings: { defaultPriority: 80 } });
    expect(updated.enabled).toBe(false);
    expect(updated.settings).toStrictEqual({
      moveProcessedTo: '_processed',
      defaultPriority: 80,
      filePatterns: ['*.pdf', '*.PDF'],
      dedupe: true,
      ticketTemplate,
    });
    expect(await repo.get('hf-1')).toStrictEqual(updated);
  });

  it('rejects duplicate paths and unknown ids', async () => {
    const repo = new SqliteHotFolderRepository(openDatabase(), clock);
    await repo.create({ name: 'A', path: '/srv/hot/a' });
    await expect(repo.create({ name: 'B', path: '/srv/hot/./a' })).rejects.toBeInstanceOf(DuplicateHotFolderError);
    await expect(repo.update('missing', { name: 'x' })).rejects.toBeInstanceOf(HotFolderNotFoundError);
  });
});
