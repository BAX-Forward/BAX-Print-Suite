import {
  type InkLimitMethod,
  MAX_INK_LIMIT_PERCENT,
  MAX_INK_LIMIT_PIXELS,
  MIN_INK_LIMIT_PERCENT,
  limitInk,
} from '../color/ink-limit.js';
import { MAX_PLANE_CURVE_PIXELS, type PlaneCurveLuts, applyPlaneCurves } from '../color/plane-curves.js';
import { SCREEN_DOT_ON } from './dot.js';
import { ERROR_DIFFUSION_KERNELS, type ErrorDiffusionKernel, applyErrorDiffusion } from './error-diffusion.js';
import {
  BAYER_SIZES,
  type BayerSize,
  MAX_SCREEN_PIXELS,
  MAX_THRESHOLD_ARRAY_SIZE,
  type ThresholdArray,
  applyThresholdScreen,
  bayerArray,
  blueNoiseArray,
} from './threshold.js';

/** The pipeline runs every stage, so it accepts the smallest of their pixel caps. */
export const MAX_SCREEN_PIPELINE_PIXELS = Math.min(MAX_INK_LIMIT_PIXELS, MAX_PLANE_CURVE_PIXELS, MAX_SCREEN_PIXELS);
/** Defined in dot.ts so error-diffusion.ts need not import this module; the media index exports it from here only. */
export { SCREEN_DOT_ON };
const MIN_BLUE_NOISE_SIZE = 2;
const MAX_SEED = 0xffff_ffff;
const ERROR_DIFFUSION_KEYS: readonly string[] = ['kind', 'kernel', 'serpentine'];

export interface ScreenPipelineInkLimit {
  /** Total area coverage limit in percent (integer 100..400). */
  limitPercent: number;
  method: InkLimitMethod;
}

export type ScreenPipelineScreening =
  | { kind: 'bayer'; size: BayerSize }
  | { kind: 'blue-noise'; size: number; seed: number }
  /** Spec 045b: spec 045a error diffusion per plane; serpentine defaults to false. */
  | { kind: 'error-diffusion'; kernel: ErrorDiffusionKernel; serpentine?: boolean };

type ThresholdScreening = Exclude<ScreenPipelineScreening, { kind: 'error-diffusion' }>;

/** Integer tile shift of one plane, each coordinate in 0..size-1 of the threshold array. */
export interface ScreenPlaneOffset {
  x: number;
  y: number;
}

export interface ScreenPlaneOffsets {
  c?: ScreenPlaneOffset;
  m?: ScreenPlaneOffset;
  y?: ScreenPlaneOffset;
  k?: ScreenPlaneOffset;
}

export interface ScreenPipelineInput {
  width: number;
  height: number;
  /** 8-bit planes, one byte per pixel, row-major; 255 = 100 %. */
  c: Uint8Array;
  m: Uint8Array;
  y: Uint8Array;
  k: Uint8Array;
  inkLimit?: ScreenPipelineInkLimit;
  /** Spec 044c: one 256-entry LUT per plane (spec 044a), applied after the ink limit; a missing plane is unchanged. */
  planeCurves?: PlaneCurveLuts;
  screening?: ScreenPipelineScreening;
  /** Only valid together with threshold `screening` (not error diffusion); a missing plane entry means no shift. */
  planeOffsets?: ScreenPlaneOffsets;
}

export interface ScreenPipelinePlanes {
  c: Uint8Array;
  m: Uint8Array;
  y: Uint8Array;
  k: Uint8Array;
}

const NO_OFFSET: ScreenPlaneOffset = { x: 0, y: 0 };

function fail(message: string): never {
  throw new RangeError(`composeScreening: ${message}`);
}

function requireIntegerInRange(name: string, value: unknown, min: number, max: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return fail(`${name} must be an integer in ${String(min)}..${String(max)} (got ${String(value)})`);
}

/** Checks each dimension, then the pixel count, without forming an out-of-range product. */
function requirePixelCount(width: unknown, height: unknown): { width: number; height: number } {
  const w = requireIntegerInRange('width', width, 1, MAX_SCREEN_PIPELINE_PIXELS);
  const h = requireIntegerInRange('height', height, 1, MAX_SCREEN_PIPELINE_PIXELS);
  if (w <= Math.floor(MAX_SCREEN_PIPELINE_PIXELS / h)) return { width: w, height: h };
  return fail(
    `${String(w)} x ${String(h)} pixels exceeds MAX_SCREEN_PIPELINE_PIXELS (${String(MAX_SCREEN_PIPELINE_PIXELS)})`,
  );
}

function requirePlane(name: string, plane: unknown, pixelCount: number): Uint8Array {
  if (plane instanceof Uint8Array && plane.length === pixelCount) return plane;
  if (plane instanceof Uint8Array) {
    return fail(`plane ${name} has ${String(plane.length)} bytes, expected width * height = ${String(pixelCount)}`);
  }
  return fail(`plane ${name} must be a Uint8Array`);
}

