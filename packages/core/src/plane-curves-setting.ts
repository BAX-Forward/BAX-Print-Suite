import { InvalidArgumentError } from './errors.js';

/**
 * Spec 044b: the per-channel tone curves (linearization) a job carries. Model only: the setting names
 * control points and the interpolation method per C, M, Y, K plane; building the 8-bit lookup tables
 * (spec 044a) happens in media. Parsing is strict, and nothing defaults to an enabled setting: a missing
 * setting means no curves are requested, and a missing channel means that plane is left unchanged.
 *
 * The bounds duplicate the values of the media linearization LUT builder; core does not import media.
 */

export const PLANE_CURVE_CHANNELS = ['c', 'm', 'y', 'k'] as const;
export const PLANE_CURVE_METHODS = ['monotone', 'linear'] as const;

export const PLANE_CURVES_MIN_POINTS = 2;
export const PLANE_CURVES_MAX_POINTS = 256;
export const PLANE_CURVES_MAX_VALUE = 255;

export type PlaneCurveChannel = (typeof PLANE_CURVE_CHANNELS)[number];
export type PlaneCurveMethod = (typeof PLANE_CURVE_METHODS)[number];

export interface PlaneCurvePoint {
  /** Input level, integer 0..255. */
  readonly in: number;
  /** Output level, integer 0..255. */
  readonly out: number;
}

export interface PlaneCurve {
  /** Inputs strictly increase from 0 to 255; outputs never decrease. */
  readonly points: readonly PlaneCurvePoint[];
  readonly method: PlaneCurveMethod;
}

export interface PlaneCurvesSetting {
  readonly c?: PlaneCurve;
  readonly m?: PlaneCurve;
  readonly y?: PlaneCurve;
  readonly k?: PlaneCurve;
}

const PLANE_CURVE_FIELDS: readonly string[] = ['points', 'method'];
const PLANE_CURVE_POINT_FIELDS: readonly string[] = ['in', 'out'];

const MAX_ECHOED_KEY_LENGTH = 64;

function fail(message: string): never {
  throw new InvalidArgumentError(`planeCurves: ${message}`);
}

/** Echoes numbers and booleans; other values are named by type only. */
function describeValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return typeof value;
}

/** Names the value at `path`; the setting itself has the empty path. */
function subject(path: string, text: string): string {
  return path === '' ? text : `${path} ${text}`;
}

function readFields(path: string, value: unknown, allowed: readonly string[]): ReadonlyMap<string, unknown> {
  if (typeof value === 'object' && value) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const fields = new Map(Object.entries(value));
      for (const key of fields.keys()) {
        if (allowed.includes(key)) continue;
        const where = path === '' ? '' : ` in ${path}`;
        fail(`unknown field "${key.slice(0, MAX_ECHOED_KEY_LENGTH)}"${where}`);
      }
      return fields;
    }
  }
  return fail(subject(path, `must be a plain object (got ${describeValue(value)})`));
}

function readLevel(path: string, value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= PLANE_CURVES_MAX_VALUE) {
    return value;
  }
  return fail(`${path} must be an integer in 0..${String(PLANE_CURVES_MAX_VALUE)} (got ${describeValue(value)})`);
}

function readPoint(path: string, value: unknown): PlaneCurvePoint {
  const fields = readFields(path, value, PLANE_CURVE_POINT_FIELDS);
  return { in: readLevel(`${path}.in`, fields.get('in')), out: readLevel(`${path}.out`, fields.get('out')) };
}

function requireShape(path: string, points: readonly PlaneCurvePoint[]): void {
  const firstIn = points[0]?.in;
  const lastIn = points[points.length - 1]?.in;
  if (firstIn === 0 && lastIn === PLANE_CURVES_MAX_VALUE) {
    let previous: PlaneCurvePoint | undefined;
    for (const [index, point] of points.entries()) {
      if (previous && point.in <= previous.in) {
        fail(`${path}[${String(index)}].in must be greater than ${String(previous.in)} (got ${String(point.in)})`);
      }
      if (previous && point.out < previous.out) {
        fail(`${path}[${String(index)}].out must be at least ${String(previous.out)} (got ${String(point.out)})`);
      }
      previous = point;
    }
    return;
  }
  fail(
    `${path} must start at in 0 and end at in ${String(PLANE_CURVES_MAX_VALUE)} (got ${describeValue(firstIn)}..${describeValue(lastIn)})`,
  );
}

