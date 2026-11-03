import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobNotFoundError, InvalidKeyError, LocalDirStorage, sha256Hex } from '../src/index.js';

const bytesOf = (text: string): Uint8Array => Buffer.from(text, 'utf8');

describe('LocalDirStorage', () => {
  let root: string;
  let storage: LocalDirStorage;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bps-storage-'));
    storage = new LocalDirStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips bytes and reports size and SHA-256', async () => {
    const bytes = bytesOf('%PDF-1.7 artwork');
    const stat = await storage.put('jobs/job-1/sources/0-artwork.pdf', bytes);
    expect(stat).toEqual({ key: 'jobs/job-1/sources/0-artwork.pdf', size: bytes.byteLength, sha256: sha256Hex(bytes) });
    expect(Buffer.from(await storage.get(stat.key))).toEqual(Buffer.from(bytes));
    expect(await storage.stat(stat.key)).toEqual(stat);
  });

  it('overwrites atomically without leaving temp files behind', async () => {
    await storage.put('archive/job-1.bpsjob', bytesOf('first'));
    await storage.put('archive/job-1.bpsjob', bytesOf('second'));
    expect(Buffer.from(await storage.get('archive/job-1.bpsjob')).toString('utf8')).toBe('second');
    expect(await readdir(join(root, 'archive'))).toEqual(['job-1.bpsjob']);
  });

  it('lists keys by prefix in sorted order and hides temp files', async () => {
    await storage.put('jobs/job-2/a.pdf', bytesOf('a'));
    await storage.put('jobs/job-1/b.pdf', bytesOf('b'));
    await storage.put('jobs/job-1/a.pdf', bytesOf('a'));
    await writeFile(join(root, 'jobs', 'job-1', 'c.pdf.bps-tmp-abc123'), 'partial');

    expect(await storage.list('jobs/job-1/')).toEqual(['jobs/job-1/a.pdf', 'jobs/job-1/b.pdf']);
    expect(await storage.list()).toEqual(['jobs/job-1/a.pdf', 'jobs/job-1/b.pdf', 'jobs/job-2/a.pdf']);
  });

  it('treats missing blobs and a missing root as empty', async () => {
    await expect(storage.get('jobs/none.pdf')).rejects.toThrow(BlobNotFoundError);
    expect(await storage.stat('jobs/none.pdf')).toBeNull();
    expect(await storage.delete('jobs/none.pdf')).toBe(false);
    expect(await new LocalDirStorage(join(root, 'not-created')).list()).toEqual([]);
  });

  it('deletes a blob once', async () => {
    await storage.put('jobs/job-1/a.pdf', bytesOf('a'));
    expect(await storage.delete('jobs/job-1/a.pdf')).toBe(true);
    expect(await storage.delete('jobs/job-1/a.pdf')).toBe(false);
    expect(await storage.list()).toEqual([]);
  });

  it('rejects keys that could escape the root or collide with temp files', async () => {
    for (const key of ['../outside', 'jobs/../../outside', '/absolute', 'a//b', 'jobs\\x', '', 'jobs/a.bps-tmp-1']) {
      await expect(storage.put(key, bytesOf('x')), key).rejects.toThrow(InvalidKeyError);
    }
    expect(await readdir(root)).toEqual([]);
  });
});
