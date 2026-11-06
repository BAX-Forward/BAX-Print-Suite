import {
  MAX_PLANE_CURVE_POINTS,
  MIN_PLANE_CURVE_POINTS,
  PLANE_CURVE_MAX_VALUE,
  type PlaneCurveInterpolation,
  type PlaneCurveLuts,
  type PlaneCurvePoint,
  PlaneCurveError,
  buildCurveLut,
} from '../color/plane-curves.js';
import type { ScreenPipelineInput } from './pipeline.js';

/*
 * The bounds duplicate core's job setting constants; media does not import core.
 * screening-setting.ts: SCREENING_SETTING_KINDS, SCREENING_BAYER_SIZES, SCREENING_BLUE_NOISE_SIZE_MIN,
 * SCREENING_BLUE_NOISE_SIZE_MAX, SCREENING_SEED_MIN, SCREENING_SEED_MAX, SCREENING_ERROR_DIFFUSION_KERNELS.
 * ink-limit-setting.ts: INK_LIMIT_METHODS, INK_LIMIT_PERCENT_MIN, INK_LIMIT_PERCENT_MAX.
 * The plane-curve bounds (spec 044b) are media's own spec 044a constants.
 */
const JOB_SCREENING_KINDS = ['bayer', 'blue-noise', 'error-diffusion'] as const;
const JOB_BAYER_SIZES = [2, 4, 8, 16] as const;
const JOB_ERROR_DIFFUSION_KERNELS = ['floyd-steinberg', 'jarvis-judice-ninke'] as const;
const JOB_BLUE_NOISE_SIZE_MIN = 2;
const JOB_BLUE_NOISE_SIZE_MAX = 256;
const JOB_SEED_MIN = 0;
const JOB_SEED_MAX = 0xffff_ffff;
const JOB_INK_LIMIT_METHODS = ['proportional', 'gcr'] as const;
const JOB_INK_LIMIT_PERCENT_MIN = 100;
const JOB_INK_LIMIT_PERCENT_MAX = 400;

const JOB_SCREENING_FIELDS: Readonly<Record<JobScreeningKind, readonly string[]>> = {
  bayer: ['kind', 'size'],
  'blue-noise': ['kind', 'size', 'seed'],
  'error-diffusion': ['kind', 'kernel', 'serpentine'],
};
const JOB_INK_LIMIT_FIELDS: readonly string[] = ['limitPercent', 'method'];
const JOB_PLANE_CURVE_CHANNELS = ['c', 'm', 'y', 'k'] as const;
const JOB_PLANE_CURVE_FIELDS: readonly string[] = ['points', 'method'];
const JOB_PLANE_CURVE_POINT_FIELDS: readonly string[] = ['in', 'out'];
const JOB_PLANE_CURVE_METHOD_NAMES = ['monotone', 'linear'] as const;
/** Job curve method to buildCurveLut interpolation, one to one. */
const JOB_PLANE_CURVE_METHODS: Readonly<Record<JobPlaneCurveMethod, PlaneCurveInterpolation>> = {
  monotone: 'monotone-cubic',
  linear: 'linear',
};

const MAX_ECHOED_KEY_LENGTH = 64;

type JobScreeningKind = (typeof JOB_SCREENING_KINDS)[number];
type JobErrorDiffusionKernel = (typeof JOB_ERROR_DIFFUSION_KERNELS)[number];

/** Structural copy of core's ScreeningSetting. */
export type JobScreeningInput =
  | { readonly kind: 'bayer'; readonly size: 2 | 4 | 8 | 16 }
  | { readonly kind: 'blue-noise'; readonly size: number; readonly seed: number }
  /** Spec 045c: serpentine is kept absent when the job leaves it out. */
  | { readonly kind: 'error-diffusion'; readonly kernel: JobErrorDiffusionKernel; readonly serpentine?: boolean };

/** Structural copy of core's InkLimitSetting. */
export interface JobInkLimitInput {
  readonly limitPercent: number;
  readonly method: 'proportional' | 'gcr';
}

type JobPlaneCurveMethod = (typeof JOB_PLANE_CURVE_METHOD_NAMES)[number];
type JobPlaneCurveChannel = (typeof JOB_PLANE_CURVE_CHANNELS)[number];

/** Structural copy of core's plane-curve point (spec 044b). */
export interface JobPlaneCurvePointInput {
  readonly in: number;
  readonly out: number;
}

/** Structural copy of core's single-channel plane curve (spec 044b). */
export interface JobPlaneCurveInput {
  readonly points: readonly JobPlaneCurvePointInput[];
  readonly method: JobPlaneCurveMethod;
}

/** Structural copy of core's PlaneCurvesSetting (spec 044b); at least one channel is set. */
export interface JobPlaneCurvesInput {
  readonly c?: JobPlaneCurveInput;
  readonly m?: JobPlaneCurveInput;
  readonly y?: JobPlaneCurveInput;
  readonly k?: JobPlaneCurveInput;
}

