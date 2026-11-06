import type { ScreenPipelineInput } from './pipeline.js';

/*
 * The bounds duplicate core's job setting constants; media does not import core.
 * screening-setting.ts: SCREENING_SETTING_KINDS, SCREENING_BAYER_SIZES, SCREENING_BLUE_NOISE_SIZE_MIN,
 * SCREENING_BLUE_NOISE_SIZE_MAX, SCREENING_SEED_MIN, SCREENING_SEED_MAX.
 * ink-limit-setting.ts: INK_LIMIT_METHODS, INK_LIMIT_PERCENT_MIN, INK_LIMIT_PERCENT_MAX.
 */
const JOB_SCREENING_KINDS = ['bayer', 'blue-noise'] as const;
const JOB_BAYER_SIZES = [2, 4, 8, 16] as const;
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
};
const JOB_INK_LIMIT_FIELDS: readonly string[] = ['limitPercent', 'method'];

const MAX_ECHOED_KEY_LENGTH = 64;

type JobScreeningKind = (typeof JOB_SCREENING_KINDS)[number];

/** Structural copy of core's ScreeningSetting. */
export type JobScreeningInput =
  | { readonly kind: 'bayer'; readonly size: 2 | 4 | 8 | 16 }
  | { readonly kind: 'blue-noise'; readonly size: number; readonly seed: number };

/** Structural copy of core's InkLimitSetting. */
export interface JobInkLimitInput {
  readonly limitPercent: number;
  readonly method: 'proportional' | 'gcr';
}

/** The job fields the adapter reads; every other job field is ignored. */
export interface JobPipelineSource {
  readonly screening?: unknown;
  readonly inkLimit?: unknown;
}

/** The subset of composeScreening options a job controls. */
export type JobPipelineOptions = Pick<ScreenPipelineInput, 'screening' | 'inkLimit'>;

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

function readScreening(value: unknown): JobScreeningInput {
  const fields = readFields('screening', value);
  const kindValue = fields.get('kind');
  const kind =
    JOB_SCREENING_KINDS.find((k) => k === kindValue) ??
    fail(`screening.kind must be one of ${JOB_SCREENING_KINDS.join(', ')} (got ${describeValue(kindValue)})`);
  rejectUnknownFields(`screening (${kind})`, fields, JOB_SCREENING_FIELDS[kind]);
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

/**
 * Spec 041b: maps a job's screening (spec 039b) and ink-limit (spec 040b) settings to the matching
 * composeScreening options (spec 041a). An absent or undefined setting leaves that option off and its
 * key out of the result. A present setting must match the job setting shape exactly: unknown fields,
 * wrong types, non-integers and out-of-range values throw RangeError. Nothing is coerced or defaulted.
 */
export function pipelineOptionsFromJob(job: JobPipelineSource): JobPipelineOptions {
  const screening = job.screening === undefined ? undefined : readScreening(job.screening);
  const inkLimit = job.inkLimit === undefined ? undefined : readInkLimit(job.inkLimit);
  return {
    ...(screening === undefined ? {} : { screening }),
    ...(inkLimit === undefined ? {} : { inkLimit }),
  };
}
