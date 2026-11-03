import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { BpsError } from '@bax-print/core';
import { crc32 } from './crc32.js';

/**
 * Minimal ZIP writer/reader after PKWARE APPNOTE 6.3: stored (0) and deflate (8) methods,
 * UTF-8 names (flag bit 11), no ZIP64, no encryption, no data descriptors.
 */

export interface ZipEntryInput {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface WriteZipOptions {
  /** Timestamp written for every entry; fixed so equal input gives equal bytes. */
  readonly modifiedAt?: Date;
}

export interface ReadZipOptions {
  readonly maxTotalBytes?: number;
}

export class ZipFormatError extends BpsError {
  constructor(message: string, options?: ErrorOptions) {
    super('ZIP_FORMAT', message, options);
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION = 20;
const MAX_32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 ** 3;
const DOS_EPOCH = new Date(Date.UTC(1980, 0, 1));

export function assertSafeEntryName(name: string): void {
  const unsafe =
    name === '' ||
    name.length > 0xffff ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
  if (unsafe) {
    throw new ZipFormatError(`unsafe entry name: ${JSON.stringify(name)}`);
  }
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export function writeZip(entries: readonly ZipEntryInput[], options: WriteZipOptions = {}): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new ZipFormatError(`too many entries (${entries.length}); ZIP64 is not supported`);
  }
  const stamp = dosDateTime(options.modifiedAt ?? DOS_EPOCH);
  const seen = new Set<string>();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeEntryName(entry.name);
    if (seen.has(entry.name)) {
      throw new ZipFormatError(`duplicate entry name: ${entry.name}`);
    }
    seen.add(entry.name);

    const data = entry.data;
    if (data.byteLength >= MAX_32) {
      throw new ZipFormatError(`entry ${entry.name} is too large; ZIP64 is not supported`);
    }
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(data);
    const method = deflated.byteLength < data.byteLength ? METHOD_DEFLATE : METHOD_STORE;
    const body = method === METHOD_DEFLATE ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(LOCAL_HEADER_SIZE);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(CENTRAL_HEADER_SIZE);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, body);
    centralParts.push(central, name);
    offset += LOCAL_HEADER_SIZE + name.byteLength + body.byteLength;
    if (offset >= MAX_32) {
      throw new ZipFormatError('archive is too large; ZIP64 is not supported');
    }
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function need(buf: Buffer, offset: number, length: number): void {
  if (offset < 0 || offset + length > buf.byteLength) {
    throw new ZipFormatError('archive is truncated');
  }
}

function findEocd(buf: Buffer): number {
  if (buf.byteLength < EOCD_SIZE) {
    throw new ZipFormatError('not a ZIP archive: too short');
  }
  const lowest = Math.max(0, buf.byteLength - EOCD_SIZE - MAX_COMMENT);
  for (let i = buf.byteLength - EOCD_SIZE; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD && i + EOCD_SIZE + buf.readUInt16LE(i + 20) === buf.byteLength) {
      return i;
    }
  }
  throw new ZipFormatError('not a ZIP archive: end of central directory not found');
}

/** Reads every entry, verifying sizes and CRC-32. Returns name → uncompressed bytes. */
export function readZip(bytes: Uint8Array, options: ReadZipOptions = {}): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 || buf.readUInt16LE(eocd + 8) !== total) {
    throw new ZipFormatError('multi-disk archives are not supported');
  }
  if (centralOffset + centralSize > eocd) {
    throw new ZipFormatError('central directory overlaps the end record');
  }

  const out = new Map<string, Uint8Array>();
  let totalBytes = 0;
  let p = centralOffset;
  for (let i = 0; i < total; i++) {
    need(buf, p, CENTRAL_HEADER_SIZE);
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipFormatError('bad central directory signature');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    need(buf, p + CENTRAL_HEADER_SIZE, nameLength);
    const name = buf.toString('utf8', p + CENTRAL_HEADER_SIZE, p + CENTRAL_HEADER_SIZE + nameLength);
    p += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;

    if (flags & FLAG_ENCRYPTED) throw new ZipFormatError(`entry ${name} is encrypted`);
    if (compressedSize === MAX_32 || size === MAX_32 || localOffset === MAX_32) {
      throw new ZipFormatError(`entry ${name} needs ZIP64, which is not supported`);
    }
    assertSafeEntryName(name);
    if (out.has(name)) throw new ZipFormatError(`duplicate entry name: ${name}`);

    need(buf, localOffset, LOCAL_HEADER_SIZE);
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new ZipFormatError(`bad local header signature for ${name}`);
    }
    const dataStart = localOffset + LOCAL_HEADER_SIZE + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > centralOffset) {
      throw new ZipFormatError(`entry ${name} overlaps the central directory`);
    }
    totalBytes += size;
    if (totalBytes > maxTotal) {
      throw new ZipFormatError(`archive expands beyond ${maxTotal} bytes`);
    }

    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === METHOD_STORE) {
      if (compressedSize !== size) throw new ZipFormatError(`stored entry ${name} has inconsistent sizes`);
      data = Buffer.from(raw);
    } else if (method === METHOD_DEFLATE) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      } catch (error) {
        throw new ZipFormatError(`cannot inflate entry ${name}`, { cause: error });
      }
    } else {
      throw new ZipFormatError(`entry ${name} uses unsupported compression method ${method}`);
    }
    if (data.byteLength !== size || crc32(data) !== crc) {
      throw new ZipFormatError(`entry ${name} fails its CRC-32 check`);
    }
    out.set(name, data);
  }
  return out;
}