function requireInkLimit(value: unknown): ScreenPipelineInkLimit | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'object' && value) {
    const limitPercent = requireIntegerInRange(
      'inkLimit.limitPercent',
      'limitPercent' in value ? value.limitPercent : undefined,
      MIN_INK_LIMIT_PERCENT,
      MAX_INK_LIMIT_PERCENT,
    );
    const method = 'method' in value ? value.method : undefined;
    if (method === 'proportional' || method === 'gcr') return { limitPercent, method };
    return fail(`inkLimit.method must be proportional or gcr (got ${String(method)})`);
  }
  return fail('inkLimit must be an object');
}

const CURVE_PROBE = new Uint8Array(1);

/**
 * Runs applyPlaneCurves' own LUT checks on a 1 x 1 probe image, so bad curves throw its
 * PlaneCurveError before any full-size stage allocates.
 */
function requirePlaneCurves(value: PlaneCurveLuts | undefined): PlaneCurveLuts | undefined {
  if (value === undefined) return undefined;
  applyPlaneCurves({ width: 1, height: 1, c: CURVE_PROBE, m: CURVE_PROBE, y: CURVE_PROBE, k: CURVE_PROBE }, value);
  return value;
}

function requireBayerSize(size: unknown): BayerSize {
  for (const n of BAYER_SIZES) if (n === size) return n;
  return fail(`screening.size must be ${BAYER_SIZES.join(', ')} for bayer (got ${String(size)})`);
}

function requireKernel(kernel: unknown): ErrorDiffusionKernel {
  for (const name of ERROR_DIFFUSION_KERNELS) if (name === kernel) return name;
  return fail(`screening.kernel must be ${ERROR_DIFFUSION_KERNELS.join(' or ')} (got ${String(kernel)})`);
}

/** Error diffusion has no tile, so its keys are checked strictly; any other key is rejected. */
function requireErrorDiffusion(value: object): ScreenPipelineScreening {
  for (const key of Object.keys(value)) {
    if (ERROR_DIFFUSION_KEYS.includes(key)) continue;
    return fail(`screening has unknown key ${key} for error-diffusion`);
  }
  const kernel = requireKernel('kernel' in value ? value.kernel : undefined);
  const serpentine = 'serpentine' in value ? value.serpentine : undefined;
  if (serpentine === undefined || typeof serpentine === 'boolean') {
    return { kind: 'error-diffusion', kernel, serpentine: serpentine ?? false };
  }
  return fail(`screening.serpentine must be a boolean (got ${String(serpentine)})`);
}

function requireScreening(value: unknown): ScreenPipelineScreening | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'object' && value && 'kind' in value) {
    const size = 'size' in value ? value.size : undefined;
    if (value.kind === 'bayer') return { kind: 'bayer', size: requireBayerSize(size) };
    if (value.kind === 'blue-noise') {
      return {
        kind: 'blue-noise',
        size: requireIntegerInRange('screening.size', size, MIN_BLUE_NOISE_SIZE, MAX_THRESHOLD_ARRAY_SIZE),
        seed: requireIntegerInRange('screening.seed', 'seed' in value ? value.seed : undefined, 0, MAX_SEED),
      };
    }
    if (value.kind === 'error-diffusion') return requireErrorDiffusion(value);
    return fail(`screening.kind must be bayer, blue-noise or error-diffusion (got ${String(value.kind)})`);
  }
  return fail('screening must be an object with a kind');
}

function requireOffset(name: string, value: unknown, size: number): ScreenPlaneOffset {
  if (value === undefined) return NO_OFFSET;
  if (typeof value === 'object' && value) {
    return {
      x: requireIntegerInRange(`${name}.x`, 'x' in value ? value.x : undefined, 0, size - 1),
      y: requireIntegerInRange(`${name}.y`, 'y' in value ? value.y : undefined, 0, size - 1),
    };
  }
  return fail(`${name} must be an object with x and y`);
}

/** Offsets shift a threshold tile; without screening, or with error diffusion, there is none. */
function requireOffsets(value: unknown, screening: ScreenPipelineScreening | undefined): Required<ScreenPlaneOffsets> {
  if (value === undefined) return { c: NO_OFFSET, m: NO_OFFSET, y: NO_OFFSET, k: NO_OFFSET };
  if (screening === undefined) return fail('planeOffsets requires screening');
  if (screening.kind === 'error-diffusion') {
    return fail('planeOffsets is not supported with error-diffusion screening (it applies to threshold tiles only)');
  }
  const arraySize = screening.size;
  if (typeof value === 'object' && value) {
    return {
      c: requireOffset('planeOffsets.c', 'c' in value ? value.c : undefined, arraySize),
      m: requireOffset('planeOffsets.m', 'm' in value ? value.m : undefined, arraySize),
      y: requireOffset('planeOffsets.y', 'y' in value ? value.y : undefined, arraySize),
      k: requireOffset('planeOffsets.k', 'k' in value ? value.k : undefined, arraySize),
    };
  }
  return fail('planeOffsets must be an object');
}

