import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  assertValidKey,
  BlobNotFoundError,
  InvalidKeyError,
  sha256Hex,
  syncDirectory,
  type BlobStat,
  type Storage,
} from './storage.js';

const TMP_MARKER = '.bps-tmp-';

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, 'ENOENT');
}

/** Size and SHA-256 of a file, read as a stream. */
async function hashFile(path: string): Promise<{ readonly size: number; readonly sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const chunks: AsyncIterable<unknown> = createReadStream(path);
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError(`expected bytes reading ${path}`);
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return { size, sha256: hash.digest('hex') };
}

/** Built-in `Storage/1` backend on a local directory. Writes are atomic (temp file + rename). */
export class LocalDirStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    if (key.includes(TMP_MARKER)) {
      throw new InvalidKeyError(key);
    }
    const full = resolve(this.root, ...key.split('/'));
    if (!full.startsWith(this.root + sep)) {
      throw new InvalidKeyError(key);
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<BlobStat> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}${TMP_MARKER}${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(temp, bytes);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return { key, size: bytes.byteLength, sha256: sha256Hex(bytes) };
  }

  /**
   * Spec 052c: moves the file at `path` into place with one rename, so its bytes are stored once,
   * then fsyncs the blob directory. Across file systems (EXDEV) it is copied in and removed instead.
   */
  async adoptFile(key: string, path: string): Promise<BlobStat> {
    const target = this.pathFor(key);
    const { size, sha256 } = await hashFile(path);
    await mkdir(dirname(target), { recursive: true });
    try {
      await rename(path, target);
    } catch (error) {
      if (!hasCode(error, 'EXDEV')) throw error;
      const temp = `${target}${TMP_MARKER}${randomBytes(6).toString('hex')}`;
      try {
        await copyFile(path, temp);
        await rename(temp, target);
      } catch (copyError) {
        await rm(temp, { force: true });
        throw copyError;
      }
      await rm(path, { force: true });
    }
    await syncDirectory(dirname(target));
    return { key, size, sha256 };
  }

  async get(key: string): Promise<Uint8Array> {
    const path = this.pathFor(key);
    try {
      return await readFile(path);
    } catch (error) {
      if (isNotFound(error)) throw new BlobNotFoundError(key);
      throw error;
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    try {
      const bytes = await this.get(key);
      return { key, size: bytes.byteLength, sha256: sha256Hex(bytes) };
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    const path = this.pathFor(key);
    try {
      await rm(path);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async list(prefix = ''): Promise<string[]> {
    const keys: string[] = [];
    await this.walk(this.root, [], keys);
    return keys.filter((key) => key.startsWith(prefix)).sort();
  }

  private async walk(dir: string, segments: readonly string[], keys: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      if (isNotFound(error)) return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.walk(join(dir, entry.name), [...segments, entry.name], keys);
      } else if (entry.isFile() && !entry.name.includes(TMP_MARKER)) {
        keys.push([...segments, entry.name].join('/'));
      }
    }
  }
}
