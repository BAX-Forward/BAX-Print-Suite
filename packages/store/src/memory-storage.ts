import { readFile } from 'node:fs/promises';
import { assertValidKey, BlobNotFoundError, sha256Hex, type BlobStat, type Storage } from './storage.js';

/** In-memory `Storage/1` backend for tests and ephemeral runs. Stores copies. */
export class MemoryStorage implements Storage {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<BlobStat> {
    assertValidKey(key);
    const copy = new Uint8Array(bytes);
    this.blobs.set(key, copy);
    return { key, size: copy.byteLength, sha256: sha256Hex(copy) };
  }

  /** Spec 052c: memory has no file to move into, so the bytes are read in and the file is left where it is. */
  async adoptFile(key: string, path: string): Promise<BlobStat> {
    assertValidKey(key);
    return this.put(key, await readFile(path));
  }

  async get(key: string): Promise<Uint8Array> {
    assertValidKey(key);
    const bytes = this.blobs.get(key);
    if (!bytes) {
      throw new BlobNotFoundError(key);
    }
    return new Uint8Array(bytes);
  }

  async stat(key: string): Promise<BlobStat | null> {
    assertValidKey(key);
    const bytes = this.blobs.get(key);
    return bytes ? { key, size: bytes.byteLength, sha256: sha256Hex(bytes) } : null;
  }

  async delete(key: string): Promise<boolean> {
    assertValidKey(key);
    return this.blobs.delete(key);
  }

  async list(prefix = ''): Promise<string[]> {
    return [...this.blobs.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