/** The tile read from (x + offset.x, y + offset.y), wrapping around the array. */
function shiftedArray(array: ThresholdArray, offset: ScreenPlaneOffset): ThresholdArray {
  if (offset.x === 0 && offset.y === 0) return array;
  const { size, values } = array;
  const shifted = new Uint16Array(size * size);
  for (let ty = 0; ty < size; ty++) {
    const sourceRow = ((ty + offset.y) % size) * size;
    for (let tx = 0; tx < size; tx++) shifted[ty * size + tx] = values[sourceRow + ((tx + offset.x) % size)] ?? 0;
  }
  return { size, values: shifted };
}

function screenPlane(width: number, height: number, plane: Uint8Array, array: ThresholdArray): Uint8Array {
  const mask = applyThresholdScreen({ width, height, plane, array });
  for (let i = 0; i < mask.length; i++) mask[i] = mask[i] === 1 ? SCREEN_DOT_ON : 0;
  return mask;
}

function thresholdScreen(
  width: number,
  height: number,
  source: ScreenPipelinePlanes,
  screening: ThresholdScreening,
  offsets: Required<ScreenPlaneOffsets>,
): ScreenPipelinePlanes {
  const array =
    screening.kind === 'bayer' ? bayerArray(screening.size) : blueNoiseArray(screening.size, screening.seed);
  return {
    c: screenPlane(width, height, source.c, shiftedArray(array, offsets.c)),
    m: screenPlane(width, height, source.m, shiftedArray(array, offsets.m)),
    y: screenPlane(width, height, source.y, shiftedArray(array, offsets.y)),
    k: screenPlane(width, height, source.k, shiftedArray(array, offsets.k)),
  };
}

function diffuse(
  width: number,
  height: number,
  source: ScreenPipelinePlanes,
  screening: Extract<ScreenPipelineScreening, { kind: 'error-diffusion' }>,
): ScreenPipelinePlanes {
  const options = { kernel: screening.kernel, serpentine: screening.serpentine ?? false };
  return {
    c: applyErrorDiffusion({ width, height, plane: source.c }, options),
    m: applyErrorDiffusion({ width, height, plane: source.m }, options),
    y: applyErrorDiffusion({ width, height, plane: source.y }, options),
    k: applyErrorDiffusion({ width, height, plane: source.k }, options),
  };
}

/**
 * Spec 041a: composes the optional ink limit (spec 040a) and threshold screening (spec 039a) of a
 * CMYK image; spec 044c adds the optional plane curves (spec 044a) between them. Every input is
 * validated before any stage runs or allocates. The ink limit, if set, runs first; the plane
 * curves, if set, map its result; screening then builds one threshold array and screens each plane
 * with it, where the plane's pixel (x, y) uses the tile threshold at ((x + offset.x) mod size,
 * (y + offset.y) mod size). Spec 045b adds error-diffusion screening, which screens each plane
 * independently with spec 045a's applyErrorDiffusion and rejects planeOffsets. Screened planes hold
 * only 0 and 255. Without options the result is a copy of the input planes.
 */
export function composeScreening(input: ScreenPipelineInput): ScreenPipelinePlanes {
  const { width, height } = requirePixelCount(input.width, input.height);
  const pixelCount = width * height;
  const c = requirePlane('c', input.c, pixelCount);
  const m = requirePlane('m', input.m, pixelCount);
  const y = requirePlane('y', input.y, pixelCount);
  const k = requirePlane('k', input.k, pixelCount);
  const inkLimit = requireInkLimit(input.inkLimit);
  const planeCurves = requirePlaneCurves(input.planeCurves);
  const screening = requireScreening(input.screening);
  const offsets = requireOffsets(input.planeOffsets, screening);

  const limited = inkLimit ? limitInk({ width, height, c, m, y, k, ...inkLimit }) : undefined;
  const curved = planeCurves
    ? applyPlaneCurves({ width, height, ...(limited ?? { c, m, y, k }) }, planeCurves)
    : limited;
  if (screening === undefined) {
    if (curved) return { c: curved.c, m: curved.m, y: curved.y, k: curved.k };
    return { c: c.slice(), m: m.slice(), y: y.slice(), k: k.slice() };
  }

  const source = curved ?? { c, m, y, k };
  if (screening.kind === 'error-diffusion') return diffuse(width, height, source, screening);
  return thresholdScreen(width, height, source, screening, offsets);
}
