import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidKeyError, LocalDirStorage, MemoryStorage, sha256Hex, syncDirectory } from '../src/index.js';

const BYTES = Buffer.from('%PDF-1.7\n% adopted upload\n', 'latin1');

/** Every file below `dir`, as paths relative to it. */
async function filesBelow(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

describe('Storage.adoptFile (Spec 052c)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bps-adopt-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('LocalDirStorage moves the file into place, so its bytes are stored once', async () => {
    const intake = join(dir, 'intake', 'upload.pdf');
    await mkdir(join(dir, 'intake'));
    await writeFile(intake, BYTES);
    const before = await stat(intake);
    const storage = new LocalDirStorage(join(dir, 'blobs'));

    const result = await storage.adoptFile('jobs/job-1/source/0-upload.pdf', intake);

    expect(result).toEqual({ key: 'jobs/job-1/source/0-upload.pdf', size: BYTES.byteLength, sha256: sha256Hex(BYTES) });
    expect(await filesBelow(dir)).toEqual([join('blobs', 'jobs', 'job-1', 'source', '0-upload.pdf')]);
    const blob = join(dir, 'blobs', 'jobs', 'job-1', 'source', '0-upload.pdf');
    // Same inode: renamed, not copied.
    expect((await stat(blob)).ino).toBe(before.ino);
    expect(await readFile(blob)).toEqual(BYTES);
    expect(await storage.stat(result.key)).toEqual(result);
  });

  it('LocalDirStorage refuses an invalid key and leaves the file', async () => {
    const intake = join(dir, 'upload.pdf');
    await writeFile(intake, BYTES);
    const storage = new LocalDirStorage(join(dir, 'blobs'));

    await expect(storage.adoptFile('../outside.pdf', intake)).rejects.toThrow(InvalidKeyError);
    expect(await readFile(intake)).toEqual(BYTES);
  });

  it('MemoryStorage reads the file in and reports the same size and SHA-256', async () => {
    const intake = join(dir, 'upload.pdf');
    await writeFile(intake, BYTES);
    const storage = new MemoryStorage();

    const result = await storage.adoptFile('jobs/job-1/source/0-upload.pdf', intake);

    expect(result).toEqual({ key: 'jobs/job-1/source/0-upload.pdf', size: BYTES.byteLength, sha256: sha256Hex(BYTES) });
    expect(Buffer.from(await storage.get(result.key))).toEqual(BYTES);
  });
});

describe('syncDirectory (Spec 052c)', () => {
  it('syncs an existing directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bps-sync-'));
    try {
      // `false` only where the platform cannot sync a directory (e.g. Windows).
      expect(await syncDirectory(dir)).toBe(process.platform !== 'win32');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws for a directory that does not exist', async () => {
    await expect(syncDirectory(join(tmpdir(), 'bps-sync-missing', 'none'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
