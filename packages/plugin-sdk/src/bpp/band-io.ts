/**
 * `file` band transport (ARCHITECTURE.md §3.2, §7): band buffers live in the host-owned spool
 * directory and are passed by absolute path. Readers refuse paths that resolve outside the spool.
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { RpcError } from '../stub.js';
import { ErrorCodes } from './jsonrpc.js';
import type { BandHandle, FileBandHandle } from './protocol.js';

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function invalid(message: string): RpcError {
  return new RpcError(ErrorCodes.InvalidParams, message);
}

/** Reads a band buffer, checking the transport, spool containment (after symlinks) and size. */
export async function readFileBand(handle: BandHandle, spoolDir: string): Promise<Buffer> {
  const transport = (handle as { transport: unknown }).transport;
  if (transport !== 'file') {
    throw invalid(`Unsupported band transport: ${String(transport)}`);
  }
  if (!isAbsolute(handle.path)) {
    throw invalid('Band path must be absolute');
  }
  let root: string;
  let target: string;
  try {
    root = await realpath(spoolDir);
    target = await realpath(handle.path);
  } catch (error) {
    throw invalid(`Band file is not readable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isInside(root, target)) {
    throw invalid('Band path is outside the spool directory');
  }
  const data = await readFile(target);
  if (data.byteLength !== handle.sizeBytes) {
    throw invalid(`Band size mismatch: handle has ${handle.sizeBytes} bytes, file has ${data.byteLength}`);
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
