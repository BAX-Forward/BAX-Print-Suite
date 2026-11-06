/**
 * `file` band transport (ARCHITECTURE.md §3.2, §7): band buffers live in the host-owned spool
 * directory and are passed by absolute path. Readers refuse paths that resolve outside the spool.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { RpcError } from '../stub.js';
import { DocumentErrorCodes } from './interfaces.js';
import { ErrorCodes } from './jsonrpc.js';
import type { BandHandle, FileBandHandle } from './protocol.js';

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function invalid(message: string): RpcError {
  return new RpcError(ErrorCodes.InvalidParams, message);
}

/** Resolves a `file` handle to its real path, refusing other transports and paths outside the spool. */
async function resolveSpoolFile(handle: BandHandle, spoolDir: string, kind: 'Band' | 'Document'): Promise<string> {
  const transport = (handle as { transport: unknown }).transport;
  if (transport !== 'file') {
    throw invalid(`Unsupported ${kind.toLowerCase()} transport: ${String(transport)}`);
  }
  if (!isAbsolute(handle.path)) {
    throw invalid(`${kind} path must be absolute`);
  }
  let root: string;
  let target: string;
  try {
    root = await realpath(spoolDir);
    target = await realpath(handle.path);
  } catch (error) {
    throw invalid(`${kind} file is not readable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isInside(root, target)) {
    throw invalid(`${kind} path is outside the spool directory`);
  }
  return target;
}

/** Reads a band buffer, checking the transport, spool containment (after symlinks) and size. */
export async function readFileBand(handle: BandHandle, spoolDir: string): Promise<Buffer> {
  const target = await resolveSpoolFile(handle, spoolDir, 'Band');
  const data = await readFile(target);
  if (data.byteLength !== handle.sizeBytes) {
    throw invalid(`Band size mismatch: handle has ${handle.sizeBytes} bytes, file has ${data.byteLength}`);
  }
  return data;
}

export interface DocumentExpectation {
  byteLength: number;
  /** Hex SHA-256; compared case-insensitively. */
  sha256: string;
}

function mismatch(message: string): RpcError {
  return new RpcError(ErrorCodes.InvalidParams, message, { code: DocumentErrorCodes.mismatch });
}

/**
 * Reads a finished document (spec 034a0) through a `file` handle, like `readFileBand`. The file
 * size is checked before reading, so a wrong or oversized file is never loaded; then the SHA-256.
 */
export async function readFileDocument(
  handle: FileBandHandle,
  spoolDir: string,
  expected: DocumentExpectation,
): Promise<Buffer> {
  const target = await resolveSpoolFile(handle, spoolDir, 'Document');
  if (handle.sizeBytes !== expected.byteLength) {
    throw mismatch(`Document size mismatch: handle has ${handle.sizeBytes} bytes, byteLength is ${expected.byteLength}`);
  }
  const { size } = await stat(target);
  if (size !== expected.byteLength) {
    throw mismatch(`Document size mismatch: expected ${expected.byteLength} bytes, file has ${size}`);
  }
  const data = await readFile(target);
  if (data.byteLength !== expected.byteLength) {
    throw mismatch(`Document size mismatch: expected ${expected.byteLength} bytes, read ${data.byteLength}`);
  }
  const digest = createHash('sha256').update(data).digest('hex');
  if (digest !== expected.sha256.toLowerCase()) {
    throw mismatch('Document sha256 mismatch');
  }
  return data;
}

/** Writes a band buffer at `relativePath` inside the spool and returns its handle. */
export async function writeFileBand(
  spoolDir: string,
  relativePath: string,
  data: Uint8Array,
): Promise<FileBandHandle> {
  const root = resolve(spoolDir);
  const path = resolve(root, relativePath);
  if (!isInside(root, path)) {
    throw new RangeError('Band path is outside the spool directory');
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return { transport: 'file', path, sizeBytes: data.byteLength };
}
