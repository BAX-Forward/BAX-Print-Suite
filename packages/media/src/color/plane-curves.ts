/** Spec 044a: entries in an 8-bit per-channel curve LUT, one per plane value. */
export const PLANE_CURVE_LUT_SIZE = 256;
/** Largest plane value; 255 = 100 %. */
export const PLANE_CURVE_MAX_VALUE = 255;
export const MIN_PLANE_CURVE_POINTS = 2;
export const MAX_PLANE_CURVE_POINTS = 256;
/** Upper bound on `width * height`, checked before any allocation. */
export const MAX_PLANE_CURVE_PIXELS = 100_000_000;

export type PlaneCurveInterpolation = 'monotone-cubic' | 'linear';

export interface PlaneCurvePoint {
  /** Plane value in, integer 0..255. */
  readonly input: number;
  /** Plane value out, integer 0..255. */
  readonly output: number;
}

export interface PlaneCurveOptions {
  /** Defaults to `monotone-cubic` (Fritsch-Carlson). */
  readonly interpolation?: PlaneCurveInterpolation;
}

export interface PlaneCurvePlanes {
  width: number;
  height: number;
  /** 8-bit planes, one byte per pixel, row-major; 255 = 100 %. */
  c: Uint8Array;
  m: Uint8Array;
  y: Uint8Array;
  k: Uint8Array;
}

/** One 256-entry LUT per channel; a channel without a LUT is copied unchanged. */
export interface PlaneCurveLuts {
  readonly c?: Uint8Array;
  readonly m?: Uint8Array;
  readonly y?: Uint8Array;
  readonly k?: Uint8Array;
}

export type PlaneCurveErrorCode =
  | 'INVALID_POINTS'
  | 'POINT_COUNT'
  | 'INVALID_POINT'
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'INPUT_NOT_INCREASING'
  | 'OUTPUT_DECREASING'
  | 'MISSING_ENDPOINT'
  | 'INVALID_OPTION'
  | 'INVALID_SIZE'
  | 'TOO_MANY_PIXELS'
  | 'INVALID_PLANE'
  | 'INVALID_CURVES'
  | 'INVALID_LUT';

export class PlaneCurveError extends Error {
  readonly code: PlaneCurveErrorCode;

  constructor(code: PlaneCurveErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PlaneCurveError';
    this.code = code;
  }
}

const CHANNELS: readonly string[] = ['c', 'm', 'y', 'k'];
const OPTION_KEYS: readonly string[] = ['interpolation'];

interface CurveNodes {
  xs: number[];
  ys: number[];
}

function fail(code: PlaneCurveErrorCode, message: string): never {
  throw new PlaneCurveError(code, message);
}

function rejectUnknownKeys(code: PlaneCurveErrorCode, what: string, value: object, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    fail(code, `unknown ${what} ${key}`);
  }
}

function requireInterpolation(options: unknown): PlaneCurveInterpolation {
  if (options === null) return fail('INVALID_OPTION', 'options must be an object (got null)');
  if (typeof options === 'object') {
    rejectUnknownKeys('INVALID_OPTION', 'option', options, OPTION_KEYS);
    const interpolation: unknown = Reflect.get(options, 'interpolation');
    if (interpolation === undefined) return 'monotone-cubic';
    if (interpolation === 'monotone-cubic' || interpolation === 'linear') return interpolation;
    return fail('INVALID_OPTION', `interpolation must be monotone-cubic or linear (got ${String(interpolation)})`);
  }
  return fail('INVALID_OPTION', `options must be an object (got ${String(options)})`);
}

function requireByte(code: PlaneCurveErrorCode, label: string, value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= PLANE_CURVE_MAX_VALUE) return value;
  return fail(code, `${label} must be an integer in 0..255 (got ${String(value)})`);
}

function readPoint(point: unknown, index: number): PlaneCurvePoint {
  const at = `points[${String(index)}]`;
  if (point === null) return fail('INVALID_POINT', `${at} must be an object (got null)`);
  if (typeof point === 'object') {
    const input: unknown = Reflect.get(point, 'input');
    const output: unknown = Reflect.get(point, 'output');
    return {
      input: requireByte('INVALID_INPUT', `${at}.input`, input),
      output: requireByte('INVALID_OUTPUT', `${at}.output`, output),
    };
  }
  return fail('INVALID_POINT', `${at} must be an object (got ${String(point)})`);
}