/** The job fields the adapter reads; every other job field is ignored. */
export interface JobPipelineSource {
  readonly screening?: unknown;
  readonly inkLimit?: unknown;
  /** Read as a JobPlaneCurvesInput. */
  readonly planeCurves?: unknown;
}

/** The subset of composeScreening options a job controls. */
export type JobPipelineOptions = Pick<ScreenPipelineInput, 'screening' | 'inkLimit' | 'planeCurves'>;

function fail(message: string): never {
  throw new RangeError(`pipelineOptionsFromJob: ${message}`);
}

/** Echoes numbers and booleans; other values are named by type only. */
function describeValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return typeof value;
}

/** Reads a plain object's own enumerable string-keyed fields. */
function readFields(name: string, value: unknown): ReadonlyMap<string, unknown> {
  if (typeof value === 'object' && value) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return new Map(Object.entries(value));
  }
  return fail(`${name} must be a plain object (got ${describeValue(value)})`);
}

function rejectUnknownFields(name: string, fields: ReadonlyMap<string, unknown>, allowed: readonly string[]): void {
  for (const key of fields.keys()) {
    if (allowed.includes(key)) continue;
    fail(`unknown field "${key.slice(0, MAX_ECHOED_KEY_LENGTH)}" in ${name}`);
  }
}

function readInteger(name: string, value: unknown, min: number, max: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return fail(`${name} must be an integer in ${String(min)}..${String(max)} (got ${describeValue(value)})`);
}

function readErrorDiffusion(fields: ReadonlyMap<string, unknown>): JobScreeningInput {
  const kernelValue = fields.get('kernel');
  const kernel =
    JOB_ERROR_DIFFUSION_KERNELS.find((name) => name === kernelValue) ??
    fail(
      `screening.kernel must be one of ${JOB_ERROR_DIFFUSION_KERNELS.join(', ')} for error-diffusion (got ${describeValue(kernelValue)})`,
    );
  if (fields.has('serpentine')) {
    const serpentine = fields.get('serpentine');
    if (typeof serpentine === 'boolean') return { kind: 'error-diffusion', kernel, serpentine };
    return fail(`screening.serpentine must be a boolean for error-diffusion (got ${describeValue(serpentine)})`);
  }
  return { kind: 'error-diffusion', kernel };
}

function readScreening(value: unknown): JobScreeningInput {
  const fields = readFields('screening', value);
  const kindValue = fields.get('kind');
  const kind =
    JOB_SCREENING_KINDS.find((k) => k === kindValue) ??
    fail(`screening.kind must be one of ${JOB_SCREENING_KINDS.join(', ')} (got ${describeValue(kindValue)})`);
  rejectUnknownFields(`screening (${kind})`, fields, JOB_SCREENING_FIELDS[kind]);
  if (kind === 'error-diffusion') return readErrorDiffusion(fields);
  const sizeValue = fields.get('size');
  if (kind === 'bayer') {
    const size =
      JOB_BAYER_SIZES.find((n) => n === sizeValue) ??
      fail(`screening.size must be one of ${JOB_BAYER_SIZES.join(', ')} for bayer (got ${describeValue(sizeValue)})`);
    return { kind, size };
  }
  return {
    kind,
    size: readInteger('screening.size', sizeValue, JOB_BLUE_NOISE_SIZE_MIN, JOB_BLUE_NOISE_SIZE_MAX),
    seed: readInteger('screening.seed', fields.get('seed'), JOB_SEED_MIN, JOB_SEED_MAX),
  };
}

function readInkLimit(value: unknown): JobInkLimitInput {
  const fields = readFields('inkLimit', value);
  rejectUnknownFields('inkLimit', fields, JOB_INK_LIMIT_FIELDS);
  const limitPercent = readInteger(
    'inkLimit.limitPercent',
    fields.get('limitPercent'),
    JOB_INK_LIMIT_PERCENT_MIN,
    JOB_INK_LIMIT_PERCENT_MAX,
  );
  const methodValue = fields.get('method');
  const method =
    JOB_INK_LIMIT_METHODS.find((m) => m === methodValue) ??
    fail(`inkLimit.method must be one of ${JOB_INK_LIMIT_METHODS.join(', ')} (got ${describeValue(methodValue)})`);
  return { limitPercent, method };
}

function readCurvePoint(name: string, value: unknown): JobPlaneCurvePointInput {
  const fields = readFields(name, value);
  rejectUnknownFields(name, fields, JOB_PLANE_CURVE_POINT_FIELDS);
  return {
    in: readInteger(`${name}.in`, fields.get('in'), 0, PLANE_CURVE_MAX_VALUE),
    out: readInteger(`${name}.out`, fields.get('out'), 0, PLANE_CURVE_MAX_VALUE),
  };
}

