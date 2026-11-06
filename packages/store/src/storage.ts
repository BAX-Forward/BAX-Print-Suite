import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { BpsError } from '@bax-print/core';

export interface BlobStat {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
}

/** `Storage/1` blob interface (ARCHITECTURE §3.3). Keys are `/`-separated relative paths. */
export interface Storage {
  put(key: string, bytes: Uint8Array): Promise<BlobStat>;
  get(key: string): Promise<Uint8Array>;
  stat(key: string): Promise<BlobStat | null>;
  delete(key: string): Promise<boolean>;
  list(prefix?: string): Promise<string[]>;
  /**
   * Spec 052c: takes the whole local file at `path` as the blob under `key` without the caller
   * buffering it. A backend may move the file into place (LocalDirStorage) or read it and leave it
   * (MemoryStorage); either way the caller must not use `path` afterwards.
   */
  adoptFile(key: string, path: string): Promise<BlobStat>;
}

/** Error codes of a directory fsync the platform does not support (e.g. Windows: EISDIR, EPERM). */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EACCES']);

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/**
 * Spec 052c: fsyncs `dir` so a rename into it survives a crash. Where the platform cannot open or
 * sync a directory the call is skipped and `false` returned; any other failure is thrown.
 */
export async function syncDirectory(dir: string): Promise<boolean> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (typeof code === 'string' && DIRECTORY_SYNC_UNSUPPORTED.has(code)) return false;
    throw error;
  }
}

export class BlobNotFoundError extends BpsError {
  constructor(key: string) {
    super('BLOB_NOT_FOUND', `no blob stored under ${key}`);
  }
}

export class InvalidKeyError extends BpsError {
  constructor(key: string) {
    super('INVALID_KEY', `invalid storage key: ${JSON.stringify(key)}`);
  }
}

const KEY_PATTERN = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const MAX_KEY_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 120;

export function assertValidKey(key: string): void {
  if (
    key.length > MAX_KEY_LENGTH ||
    !KEY_PATTERN.test(key) ||
    key.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new InvalidKeyError(key);
  }
}

/** Turns an arbitrary file name into a safe single key segment. */
export function sanitizeKeySegment(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, MAX_SEGMENT_LENGTH);
  return cleaned === '' ? '_' : cleaned;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
