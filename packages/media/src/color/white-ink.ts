/** Generic, vendor-neutral name of the white ink separation (spec 038a). */
export const DEFAULT_WHITE_SEPARATION_NAME = 'White';
export const WHITE_INK_BYTES_PER_PIXEL = 1;
/** Upper bound on `width * height * WHITE_INK_BYTES_PER_PIXEL`, checked before any allocation. */
export const MAX_WHITE_INK_PIXELS = 100_000_000;
export const MAX_WHITE_CHOKE_PX = 64;
export const MAX_WHITE_SEPARATION_NAME_LENGTH = 63;
export const DEFAULT_WHITE_THRESHOLD = 1;
export const DEFAULT_WHITE_DENSITY = 100;

export type WhiteInkMode = 'flood' | 'spot' | 'choke';
export type WhiteChokeShape = 'square' | 'diamond';

export interface WhiteLayerInput {
  width: number;
  height: number;
  /** 8-bit artwork coverage, one byte per pixel, row-major. */
  coverage: Uint8Array;
  mode: WhiteInkMode;
  /** Coverage at or above this value selects a pixel (0..255, default 1). */
  threshold?: number;
  /** Choke radius in pixels (0..64, default 0). Only used by `choke`. */
  chokePx?: number;
  /** `square`: Chebyshev neighbourhood; `diamond`: city-block neighbourhood. Default `square`. */
  shape?: WhiteChokeShape;
  /** White ink density in percent (integer 0..100, default 100). */
  density?: number;
  /** Flip the selection (applied before the choke and the density). */
  invert?: boolean;
  /** Printable ASCII, 1..63 characters. Defaults to the generic "White". */
  separationName?: string;
}

export interface WhiteLayer {
  width: number;
  height: number;
  /** One byte per pixel: the density level where white is laid, else 0. */
  mask: Uint8Array;
  separationName: string;
  /** Pixels with a non-zero mask value. */
  coveredPixels: number;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

function fail(message: string): never {
  throw new RangeError(`planWhiteLayer: ${message}`);
}

function requireIntegerInRange(name: string, value: unknown, min: number, max: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return fail(`${name} must be an integer in ${String(min)}..${String(max)} (got ${String(value)})`);
}

/** Checks each dimension, then the byte count, without forming an out-of-range product. */
function requirePixelCount(width: unknown, height: unknown): { width: number; height: number } {
  const w = requireIntegerInRange('width', width, 1, MAX_WHITE_INK_PIXELS);
  const h = requireIntegerInRange('height', height, 1, MAX_WHITE_INK_PIXELS);
  if (w <= Math.floor(MAX_WHITE_INK_PIXELS / (h * WHITE_INK_BYTES_PER_PIXEL))) return { width: w, height: h };
  return fail(`${String(w)} x ${String(h)} pixels exceeds MAX_WHITE_INK_PIXELS (${String(MAX_WHITE_INK_PIXELS)})`);
}

function requireCoverage(coverage: unknown, pixelCount: number): Uint8Array {
  if (coverage instanceof Uint8Array && coverage.length === pixelCount) return coverage;
  if (coverage instanceof Uint8Array) {
    return fail(`coverage has ${String(coverage.length)} bytes, expected width * height = ${String(pixelCount)}`);
  }
  return fail('coverage must be a Uint8Array');
}

function requireMode(mode: unknown): WhiteInkMode {
  if (mode === 'flood' || mode === 'spot' || mode === 'choke') return mode;
  return fail(`mode must be flood, spot or choke (got ${String(mode)})`);
}

function requireShape(shape: unknown): WhiteChokeShape {
  if (shape === 'square' || shape === 'diamond') return shape;
  return fail(`shape must be square or diamond (got ${String(shape)})`);
}

function requireBoolean(name: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return fail(`${name} must be a boolean`);
}

function requireSeparationName(name: unknown): string {
  if (
    typeof name === 'string' &&
    name.length <= MAX_WHITE_SEPARATION_NAME_LENGTH &&
    PRINTABLE_ASCII.test(name) &&
    name.trim().length > 0
  ) {
    return name;
  }
  return fail(
    `separationName must be 1..${String(MAX_WHITE_SEPARATION_NAME_LENGTH)} printable ASCII characters, not blank`,
  );
}

/** round(255 · density / 100) in integer arithmetic, halves rounded up. */
export function whiteDensityToLevel(density: number): number {
  const percent = requireIntegerInRange('density', density, 0, 100);
  return Math.floor((255 * percent + 50) / 100);
}

/*
 * The square choke erodes a 0/1 mask: a pixel survives only if no 0 lies within `radius` steps.
 * Both passes count zeros in a sliding window, so each is O(pixels) independent of the radius.
 * Pixels outside the image do not erode (the window is clipped).
 */

/** Horizontal pass: a prefix count of zeros per row. */
function erodeHorizontal(mask: Uint8Array, width: number, height: number, radius: number): void {
  const zeros = new Int32Array(width + 1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) zeros[x + 1] = (zeros[x] ?? 0) + (mask[row + x] === 0 ? 1 : 0);
    for (let x = 0; x < width; x++) {
      const lo = Math.max(0, x - radius);
      const hi = Math.min(width - 1, x + radius);
      if ((zeros[hi + 1] ?? 0) - (zeros[lo] ?? 0) > 0) mask[row + x] = 0;
    }
  }
}

