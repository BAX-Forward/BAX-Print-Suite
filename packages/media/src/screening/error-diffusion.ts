/**
 * Spec 045a: error-diffusion screening of one 8-bit plane.
 *
 * Each pixel is set to 255 when its value plus the error diffused into it is at least 128, else to 0.
 * The difference between that corrected value and the output is spread over the unvisited neighbours
 * with one of two public-domain kernels (X is the current pixel, weights in scan direction):
 *
 * Floyd-Steinberg (1976), divisor 16:
 *
 *            X   7
 *        3   5   1
 *
 * Jarvis-Judice-Ninke (1976), divisor 48:
 *
 *                X   7   5
 *        3   5   7   5   3
 *        1   3   5   3   1
 *
 * Raster order scans every row left to right. Serpentine order scans odd rows (y = 1, 3, ...) right
 * to left with the kernel mirrored, so error always flows ahead of the scan.
 *
 * Arithmetic is integer only. Error buffers are Int32 and hold numerators over the kernel divisor:
 * a pixel's error `e` adds `e · weight` to each neighbour. When a pixel is reached its accumulated
 * numerator `n` is divided once by the divisor `d`, rounding half up: `floor((2n + d) / (2d))`.
 * The corrected value is the pixel value plus that integer, and its error is the corrected value
 * minus the output (0 or 255). Error that would land outside the image is dropped.
 *
 * Only the current row and the next one (Floyd-Steinberg) or two (Jarvis-Judice-Ninke) error rows
 * are kept, in one ring buffer padded by the kernel radius on both sides so taps need no bounds
 * checks. Every input is validated before the ring buffer or the output is allocated.
 */
import { SCREEN_DOT_ON } from './dot.js';
import { MAX_SCREEN_PIXELS } from './threshold.js';

/** Corrected values at or above this are on. */
export const ERROR_DIFFUSION_THRESHOLD = 128;
export const ERROR_DIFFUSION_KERNELS = ['floyd-steinberg', 'jarvis-judice-ninke'] as const;

export type ErrorDiffusionKernel = (typeof ERROR_DIFFUSION_KERNELS)[number];

export interface ErrorDiffusionInput {
  width: number;
  height: number;
  /** 8-bit coverage, one byte per pixel, row-major. */
  plane: Uint8Array;
}

export interface ErrorDiffusionOptions {
  kernel: ErrorDiffusionKernel;
  /** Scan odd rows right to left with the kernel mirrored (default false). */
  serpentine?: boolean;
}

/** One kernel tap: `[dx, dy, weight]`, `dx` in raster scan direction. */
type Tap = readonly [number, number, number];

interface KernelSpec {
  divisor: number;
  /** Largest `|dx|`, the padding on each side of an error row. */
  radius: number;
  /** Largest `dy`; the ring buffer holds `depth + 1` rows. */
  depth: number;
  taps: readonly Tap[];
}

const KERNELS: Readonly<Record<ErrorDiffusionKernel, KernelSpec>> = {
  'floyd-steinberg': {
    divisor: 16,
    radius: 1,
    depth: 1,
    taps: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
  },
  'jarvis-judice-ninke': {
    divisor: 48,
    radius: 2,
    depth: 2,
    taps: [
      [1, 0, 7],
      [2, 0, 5],
      [-2, 1, 3],
      [-1, 1, 5],
      [0, 1, 7],
      [1, 1, 5],
      [2, 1, 3],
      [-2, 2, 1],
      [-1, 2, 3],
      [0, 2, 5],
      [1, 2, 3],
      [2, 2, 1],
    ],
  },
};

const DIFFUSE = 'applyErrorDiffusion';
const OPTION_KEYS: readonly string[] = ['kernel', 'serpentine'];

function fail(message: string): never {
  throw new RangeError(`${DIFFUSE}: ${message}`);
}

function requireIntegerInRange(name: string, value: unknown, min: number, max: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return fail(`${name} must be an integer in ${String(min)}..${String(max)} (got ${String(value)})`);
}