function requirePointList(points: readonly unknown[]): CurveNodes {
  if (points.length < MIN_PLANE_CURVE_POINTS || points.length > MAX_PLANE_CURVE_POINTS) {
    return fail(
      'POINT_COUNT',
      `points must have ${String(MIN_PLANE_CURVE_POINTS)}..${String(MAX_PLANE_CURVE_POINTS)} entries (got ${String(points.length)})`,
    );
  }
  const xs: number[] = [];
  const ys: number[] = [];
  points.forEach((point, index) => {
    const { input, output } = readPoint(point, index);
    // Index -1 reads undefined, and every input and output is at least 0.
    const previousInput = xs[index - 1] ?? -1;
    const previousOutput = ys[index - 1] ?? 0;
    if (input <= previousInput) {
      fail('INPUT_NOT_INCREASING', `points[${String(index)}].input ${String(input)} must be above ${String(previousInput)}`);
    }
    if (output < previousOutput) {
      fail('OUTPUT_DECREASING', `points[${String(index)}].output ${String(output)} is below ${String(previousOutput)}`);
    }
    xs.push(input);
    ys.push(output);
  });
  if (xs[0] === 0 && xs[xs.length - 1] === PLANE_CURVE_MAX_VALUE) return { xs, ys };
  return fail('MISSING_ENDPOINT', 'the first point must have input 0 and the last point input 255');
}

/** Validates the control points and returns them as parallel input and output arrays. */
function requirePoints(points: unknown): CurveNodes {
  if (Array.isArray(points)) return requirePointList(points);
  return fail('INVALID_POINTS', `points must be an array (got ${String(points)})`);
}

/** Linear segments, rounded half up in integer arithmetic: floor((2 · (y0 · h + dy · (x − x0)) + h) / (2 · h)). */
function fillLinear(lut: Uint8Array, { xs, ys }: CurveNodes): void {
  for (let s = 1; s < xs.length; s++) {
    const x0 = xs[s - 1] ?? 0;
    const x1 = xs[s] ?? 0;
    const y0 = ys[s - 1] ?? 0;
    const h = x1 - x0;
    const dy = (ys[s] ?? 0) - y0;
    for (let x = x0; x <= x1; x++) lut[x] = Math.floor((2 * (y0 * h + dy * (x - x0)) + h) / (2 * h));
  }
}

/**
 * Fritsch-Carlson tangents. Interior tangents start as the mean of the neighbouring secants, or
 * zero where the secants change sign or either is zero; the end tangents are the one-sided
 * secants. On a flat segment both tangents become zero; elsewhere, with alpha = m0 / d and
 * beta = m1 / d, both are scaled by 3 / sqrt(alpha² + beta²) when alpha² + beta² > 9.
 */
function fritschCarlsonTangents({ xs, ys }: CurveNodes): number[] {
  const secants: number[] = [];
  for (let s = 1; s < xs.length; s++) secants.push(((ys[s] ?? 0) - (ys[s - 1] ?? 0)) / ((xs[s] ?? 0) - (xs[s - 1] ?? 0)));
  const tangents = xs.map((_, i) => {
    const left = secants[i - 1];
    const right = secants[i];
    if (left === undefined) return right ?? 0;
    if (right === undefined) return left;
    return left * right > 0 ? (left + right) / 2 : 0;
  });
  secants.forEach((d, s) => {
    if (d === 0) {
      tangents[s] = 0;
      tangents[s + 1] = 0;
      return;
    }
    const alpha = (tangents[s] ?? 0) / d;
    const beta = (tangents[s + 1] ?? 0) / d;
    const radius = alpha * alpha + beta * beta;
    if (radius <= 9) return;
    const tau = 3 / Math.sqrt(radius);
    tangents[s] = tau * alpha * d;
    tangents[s + 1] = tau * beta * d;
  });
  return tangents;
}

/**
 * Cubic Hermite segments with Fritsch-Carlson tangents, rounded half up. The control points are
 * written exactly. Each value is clamped to [previous value, y1] of its segment, which keeps the
 * LUT inside 0..255 and non-decreasing even where floating-point error lands next to a half.
 */
function fillMonotoneCubic(lut: Uint8Array, nodes: CurveNodes): void {
  const { xs, ys } = nodes;
  const tangents = fritschCarlsonTangents(nodes);
  for (let s = 1; s < xs.length; s++) {
    const x0 = xs[s - 1] ?? 0;
    const x1 = xs[s] ?? 0;
    const y0 = ys[s - 1] ?? 0;
    const y1 = ys[s] ?? 0;
    const h = x1 - x0;
    const m0 = (tangents[s - 1] ?? 0) * h;
    const m1 = (tangents[s] ?? 0) * h;
    lut[x0] = y0;
    let previous = y0;
    for (let x = x0 + 1; x < x1; x++) {
      const t = (x - x0) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      const value = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (3 * t2 - 2 * t3) * y1 + (t3 - t2) * m1;
      previous = Math.min(y1, Math.max(previous, Math.floor(value + 0.5)));
      lut[x] = previous;
    }
    lut[x1] = y1;
  }
}