/** Vertical pass: per-column zero counts over a sliding band of rows, walked in row order. */
function erodeVertical(mask: Uint8Array, width: number, height: number, radius: number): void {
  const source = mask.slice();
  const zeros = new Int32Array(width);
  const addRow = (y: number, sign: number): void => {
    const row = y * width;
    for (let x = 0; x < width; x++) if (source[row + x] === 0) zeros[x] = (zeros[x] ?? 0) + sign;
  };
  for (let y = 0; y <= Math.min(height - 1, radius); y++) addRow(y, 1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) if ((zeros[x] ?? 0) > 0) mask[row + x] = 0;
    if (y + radius + 1 < height) addRow(y + radius + 1, 1);
    if (y - radius >= 0) addRow(y - radius, -1);
  }
}

/** Square (Chebyshev) erosion as a horizontal then a vertical pass. */
function erodeSquare(mask: Uint8Array, width: number, height: number, radius: number): void {
  erodeHorizontal(mask, width, height, radius);
  erodeVertical(mask, width, height, radius);
}

/** One radius-1 cross (4-neighbour) erosion; returns whether any pixel changed. */
function erodeCross(mask: Uint8Array, source: Uint8Array, width: number, height: number): boolean {
  source.set(mask);
  let changed = false;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (source[i] === 0) continue;
      if (
        (x > 0 && source[i - 1] === 0) ||
        (x < width - 1 && source[i + 1] === 0) ||
        (y > 0 && source[i - width] === 0) ||
        (y < height - 1 && source[i + width] === 0)
      ) {
        mask[i] = 0;
        changed = true;
      }
    }
  }
  return changed;
}

/** Diamond (city-block) erosion: `radius` cross erosions, each linear in the pixel count. */
function erodeDiamond(mask: Uint8Array, width: number, height: number, radius: number): void {
  const source = new Uint8Array(mask.length);
  let changed = true;
  for (let pass = 0; pass < radius && changed; pass++) changed = erodeCross(mask, source, width, height);
}

/**
 * Spec 038a: plans a white ink layer from 8-bit artwork coverage.
 * `flood` lays white everywhere; `spot` where coverage >= threshold; `choke` is `spot` eroded by
 * `chokePx` so the white stays inside the artwork edges. `invert` flips the selection before the
 * choke, and the density level is applied last. Every input is validated before the mask is allocated.
 */
export function planWhiteLayer(input: WhiteLayerInput): WhiteLayer {
  const { width, height } = requirePixelCount(input.width, input.height);
  const pixelCount = width * height;
  const coverage = requireCoverage(input.coverage, pixelCount);
  const mode = requireMode(input.mode);
  const threshold = requireIntegerInRange('threshold', input.threshold ?? DEFAULT_WHITE_THRESHOLD, 0, 255);
  const chokePx = requireIntegerInRange('chokePx', input.chokePx ?? 0, 0, MAX_WHITE_CHOKE_PX);
  const shape = requireShape(input.shape ?? 'square');
  const level = whiteDensityToLevel(input.density ?? DEFAULT_WHITE_DENSITY);
  const invert = requireBoolean('invert', input.invert ?? false);
  const separationName = requireSeparationName(input.separationName ?? DEFAULT_WHITE_SEPARATION_NAME);

  const mask = new Uint8Array(pixelCount);
  if (mode === 'flood') {
    mask.fill(invert ? 0 : 1);
  } else {
    for (let i = 0; i < pixelCount; i++) {
      const selected = (coverage[i] ?? 0) >= threshold;
      mask[i] = selected === invert ? 0 : 1;
    }
  }
  if (mode === 'choke' && chokePx > 0) {
    if (shape === 'square') erodeSquare(mask, width, height, chokePx);
    else erodeDiamond(mask, width, height, chokePx);
  }

  let coveredPixels = 0;
  if (level === 0) {
    mask.fill(0);
  } else {
    for (let i = 0; i < pixelCount; i++) {
      if (mask[i] === 1) {
        mask[i] = level;
        coveredPixels++;
      }
    }
  }
  return { width, height, mask, separationName, coveredPixels };
}