/** Checks each dimension, then the pixel count, without forming an out-of-range product. */
function requirePixelCount(width: unknown, height: unknown): { width: number; height: number } {
  const w = requireIntegerInRange('width', width, 1, MAX_SCREEN_PIXELS);
  const h = requireIntegerInRange('height', height, 1, MAX_SCREEN_PIXELS);
  if (w <= Math.floor(MAX_SCREEN_PIXELS / h)) return { width: w, height: h };
  return fail(`${String(w)} x ${String(h)} pixels exceeds MAX_SCREEN_PIXELS (${String(MAX_SCREEN_PIXELS)})`);
}

function requirePlane(plane: unknown, pixelCount: number): Uint8Array {
  if (plane instanceof Uint8Array && plane.length === pixelCount) return plane;
  if (plane instanceof Uint8Array) {
    return fail(`plane has ${String(plane.length)} bytes, expected width * height = ${String(pixelCount)}`);
  }
  return fail('plane must be a Uint8Array');
}

function requireInput(input: unknown): ErrorDiffusionInput {
  if (typeof input === 'object' && input) {
    const { width, height } = requirePixelCount(
      'width' in input ? input.width : undefined,
      'height' in input ? input.height : undefined,
    );
    return { width, height, plane: requirePlane('plane' in input ? input.plane : undefined, width * height) };
  }
  return fail('input must be an object with width, height and plane');
}

function requireKernel(kernel: unknown): ErrorDiffusionKernel {
  for (const name of ERROR_DIFFUSION_KERNELS) if (name === kernel) return name;
  return fail(`options.kernel must be ${ERROR_DIFFUSION_KERNELS.join(' or ')} (got ${String(kernel)})`);
}

function requireOptions(options: unknown): { kernel: ErrorDiffusionKernel; serpentine: boolean } {
  if (typeof options === 'object' && options) {
    for (const key of Object.keys(options)) {
      if (OPTION_KEYS.includes(key)) continue;
      return fail(`options has unknown key ${key}`);
    }
    const kernel = requireKernel('kernel' in options ? options.kernel : undefined);
    const serpentine = 'serpentine' in options ? options.serpentine : undefined;
    if (serpentine === undefined || typeof serpentine === 'boolean') {
      return { kernel, serpentine: serpentine ?? false };
    }
    return fail(`options.serpentine must be a boolean (got ${String(serpentine)})`);
  }
  return fail('options must be an object with a kernel');
}

/** `n / d` rounded half up, for `d > 0`; exact because `|n|` stays far below 2^52. */
function roundedQuotient(n: number, d: number): number {
  return Math.floor((2 * n + d) / (2 * d));
}

/**
 * Spec 045a: screens an 8-bit plane by error diffusion (see the module doc for the kernels, scan
 * orders and rounding). Returns a new plane holding only 0 and 255; the input is not modified.
 * Same input and options give byte-identical output.
 */
export function applyErrorDiffusion(input: ErrorDiffusionInput, options: ErrorDiffusionOptions): Uint8Array {
  const { width, height, plane } = requireInput(input);
  const { kernel, serpentine } = requireOptions(options);
  const { divisor, radius, depth, taps } = KERNELS[kernel];

  const ringRows = depth + 1;
  const stride = width + 2 * radius;
  const errors = new Int32Array(ringRows * stride);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const mirrored = serpentine && y % 2 === 1;
    const step = mirrored ? -1 : 1;
    const current = (y % ringRows) * stride + radius;
    for (let i = 0; i < width; i++) {
      const x = mirrored ? width - 1 - i : i;
      const p = y * width + x;
      const value = (plane[p] ?? 0) + roundedQuotient(errors[current + x] ?? 0, divisor);
      const dot = value >= ERROR_DIFFUSION_THRESHOLD ? SCREEN_DOT_ON : 0;
      out[p] = dot;
      const error = value - dot;
      if (error === 0) continue;
      for (const [dx, dy, weight] of taps) {
        const q = ((y + dy) % ringRows) * stride + radius + x + dx * step;
        errors[q] = (errors[q] ?? 0) + error * weight;
      }
    }
    const row = (y % ringRows) * stride;
    errors.fill(0, row, row + stride);
  }
  return out;
}