/** The count is checked before any point is read. */
function readCurvePointList(name: string, points: readonly unknown[]): JobPlaneCurvePointInput[] {
  if (points.length < MIN_PLANE_CURVE_POINTS || points.length > MAX_PLANE_CURVE_POINTS) {
    fail(
      `${name} must have ${String(MIN_PLANE_CURVE_POINTS)}..${String(MAX_PLANE_CURVE_POINTS)} entries (got ${String(points.length)})`,
    );
  }
  return points.map((point, index) => readCurvePoint(`${name}[${String(index)}]`, point));
}

function readCurve(name: string, value: unknown): JobPlaneCurveInput {
  const fields = readFields(name, value);
  rejectUnknownFields(name, fields, JOB_PLANE_CURVE_FIELDS);
  const pointsValue = fields.get('points');
  const points = Array.isArray(pointsValue)
    ? readCurvePointList(`${name}.points`, pointsValue)
    : fail(`${name}.points must be an array (got ${describeValue(pointsValue)})`);
  const methodValue = fields.get('method');
  const method =
    JOB_PLANE_CURVE_METHOD_NAMES.find((m) => m === methodValue) ??
    fail(`${name}.method must be one of ${JOB_PLANE_CURVE_METHOD_NAMES.join(', ')} (got ${describeValue(methodValue)})`);
  return { points, method };
}

function readPlaneCurves(value: unknown): JobPlaneCurvesInput {
  const fields = readFields('planeCurves', value);
  rejectUnknownFields('planeCurves', fields, JOB_PLANE_CURVE_CHANNELS);
  if (JOB_PLANE_CURVE_CHANNELS.every((channel) => fields.get(channel) === undefined)) {
    fail(`planeCurves must set at least one of ${JOB_PLANE_CURVE_CHANNELS.join(', ')}`);
  }
  const curve = (channel: JobPlaneCurveChannel): JobPlaneCurveInput | undefined => {
    const curveValue = fields.get(channel);
    return curveValue === undefined ? undefined : readCurve(`planeCurves.${channel}`, curveValue);
  };
  const c = curve('c');
  const m = curve('m');
  const y = curve('y');
  const k = curve('k');
  return {
    ...(c === undefined ? {} : { c }),
    ...(m === undefined ? {} : { m }),
    ...(y === undefined ? {} : { y }),
    ...(k === undefined ? {} : { k }),
  };
}

/** Spec 044a's order, endpoint and monotonicity checks, reported as this adapter's RangeError. */
function curveLut(name: string, curve: JobPlaneCurveInput): Uint8Array {
  const points: PlaneCurvePoint[] = curve.points.map((point) => ({ input: point.in, output: point.out }));
  try {
    return buildCurveLut(points, { interpolation: JOB_PLANE_CURVE_METHODS[curve.method] });
  } catch (error) {
    if (error instanceof PlaneCurveError) return fail(`${name}: ${error.message}`);
    throw error;
  }
}

function planeCurveLuts(curves: JobPlaneCurvesInput): PlaneCurveLuts {
  const { c, m, y, k } = curves;
  return {
    ...(c === undefined ? {} : { c: curveLut('planeCurves.c', c) }),
    ...(m === undefined ? {} : { m: curveLut('planeCurves.m', m) }),
    ...(y === undefined ? {} : { y: curveLut('planeCurves.y', y) }),
    ...(k === undefined ? {} : { k: curveLut('planeCurves.k', k) }),
  };
}

/**
 * Spec 041b: maps a job's screening (spec 039b) and ink-limit (spec 040b) settings to the matching
 * composeScreening options (spec 041a); spec 044c adds the plane curves (spec 044b), each built into
 * a 256-entry LUT with method monotone as monotone-cubic and linear as linear interpolation; spec
 * 045c adds error-diffusion screening, mapped to composeScreening's error-diffusion option. An
 * absent or undefined setting leaves that option off and its key out of the result. A present
 * setting must match the job setting shape exactly: unknown fields, wrong types, non-integers,
 * out-of-range values and, for plane curves, an empty object, missing endpoints, inputs that do not
 * increase and outputs that decrease throw RangeError. Nothing is coerced or defaulted.
 */
export function pipelineOptionsFromJob(job: JobPipelineSource): JobPipelineOptions {
  const screening = job.screening === undefined ? undefined : readScreening(job.screening);
  const inkLimit = job.inkLimit === undefined ? undefined : readInkLimit(job.inkLimit);
  const planeCurves = job.planeCurves === undefined ? undefined : planeCurveLuts(readPlaneCurves(job.planeCurves));
  return {
    ...(screening === undefined ? {} : { screening }),
    ...(inkLimit === undefined ? {} : { inkLimit }),
    ...(planeCurves === undefined ? {} : { planeCurves }),
  };
}
