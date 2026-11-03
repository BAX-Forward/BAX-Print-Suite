import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  assertValidKey,
  BlobNotFoundError,
  InvalidKeyError,
  sha256Hex,
  type BlobStat,
  type Storage,
} from './storage.js';

const TMP_MARKER = '.bps-tmp-';

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
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
