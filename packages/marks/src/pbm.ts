/**
 * 1-bit PBM writer and strict parser (Spec 042b). The format is Netpbm's raw
 * PBM ("P4"): an ASCII header, then the packed rows. Each row is
 * `ceil(width / 8)` bytes, most significant bit first. In PBM bit 1 = black,
 * which matches the Spec 042a packed plane, where 255 = ink = bit 1, so a
 * `PackedPlane1bpp` is written as is, with no inversion.
 *
 * Every size is checked before any buffer is allocated. Pure: no I/O and no
 * dependencies.
 */
import type { PackedPlane1bpp } from "./bitpack.js";
import { MarkSpecError } from "./errors.js";

/** Largest width or height a PBM may have. */
export const MAX_PBM_SIDE = 65_535;
/** Most pixels a PBM may have, checked before any buffer is allocated. */
export const MAX_PBM_PIXELS = 100_000_000;

export type PbmErrorCode = "PBM_INVALID_HEADER" | "PBM_INVALID_SIZE" | "PBM_TOO_LARGE" | "PBM_DATA_LENGTH";

/** A rejected PBM file or packed plane, with a stable code. */
export class PbmError extends MarkSpecError {
  readonly code: PbmErrorCode;

  constructor(code: PbmErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const MAGIC_P = 0x50;
const MAGIC_4 = 0x34;
const LF = 0x0a;
const SPACE = 0x20;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
/** Digits in MAX_PBM_SIDE. A longer number is too large, so it is not read further. */
const MAX_DIMENSION_DIGITS = String(MAX_PBM_SIDE).length;

function assertDimension(name: string, value: number): void {
  if (Number.isInteger(value) && value > 0) return;
  throw new PbmError("PBM_INVALID_SIZE", `${name} must be a positive integer, got ${String(value)}`);
}

/** Validates width and height against the caps, compared by division so it cannot overflow. */
function assertSize(width: number, height: number): void {
  assertDimension("width", width);
  assertDimension("height", height);
  if (width > MAX_PBM_SIDE || height > MAX_PBM_SIDE) {
    throw new PbmError("PBM_TOO_LARGE", `PBM of ${width} x ${height} pixels has a side over the limit of ${MAX_PBM_SIDE}`);
  }
  if (width > Math.floor(MAX_PBM_PIXELS / height)) {
    throw new PbmError("PBM_TOO_LARGE", `PBM of ${width} x ${height} pixels is more than the limit of ${MAX_PBM_PIXELS}`);
  }
}

function rowBytesFor(width: number): number {
  return Math.ceil(width / 8);
}

function assertRowBytes(width: number, rowBytes: number): void {
  const expected = rowBytesFor(width);
  if (rowBytes === expected) return;
  throw new PbmError("PBM_INVALID_SIZE", `rowBytes must be ${expected} for width ${width}, got ${String(rowBytes)}`);
}

function assertData(data: unknown, expected: number): asserts data is Uint8Array {
  if (data instanceof Uint8Array && data.length === expected) return;
  const actual = data instanceof Uint8Array ? `${data.length} bytes` : "not a Uint8Array";
  throw new PbmError("PBM_DATA_LENGTH", `data must be a Uint8Array of ${expected} bytes, got ${actual}`);
}

/** The header as ASCII bytes. Width and height are validated integers, so every character is ASCII. */
function headerBytes(width: number, height: number): Uint8Array {
  const text = `P4\n${String(width)} ${String(height)}\n`;
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/**
 * Writes a packed plane (the `packPlane1bpp` output) as a raw PBM:
 * `P4\n<width> <height>\n` followed by the rows unchanged. Throws PbmError on
 * a bad or over-cap size, a rowBytes other than `ceil(width / 8)`, or data
 * that is not `rowBytes * height` bytes.
 */
export function writePbmP4(input: PackedPlane1bpp): Uint8Array {
  const { width, height, rowBytes, data } = input;
  assertSize(width, height);
  assertRowBytes(width, rowBytes);
  assertData(data, rowBytes * height);

  const header = headerBytes(width, height);
  const out = new Uint8Array(header.length + data.length);
  out.set(header, 0);
  out.set(data, header.length);
  return out;
}

function isDigit(byte: number | undefined): boolean {
  return typeof byte === "number" && byte >= DIGIT_0 && byte <= DIGIT_9;
}

/** Returns the position after `expected`, or throws PBM_INVALID_HEADER. */
function expectByte(bytes: Uint8Array, pos: number, expected: number, what: string): number {
  if (bytes[pos] === expected) return pos + 1;
  throw new PbmError("PBM_INVALID_HEADER", `expected ${what} at byte ${pos}`);
}

/** Reads a decimal number with no sign and no leading zero, at most MAX_DIMENSION_DIGITS digits. */
function readDimension(bytes: Uint8Array, pos: number, name: string): { readonly value: number; readonly next: number } {
  let next = pos;
  while (isDigit(bytes[next])) {
    next++;
    if (next - pos > MAX_DIMENSION_DIGITS) {
      throw new PbmError("PBM_TOO_LARGE", `${name} has more than ${MAX_DIMENSION_DIGITS} digits`);
    }
  }
  if (next === pos) {
    throw new PbmError("PBM_INVALID_HEADER", `${name} must be a decimal integer at byte ${pos}`);
  }
  if (bytes[pos] === DIGIT_0 && next - pos > 1) {
    throw new PbmError("PBM_INVALID_HEADER", `${name} must not have a leading zero at byte ${pos}`);
  }
  let value = 0;
  for (let i = pos; i < next; i++) value = value * 10 + (bytes[i] ?? DIGIT_0) - DIGIT_0;
  return { value, next };
}

/**
 * Parses a raw PBM written by `writePbmP4`. This is a strict subset of
 * Netpbm, sufficient for our own writer: the magic is exactly `P4`, then a
 * single whitespace byte which must be LF, the decimal width, a single space,
 * the decimal height, a single LF, then exactly `ceil(width / 8) * height`
 * data bytes. Comments (`#`), tabs, CR, repeated whitespace, signs, leading
 * zeros and numbers over MAX_DIMENSION_DIGITS digits are rejected, as are
 * missing and trailing data bytes. Padding bits are returned as they are.
 * The size caps are checked before any buffer is allocated. The returned
 * data is a copy. Throws PbmError.
 */
export function parsePbmP4(bytes: Uint8Array): PackedPlane1bpp {
  let pos = expectByte(bytes, 0, MAGIC_P, "magic P4");
  pos = expectByte(bytes, pos, MAGIC_4, "magic P4");
  pos = expectByte(bytes, pos, LF, "a single LF after the magic");
  const width = readDimension(bytes, pos, "width");
  pos = expectByte(bytes, width.next, SPACE, "a single space after the width");
  const height = readDimension(bytes, pos, "height");
  pos = expectByte(bytes, height.next, LF, "a single LF after the height");

  assertSize(width.value, height.value);
  const rowBytes = rowBytesFor(width.value);
  const expectedLength = rowBytes * height.value;
  const actualLength = bytes.length - pos;
  if (actualLength === expectedLength) {
    return { width: width.value, height: height.value, rowBytes, data: bytes.slice(pos) };
  }
  throw new PbmError("PBM_DATA_LENGTH", `PBM data must be ${expectedLength} bytes, got ${actualLength}`);
}
