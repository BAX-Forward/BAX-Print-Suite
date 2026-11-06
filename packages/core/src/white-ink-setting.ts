import { InvalidArgumentError } from './errors.js';

/**
 * Spec 038b: the white ink setting a job carries. Model only: the setting names the white layer the
 * job asks for; planning the layer (spec 038a) happens in media. Parsing is strict, and nothing
 * defaults to an enabled setting: a missing setting means white ink is off.
 */

export const WHITE_INK_SETTING_MODES = ['flood', 'spot', 'choke'] as const;
export const WHITE_INK_SETTING_SHAPES = ['square', 'diamond'] as const;

export const WHITE_INK_THRESHOLD_MIN = 0;
export const WHITE_INK_THRESHOLD_MAX = 255;
export const WHITE_INK_CHOKE_PX_MIN = 0;
export const WHITE_INK_CHOKE_PX_MAX = 64;
export const WHITE_INK_DENSITY_MIN = 0;
export const WHITE_INK_DENSITY_MAX = 100;
export const WHITE_INK_SEPARATION_NAME_MIN_LENGTH = 1;
export const WHITE_INK_SEPARATION_NAME_MAX_LENGTH = 63;

export type WhiteInkSettingMode = (typeof WHITE_INK_SETTING_MODES)[number];
export type WhiteInkSettingShape = (typeof WHITE_INK_SETTING_SHAPES)[number];

export interface WhiteInkSetting {
  readonly mode: WhiteInkSettingMode;
  /** Integer 0..255. */
  readonly threshold?: number;
  /** Integer 0..64. */
  readonly chokePx?: number;
  readonly shape?: WhiteInkSettingShape;
  /** Integer percent 0..100. */
  readonly density?: number;
  readonly invert?: boolean;
  /** Printable ASCII, 1..63 characters, not blank. */
  readonly separationName?: string;
}

const WHITE_INK_SETTING_FIELDS: readonly string[] = [
  'mode',
  'threshold',
  'chokePx',
  'shape',
  'density',
  'invert',
  'separationName',
];

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const MAX_ECHOED_KEY_LENGTH = 64;

function fail(message: string): never {
  throw new InvalidArgumentError(`whiteInk: ${message}`);
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

function readMode(value: unknown): WhiteInkSettingMode {
  return (
    WHITE_INK_SETTING_MODES.find((mode) => mode === value) ??
    fail(`mode must be one of ${WHITE_INK_SETTING_MODES.join(', ')} (got ${describeValue(value)})`)
  );
}

function readShape(value: unknown): WhiteInkSettingShape {
  return (
    WHITE_INK_SETTING_SHAPES.find((shape) => shape === value) ??
    fail(`shape must be one of ${WHITE_INK_SETTING_SHAPES.join(', ')} (got ${describeValue(value)})`)
  );
}

function readBoolean(name: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return fail(`${name} must be a boolean (got ${describeValue(value)})`);
}

function readSeparationName(value: unknown): string {
  if (
    typeof value === 'string' &&
    value.length >= WHITE_INK_SEPARATION_NAME_MIN_LENGTH &&
    value.length <= WHITE_INK_SEPARATION_NAME_MAX_LENGTH &&
    PRINTABLE_ASCII.test(value) &&
    value.trim().length > 0
  ) {
    return value;
  }
  return fail(
    `separationName must be ${String(WHITE_INK_SEPARATION_NAME_MIN_LENGTH)}..${String(WHITE_INK_SEPARATION_NAME_MAX_LENGTH)} printable ASCII characters, not blank`,
  );
}

/**
 * Strictly parses a white ink setting. `undefined` (absent) parses to `undefined`; anything else must
 * be a plain object with a valid `mode` and only known, valid fields, or this throws InvalidArgumentError.
 */
export function parseWhiteInkSetting(value: unknown): WhiteInkSetting | undefined {
  if (value === undefined) return undefined;
  const fields = readFields(value);
  for (const key of fields.keys()) {
    if (WHITE_INK_SETTING_FIELDS.includes(key)) continue;
    fail(`unknown field "${key.slice(0, MAX_ECHOED_KEY_LENGTH)}"`);
  }
  return {
    mode: readMode(fields.get('mode')),
    ...(fields.has('threshold')
      ? {
          threshold: readInteger(
            'threshold',
            fields.get('threshold'),
            WHITE_INK_THRESHOLD_MIN,
            WHITE_INK_THRESHOLD_MAX,
          ),
        }
      : {}),
    ...(fields.has('chokePx')
      ? { chokePx: readInteger('chokePx', fields.get('chokePx'), WHITE_INK_CHOKE_PX_MIN, WHITE_INK_CHOKE_PX_MAX) }
      : {}),
    ...(fields.has('shape') ? { shape: readShape(fields.get('shape')) } : {}),
    ...(fields.has('density')
      ? { density: readInteger('density', fields.get('density'), WHITE_INK_DENSITY_MIN, WHITE_INK_DENSITY_MAX) }
      : {}),
    ...(fields.has('invert') ? { invert: readBoolean('invert', fields.get('invert')) } : {}),
    ...(fields.has('separationName') ? { separationName: readSeparationName(fields.get('separationName')) } : {}),
  };
}

/** Lenient read of a stored job's `whiteInk`: an invalid value reads as off (`undefined`). */
export function readJobWhiteInk(value: unknown): WhiteInkSetting | undefined {
  try {
    return parseWhiteInkSetting(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) return undefined;
    throw error;
  }
}

/**
 * Job read path for `whiteInk`: keeps a valid setting, drops an invalid one so the job stays readable
 * with white ink off, and adds no key when the setting is absent. Returns a new object.
 */
export function normalizeJobWhiteInk<T extends { readonly whiteInk?: unknown }>(
  job: T,
): Omit<T, 'whiteInk'> | (Omit<T, 'whiteInk'> & { readonly whiteInk: WhiteInkSetting }) {
  const { whiteInk, ...rest } = job;
  const setting = readJobWhiteInk(whiteInk);
  return setting === undefined ? rest : { ...rest, whiteInk: setting };
}
