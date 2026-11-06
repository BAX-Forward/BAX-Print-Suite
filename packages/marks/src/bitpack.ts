/**
 * 1-bit screened-plane encoder (Spec 042a). A screened plane holds one byte
 * per pixel, 0 (no ink) or 255 (ink), row by row. Packed, each row is
 * `ceil(width / 8)` bytes, most significant bit first, bit 1 = ink, and the
 * unused low bits of the last byte of a row are 0. Every size is checked
 * before any buffer is allocated. Pure: no I/O and no dependencies.
 */
import { MarkSpecError } from "./errors.js";

/** Most pixels a plane may have, checked before any buffer is allocated. */
export const MAX_BITPACK_PIXELS = 100_000_000;

export type BitpackErrorCode = "BITPACK_INVALID_VALUE" | "BITPACK_INVALID_SIZE" | "BITPACK_TOO_LARGE";

/** A rejected plane or packed plane, with a stable code. */
export class BitpackError extends MarkSpecError {
  readonly code: BitpackErrorCode;

  constructor(code: BitpackErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Plane8bpp {
  readonly width: number;
  readonly height: number;
  /** `width * height` bytes, row by row, each 0 or 255. */
  readonly plane: Uint8Array;
}

export interface PackedPlane1bpp {
  readonly width: number;
  readonly height: number;
  /** `ceil(width / 8)`. */
  readonly rowBytes: number;
  /** `rowBytes * height` bytes. */
  readonly data: Uint8Array;
}

const INK = 255;
const NO_INK = 0;
const HIGH_BIT = 0x80;

function assertDimension(name: string, value: number): void {
  if (Number.isInteger(value) && value > 0) return;
  throw new BitpackError("BITPACK_INVALID_SIZE", `${name} must be a positive integer, got ${String(value)}`);
}

/** Validates width and height and returns the pixel count, compared by division so it cannot overflow. */
function pixelCount(width: number, height: number): number {
  assertDimension("width", width);
  assertDimension("height", height);
  if (width > Math.floor(MAX_BITPACK_PIXELS / height)) {
    throw new BitpackError(
      "BITPACK_TOO_LARGE",
      `plane of ${width} x ${height} pixels is more than the limit of ${MAX_BITPACK_PIXELS}`,
    );
  }
  return width * height;
}

function rowBytesFor(width: number): number {
  return Math.ceil(width / 8);
}

function assertBuffer(name: string, value: unknown, expected: number): asserts value is Uint8Array {
  if (value instanceof Uint8Array && value.length === expected) return;
  const actual = value instanceof Uint8Array ? `${value.length} bytes` : "not a Uint8Array";
  throw new BitpackError("BITPACK_INVALID_SIZE", `${name} must be a Uint8Array of ${expected} bytes, got ${actual}`);
}

function assertPlaneValues(plane: Uint8Array): void {
  const index = plane.findIndex((v) => v !== NO_INK && v !== INK);
  if (index < 0) return;
  throw new BitpackError("BITPACK_INVALID_VALUE", `plane[${index}] is ${String(plane[index])}; values must be 0 or 255`);
}

/** Packs a 0/255 plane to 1 bit per pixel. Throws BitpackError on a bad size or value. */
export function packPlane1bpp(input: Plane8bpp): PackedPlane1bpp {
  const { width, height, plane } = input;
  const pixels = pixelCount(width, height);
  assertBuffer("plane", plane, pixels);
  assertPlaneValues(plane);

  const rowBytes = rowBytesFor(width);
  const data = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = y * rowBytes;
    let acc = 0;
    for (let x = 0; x < width; x++) {
      if (plane[src + x] === INK) acc |= HIGH_BIT >>> (x & 7);
      if ((x & 7) === 7 || x === width - 1) {
        // A row's last byte is written with its padding bits never set, so they stay 0.
        data[dst + (x >>> 3)] = acc;
        acc = 0;
      }
    }
  }
  return { width, height, rowBytes, data };
}

/**
 * Unpacks a 1 bit per pixel plane to one byte per pixel, 0 or 255. Padding
 * bits are ignored. Throws BitpackError on a bad size, rowBytes or data length.
 */
export function unpackPlane1bpp(input: PackedPlane1bpp): Uint8Array {
  const { width, height, rowBytes, data } = input;
  const pixels = pixelCount(width, height);
  const expectedRowBytes = rowBytesFor(width);
  if (rowBytes !== expectedRowBytes) {
    throw new BitpackError(
      "BITPACK_INVALID_SIZE",
      `rowBytes must be ${expectedRowBytes} for width ${width}, got ${String(rowBytes)}`,
    );
  }
  assertBuffer("data", data, rowBytes * height);

  const plane = new Uint8Array(pixels);
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const dst = y * width;
    for (let x = 0; x < width; x++) {
      const byte = data[src + (x >>> 3)] ?? 0;
      if ((byte & (HIGH_BIT >>> (x & 7))) !== 0) plane[dst + x] = INK;
    }
  }
  return plane;
}
