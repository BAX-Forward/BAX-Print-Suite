import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestFile } from '../src/index.js';
import { FAILED, PROCESSED, failingInspector, makeDeps, makeFolder, makeTempDir } from './fakes.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('ingestFile', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
  });

  afterEach(async () => {
    vi.mocked(rename).mockClear();
    await cleanup();
  });

  it('ingests a stable file into a ready job and moves it to _processed', async () => {
    const { jobs, storage, deps } = makeDeps();
    const folder = makeFolder(dir);
    const source = join(dir, 'a.pdf');
    await writeFile(source, '%PDF-1.7 one');

    const outcome = await ingestFile(source, folder, deps);

    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;
    expect(outcome.job.status).toBe('ready');
    expect(outcome.job.pageCount).toBe(1);
    expect(outcome.job.hotFolderId).toBe(folder.id);
    expect(jobs.byId.get(outcome.job.id)?.status).toBe('ready');
    expect(storage.blobs.size).toBe(1);
    expect(outcome.movedTo).toBe(join(dir, PROCESSED, 'a.pdf'));
    expect(await exists(source)).toBe(false);
    expect(await readFile(join(dir, PROCESSED, 'a.pdf'), 'utf8')).toBe('%PDF-1.7 one');
  });

  it('reports a second file with the same sha256 as duplicate and does not re-ingest it', async () => {
    const { jobs, storage, deps } = makeDeps();
    const folder = makeFolder(dir);
    await writeFile(join(dir, 'a.pdf'), '%PDF-1.7 same');
    await writeFile(join(dir, 'b.pdf'), '%PDF-1.7 same');

    const first = await ingestFile(join(dir, 'a.pdf'), folder, deps);
    const second = await ingestFile(join(dir, 'b.pdf'), folder, deps);

    expect(first.kind).toBe('ready');
    expect(second.kind).toBe('duplicate');
    if (first.kind !== 'ready' || second.kind !== 'duplicate') return;
    expect(second.duplicateOf.id).toBe(first.job.id);
    expect(jobs.byId.size).toBe(1);
    expect(storage.blobs.size).toBe(1);
    expect(second.movedTo).toBe(join(dir, PROCESSED, 'b.pdf'));
    expect(await exists(join(dir, 'b.pdf'))).toBe(false);
  });

  it('moves the original to _failed when intake fails', async () => {
    const { jobs, deps } = makeDeps(failingInspector);
    const folder = makeFolder(dir);
    const source = join(dir, 'bad.pdf');
    await writeFile(source, 'not really a pdf');

    const outcome = await ingestFile(source, folder, deps);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.error).toEqual({ code: 'INSPECT_FAILED', message: 'not a PDF' });
    expect(outcome.job?.status).toBe('failed');
    expect(jobs.byId.get(outcome.job!.id)?.status).toBe('failed');
    expect(outcome.movedTo).toBe(join(dir, FAILED, 'bad.pdf'));
    expect(await exists(source)).toBe(false);
    expect(await readFile(join(dir, FAILED, 'bad.pdf'), 'utf8')).toBe('not really a pdf');
  });

  it('adds a suffix instead of overwriting on a name clash in _processed', async () => {
    const { deps } = makeDeps();
    const folder = makeFolder(dir);
    await mkdir(join(dir, PROCESSED));
    await writeFile(join(dir, PROCESSED, 'a.pdf'), 'earlier');
    await writeFile(join(dir, 'a.pdf'), '%PDF-1.7 new');

    const outcome = await ingestFile(join(dir, 'a.pdf'), folder, deps);

    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;
    const expected = join(dir, PROCESSED, `a-${outcome.job.id}.pdf`);
    expect(outcome.movedTo).toBe(expected);
    expect(await readFile(join(dir, PROCESSED, 'a.pdf'), 'utf8')).toBe('earlier');
    expect(await readFile(expected, 'utf8')).toBe('%PDF-1.7 new');
  });

  it('adds a suffix instead of overwriting on a name clash in _failed', async () => {
    const { deps } = makeDeps(failingInspector);
    const folder = makeFolder(dir);
    await mkdir(join(dir, FAILED));
    await writeFile(join(dir, FAILED, 'bad.pdf'), 'earlier');
    await writeFile(join(dir, 'bad.pdf'), 'new');

    const outcome = await ingestFile(join(dir, 'bad.pdf'), folder, deps);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    const expected = join(dir, FAILED, `bad-${outcome.job!.id}.pdf`);
    expect(outcome.movedTo).toBe(expected);
    expect(await readFile(join(dir, FAILED, 'bad.pdf'), 'utf8')).toBe('earlier');
    expect(await readFile(expected, 'utf8')).toBe('new');
    expect((await readdir(join(dir, FAILED))).sort()).toEqual(['bad.pdf', `bad-${outcome.job!.id}.pdf`].sort());
  });

  it('falls back to copy + unlink when rename fails with EXDEV', async () => {
    const { deps } = makeDeps();
    const folder = makeFolder(dir);
    const source = join(dir, 'x.pdf');
    await writeFile(source, '%PDF-1.7 cross-device');
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));

    const outcome = await ingestFile(source, folder, deps);

    expect(outcome.kind).toBe('ready');
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
    expect(outcome.movedTo).toBe(join(dir, PROCESSED, 'x.pdf'));
    expect(await exists(source)).toBe(false);
    expect(await readFile(join(dir, PROCESSED, 'x.pdf'), 'utf8')).toBe('%PDF-1.7 cross-device');
  });
});