/**
 * Spec 044a: builds an 8-bit LUT from control points. Inputs must be strictly increasing
 * integers from 0 to 255; outputs non-decreasing integers in 0..255. `LUT[input] === output`
 * holds for every point, and the LUT never decreases.
 */
export function buildCurveLut(points: readonly PlaneCurvePoint[], options: PlaneCurveOptions = {}): Uint8Array {
  const nodes = requirePoints(points);
  const interpolation = requireInterpolation(options);
  const lut = new Uint8Array(PLANE_CURVE_LUT_SIZE);
  if (interpolation === 'linear') fillLinear(lut, nodes);
  else fillMonotoneCubic(lut, nodes);
  return lut;
}

function requireDimension(name: string, value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PLANE_CURVE_PIXELS) return value;
  return fail('INVALID_SIZE', `${name} must be an integer in 1..${String(MAX_PLANE_CURVE_PIXELS)} (got ${String(value)})`);
}

/** Checks each dimension, then the pixel count, without forming an out-of-range product. */
function requirePixelCount(width: unknown, height: unknown): number {
  const w = requireDimension('width', width);
  const h = requireDimension('height', height);
  if (w <= Math.floor(MAX_PLANE_CURVE_PIXELS / h)) return w * h;
  return fail(
    'TOO_MANY_PIXELS',
    `${String(w)} x ${String(h)} pixels exceeds MAX_PLANE_CURVE_PIXELS (${String(MAX_PLANE_CURVE_PIXELS)})`,
  );
}

function requirePlane(name: string, plane: unknown, pixelCount: number): Uint8Array {
  if (plane instanceof Uint8Array && plane.length === pixelCount) return plane;
  if (plane instanceof Uint8Array) {
    return fail('INVALID_PLANE', `plane ${name} has ${String(plane.length)} bytes, expected width * height = ${String(pixelCount)}`);
  }
  return fail('INVALID_PLANE', `plane ${name} must be a Uint8Array`);
}

function requireLut(curves: object, name: string): Uint8Array | undefined {
  const lut: unknown = Reflect.get(curves, name);
  if (lut === undefined) return undefined;
  if (lut instanceof Uint8Array && lut.length === PLANE_CURVE_LUT_SIZE) return lut;
  return fail('INVALID_LUT', `curve ${name} must be a Uint8Array of ${String(PLANE_CURVE_LUT_SIZE)} entries`);
}

function requireLuts(curves: unknown): PlaneCurveLuts {
  if (curves === null) return fail('INVALID_CURVES', 'curves must be an object (got null)');
  if (typeof curves === 'object') {
    rejectUnknownKeys('INVALID_CURVES', 'curve channel', curves, CHANNELS);
    return { c: requireLut(curves, 'c'), m: requireLut(curves, 'm'), y: requireLut(curves, 'y'), k: requireLut(curves, 'k') };
  }
  return fail('INVALID_CURVES', `curves must be an object (got ${String(curves)})`);
}

function mapPlane(plane: Uint8Array, lut: Uint8Array | undefined): Uint8Array {
  if (lut === undefined) return plane.slice();
  const out = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i++) out[i] = lut[plane[i] ?? 0] ?? 0;
  return out;
}

/**
 * Spec 044a: maps each CMYK plane through its LUT and returns new planes; a channel without a
 * curve is copied. The size, every plane and every LUT are validated before any output is
 * allocated. The input planes are never modified.
 */
export function applyPlaneCurves(planes: PlaneCurvePlanes, curves: PlaneCurveLuts): PlaneCurvePlanes {
  const pixelCount = requirePixelCount(planes.width, planes.height);
  const c = requirePlane('c', planes.c, pixelCount);
  const m = requirePlane('m', planes.m, pixelCount);
  const y = requirePlane('y', planes.y, pixelCount);
  const k = requirePlane('k', planes.k, pixelCount);
  const luts = requireLuts(curves);
  return {
    width: planes.width,
    height: planes.height,
    c: mapPlane(c, luts.c),
    m: mapPlane(m, luts.m),
    y: mapPlane(y, luts.y),
    k: mapPlane(k, luts.k),
  };
}
