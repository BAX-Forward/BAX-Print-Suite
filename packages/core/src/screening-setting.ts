import { InvalidArgumentError } from './errors.js';

/**
 * Spec 039b: the screening setting a job carries. Model only: the setting names the threshold array
 * the job asks for; building the array (spec 039a) happens in media. Parsing is strict, and nothing
 * defaults to an enabled setting: a missing setting means no screening is requested.
 *
 * The bounds duplicate the values of the media screening library; core does not import media.
 */

export const SCREENING_SETTING_KINDS = ['bayer', 'blue-noise', 'error-diffusion'] as const;
export const SCREENING_BAYER_SIZES = [2, 4, 8, 16] as const;
/** Spec 045c: the error-diffusion kernels of the media screening library (spec 045a). */
export const SCREENING_ERROR_DIFFUSION_KERNELS = ['floyd-steinberg', 'jarvis-judice-ninke'] as const;

export const SCREENING_BLUE_NOISE_SIZE_MIN = 2;
export const SCREENING_BLUE_NOISE_SIZE_MAX = 256;
export const SCREENING_SEED_MIN = 0;
export const SCREENING_SEED_MAX = 0xffff_ffff;

export type ScreeningSettingKind = (typeof SCREENING_SETTING_KINDS)[number];
export type ScreeningBayerSize = (typeof SCREENING_BAYER_SIZES)[number];
export type ScreeningErrorDiffusionKernel = (typeof SCREENING_ERROR_DIFFUSION_KERNELS)[number];

export interface BayerScreeningSetting {
  readonly kind: 'bayer';
  /** One of 2, 4, 8, 16. */
  readonly size: ScreeningBayerSize;
}

export interface BlueNoiseScreeningSetting {
  readonly kind: 'blue-noise';
  /** Integer 2..256. */
  readonly size: number;
  /** Unsigned 32-bit integer 0..4294967295. */
  readonly seed: number;
}

/** Spec 045c: error diffusion has no tile, so no size or seed. */
export interface ErrorDiffusionScreeningSetting {
  readonly kind: 'error-diffusion';
  readonly kernel: ScreeningErrorDiffusionKernel;
  /** Optional; absent means raster order, as in the media library. Kept absent when absent. */
  readonly serpentine?: boolean;
}

export type ScreeningSetting = BayerScreeningSetting | BlueNoiseScreeningSetting | ErrorDiffusionScreeningSetting;

const SCREENING_SETTING_FIELDS: Readonly<Record<ScreeningSettingKind, readonly string[]>> = {
  bayer: ['kind', 'size'],
  'blue-noise': ['kind', 'size', 'seed'],
  'error-diffusion': ['kind', 'kernel', 'serpentine'],
};

const MAX_ECHOED_KEY_LENGTH = 64;

function fail(message: string): never {
  throw new InvalidArgumentError(`screening: ${message}`);
}

/** Echoes numbers and booleans; other values are named by type only. */
function describeValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return typeof value;
}

function readFields(value: unknown): ReadonlyMap<string, unknown> {
  if (typeof value === 'object' && value) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return new Map(Object.entries(value));
  }
  return fail(`must be a plain object (got ${describeValue(value)})`);
}

function readInteger(name: string, value: unknown, min: number, max: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return fail(`${name} must be an integer in ${String(min)}..${String(max)} (got ${describeValue(value)})`);
}

function readKind(value: unknown): ScreeningSettingKind {
  return (
    SCREENING_SETTING_KINDS.find((kind) => kind === value) ??
    fail(`kind must be one of ${SCREENING_SETTING_KINDS.join(', ')} (got ${describeValue(value)})`)
  );
}

function readBayerSize(value: unknown): ScreeningBayerSize {
  return (
    SCREENING_BAYER_SIZES.find((size) => size === value) ??
    fail(`size must be one of ${SCREENING_BAYER_SIZES.join(', ')} for bayer (got ${describeValue(value)})`)
  );
}

function readErrorDiffusion(fields: ReadonlyMap<string, unknown>): ErrorDiffusionScreeningSetting {
  const kernelValue = fields.get('kernel');
  const kernel =
    SCREENING_ERROR_DIFFUSION_KERNELS.find((name) => name === kernelValue) ??
    fail(
      `kernel must be one of ${SCREENING_ERROR_DIFFUSION_KERNELS.join(', ')} for error-diffusion (got ${describeValue(kernelValue)})`,
    );
  if (fields.has('serpentine')) {
    const serpentine = fields.get('serpentine');
    if (typeof serpentine === 'boolean') return { kind: 'error-diffusion', kernel, serpentine };
    return fail(`serpentine must be a boolean for error-diffusion (got ${describeValue(serpentine)})`);
  }
  return { kind: 'error-diffusion', kernel };
}

/**
 * Strictly parses a screening setting. `undefined` (absent) parses to `undefined`; anything else must
 * be a plain object with a valid `kind` and exactly that kind's valid fields, or this throws
 * InvalidArgumentError.
 */
export function parseScreeningSetting(value: unknown): ScreeningSetting | undefined {
  if (value === undefined) return undefined;
  const fields = readFields(value);
  const kind = readKind(fields.get('kind'));
  const allowed = SCREENING_SETTING_FIELDS[kind];
  for (const key of fields.keys()) {
    if (allowed.includes(key)) continue;
    fail(`unknown field "${key.slice(0, MAX_ECHOED_KEY_LENGTH)}" for ${kind}`);
  }
  if (kind === 'bayer') return { kind, size: readBayerSize(fields.get('size')) };
  if (kind === 'error-diffusion') return readErrorDiffusion(fields);
  return {
    kind,
    size: readInteger('size', fields.get('size'), SCREENING_BLUE_NOISE_SIZE_MIN, SCREENING_BLUE_NOISE_SIZE_MAX),
    seed: readInteger('seed', fields.get('seed'), SCREENING_SEED_MIN, SCREENING_SEED_MAX),
  };
}

/** Lenient read of a stored job's `screening`: an invalid value reads as absent (`undefined`). */
export function readJobScreening(value: unknown): ScreeningSetting | undefined {
  try {
    return parseScreeningSetting(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) return undefined;
    throw error;
  }
}

/**
 * Job read path for `screening`: keeps a valid setting, drops an invalid one so the job stays readable
 * with no screening requested, and adds no key when the setting is absent. Returns a new object.
 */
export function normalizeJobScreening<T extends { readonly screening?: unknown }>(
  job: T,
): Omit<T, 'screening'> | (Omit<T, 'screening'> & { readonly screening: ScreeningSetting }) {
  const { screening, ...rest } = job;
  const setting = readJobScreening(screening);
  return setting === undefined ? rest : { ...rest, screening: setting };
}
