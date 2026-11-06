/** Upper bound on `width * height`, checked before any allocation. */
export const MAX_INK_LIMIT_PIXELS = 100_000_000;
export const MIN_INK_LIMIT_PERCENT = 100;
export const MAX_INK_LIMIT_PERCENT = 400;
/** Plane value of a 100 % channel. */
export const INK_PLANE_FULL = 255;

export type InkLimitMethod = 'proportional' | 'gcr';

export interface InkLimitInput {
  width: number;
  height: number;
  /** 8-bit planes, one byte per pixel, row-major; 255 = 100 %. */
  c: Uint8Array;
  m: Uint8Array;
  y: Uint8Array;
  k: Uint8Array;
  /** Total area coverage limit in percent (integer 100..400). */
  limitPercent: number;
  /** `proportional`: scale all four channels; `gcr`: move the grey component into K first. */
  method: InkLimitMethod;
}

export interface InkLimitResult {
  c: Uint8Array;
  m: Uint8Array;
  y: Uint8Array;
  k: Uint8Array;
  /** Pixels where at least one channel changed. */
  changedPixels: number;
}

function fail(message: string): never {
  throw new RangeError(`limitInk: ${message}`);
}

function requireIntegerInRange(name: string, value: unknown, min: number, max: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return fail(`${name} must be an integer in ${String(min)}..${String(max)} (got ${String(value)})`);
}

/** Checks each dimension, then the pixel count, without forming an out-of-range product. */
function requirePixelCount(width: unknown, height: unknown): { width: number; height: number } {
  const w = requireIntegerInRange('width', width, 1, MAX_INK_LIMIT_PIXELS);
  const h = requireIntegerInRange('height', height, 1, MAX_INK_LIMIT_PIXELS);
  if (w <= Math.floor(MAX_INK_LIMIT_PIXELS / h)) return { width: w, height: h };
  return fail(`${String(w)} x ${String(h)} pixels exceeds MAX_INK_LIMIT_PIXELS (${String(MAX_INK_LIMIT_PIXELS)})`);
}

function requirePlane(name: string, plane: unknown, pixelCount: number): Uint8Array {
  if (plane instanceof Uint8Array && plane.length === pixelCount) return plane;
  if (plane instanceof Uint8Array) {
    return fail(`plane ${name} has ${String(plane.length)} bytes, expected width * height = ${String(pixelCount)}`);
  }
  return fail(`plane ${name} must be a Uint8Array`);
}

function requireMethod(method: unknown): InkLimitMethod {
  if (method === 'proportional' || method === 'gcr') return method;
  return fail(`method must be proportional or gcr (got ${String(method)})`);
}

/** The limit in plane units: floor(limitPercent · 255 / 100) in integer arithmetic. */
export function inkLimitToPlaneUnits(limitPercent: number): number {
  const percent = requireIntegerInRange('limitPercent', limitPercent, MIN_INK_LIMIT_PERCENT, MAX_INK_LIMIT_PERCENT);
  return Math.floor((percent * INK_PLANE_FULL) / 100);
}

/**
 * Scales `values` so they sum to at most `target`: each becomes floor(v · target / sum).
 * The floors sum to at most target · sum / sum = target, so the result is never above the
 * target, and each value only shrinks (target < sum).
 */
function scaleDown(values: number[], sum: number, target: number): void {
  for (let i = 0; i < values.length; i++) values[i] = Math.floor(((values[i] ?? 0) * target) / sum);
}

/**
 * Spec 040a: limits the total ink of each CMYK pixel to `limitPercent`.
 * Pixels at or below the limit are copied unchanged. `proportional` scales all four channels
 * down with integer floor math. `gcr` first moves the smallest amount t of the grey component
 * min(C, M, Y) into K that reaches the limit (bounded by the grey component and by K reaching
 * 255); each unit moved lowers the sum by 2. If the pixel is still above the limit, C, M and Y
 * are scaled down with K kept. Every input is validated before the output planes are allocated.
 */
export function limitInk(input: InkLimitInput): InkLimitResult {
  const { width, height } = requirePixelCount(input.width, input.height);
  const pixelCount = width * height;
  const c = requirePlane('c', input.c, pixelCount);
  const m = requirePlane('m', input.m, pixelCount);
  const y = requirePlane('y', input.y, pixelCount);
  const k = requirePlane('k', input.k, pixelCount);
  const limit = inkLimitToPlaneUnits(input.limitPercent);
  const method = requireMethod(input.method);

  const outC = c.slice();
  const outM = m.slice();
  const outY = y.slice();
  const outK = k.slice();
  const cmyk = [0, 0, 0, 0];
  const cmy = [0, 0, 0];
  let changedPixels = 0;

  for (let i = 0; i < pixelCount; i++) {
    const c0 = c[i] ?? 0;
    const m0 = m[i] ?? 0;
    const y0 = y[i] ?? 0;
    const k0 = k[i] ?? 0;
    const sum = c0 + m0 + y0 + k0;
    if (sum <= limit) continue;

    if (method === 'proportional') {
      cmyk[0] = c0;
      cmyk[1] = m0;
      cmyk[2] = y0;
      cmyk[3] = k0;
      scaleDown(cmyk, sum, limit);
      outC[i] = cmyk[0] ?? 0;
      outM[i] = cmyk[1] ?? 0;
      outY[i] = cmyk[2] ?? 0;
      outK[i] = cmyk[3] ?? 0;
    } else {
      const needed = Math.ceil((sum - limit) / 2);
      const t = Math.min(needed, c0, m0, y0, INK_PLANE_FULL - k0);
      const k1 = k0 + t;
      cmy[0] = c0 - t;
      cmy[1] = m0 - t;
      cmy[2] = y0 - t;
      const cmySum = c0 + m0 + y0 - 3 * t;
      // limit >= 255 >= k1, so the C, M, Y budget is never negative.
      if (cmySum + k1 > limit) scaleDown(cmy, cmySum, limit - k1);
      outC[i] = cmy[0] ?? 0;
      outM[i] = cmy[1] ?? 0;
      outY[i] = cmy[2] ?? 0;
      outK[i] = k1;
    }
    if (outC[i] !== c0 || outM[i] !== m0 || outY[i] !== y0 || outK[i] !== k0) changedPixels++;
  }
  return { c: outC, m: outM, y: outY, k: outK, changedPixels };
}