function readPoints(path: string, value: unknown): readonly PlaneCurvePoint[] {
  const items: readonly unknown[] = Array.isArray(value)
    ? value
    : fail(`${path} must be an array (got ${describeValue(value)})`);
  if (items.length < PLANE_CURVES_MIN_POINTS || items.length > PLANE_CURVES_MAX_POINTS) {
    fail(
      `${path} must have ${String(PLANE_CURVES_MIN_POINTS)}..${String(PLANE_CURVES_MAX_POINTS)} points (got ${String(items.length)})`,
    );
  }
  // Array.from visits holes of a sparse array, so a hole is rejected as a non-object point.
  const points = Array.from(items, (item, index) => readPoint(`${path}[${String(index)}]`, item));
  requireShape(path, points);
  return points;
}

function readMethod(path: string, value: unknown): PlaneCurveMethod {
  return (
    PLANE_CURVE_METHODS.find((method) => method === value) ??
    fail(`${path} must be one of ${PLANE_CURVE_METHODS.join(', ')} (got ${describeValue(value)})`)
  );
}

function readCurve(channel: PlaneCurveChannel, value: unknown): PlaneCurve {
  const fields = readFields(channel, value, PLANE_CURVE_FIELDS);
  return {
    points: readPoints(`${channel}.points`, fields.get('points')),
    method: readMethod(`${channel}.method`, fields.get('method')),
  };
}

/**
 * Strictly parses a per-channel curves setting. `undefined` (absent) parses to `undefined`; anything else
 * must be a plain object whose only fields are the channels `c`, `m`, `y` and `k`, each a valid curve, or
 * this throws InvalidArgumentError. Unknown fields are rejected at every level.
 *
 * An empty object `{}` is rejected: it would request curves for no plane, which is the same as an absent
 * setting, and the model keeps one spelling for "no curves". A channel key that is present must hold a
 * curve; `{ c: undefined }` is rejected too.
 */
export function parsePlaneCurvesSetting(value: unknown): PlaneCurvesSetting | undefined {
  if (value === undefined) return undefined;
  const fields = readFields('', value, PLANE_CURVE_CHANNELS);
  if (fields.size === 0) {
    fail(`must name at least one channel of ${PLANE_CURVE_CHANNELS.join(', ')} (got an empty object)`);
  }
  const read = (channel: PlaneCurveChannel): PlaneCurve | undefined =>
    fields.has(channel) ? readCurve(channel, fields.get(channel)) : undefined;
  const c = read('c');
  const m = read('m');
  const y = read('y');
  const k = read('k');
  return {
    ...(c === undefined ? {} : { c }),
    ...(m === undefined ? {} : { m }),
    ...(y === undefined ? {} : { y }),
    ...(k === undefined ? {} : { k }),
  };
}

/** Lenient read of a stored job's `planeCurves`: an invalid value reads as absent (`undefined`). */
export function readJobPlaneCurves(value: unknown): PlaneCurvesSetting | undefined {
  try {
    return parsePlaneCurvesSetting(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) return undefined;
    throw error;
  }
}

/**
 * Job read path for `planeCurves`: keeps a valid setting, drops an invalid one so the job stays readable
 * with no curves requested, and adds no key when the setting is absent. Returns a new object.
 */
export function normalizeJobPlaneCurves<T extends { readonly planeCurves?: unknown }>(
  job: T,
): Omit<T, 'planeCurves'> | (Omit<T, 'planeCurves'> & { readonly planeCurves: PlaneCurvesSetting }) {
  const { planeCurves, ...rest } = job;
  const setting = readJobPlaneCurves(planeCurves);
  return setting === undefined ? rest : { ...rest, planeCurves: setting };
}
