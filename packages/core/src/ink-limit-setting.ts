import { InvalidArgumentError } from './errors.js';

/**
 * Spec 040b: the ink-limit (TAC) setting a job carries. Model only: the setting names the total area
 * coverage limit and the reduction method the job asks for; planning the limit (spec 040a) happens in
 * media. Parsing is strict, and nothing defaults to an enabled setting: a missing setting means no ink
 * limit is requested.
 *
 * The bounds duplicate the values of the media ink-limit planner; core does not import media.
 */

export const INK_LIMIT_METHODS = ['proportional', 'gcr'] as const;

export const INK_LIMIT_PERCENT_MIN = 100;
export const INK_LIMIT_PERCENT_MAX = 400;

export type InkLimitSettingMethod = (typeof INK_LIMIT_METHODS)[number];

export interface InkLimitSetting {
  /** Total area coverage limit, integer 100..400 percent. */
  readonly limitPercent: number;
  readonly method: InkLimitSettingMethod;
}

const INK_LIMIT_SETTING_FIELDS: readonly string[] = ['limitPercent', 'method'];

const MAX_ECHOED_KEY_LENGTH = 64;

function fail(message: string): never {
  throw new InvalidArgumentError(`inkLimit: ${message}`);
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

function readLimitPercent(value: unknown): number {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= INK_LIMIT_PERCENT_MIN &&
    value <= INK_LIMIT_PERCENT_MAX
  ) {
    return value;
  }
  return fail(
    `limitPercent must be an integer in ${String(INK_LIMIT_PERCENT_MIN)}..${String(INK_LIMIT_PERCENT_MAX)} (got ${describeValue(value)})`,
  );
}

function readMethod(value: unknown): InkLimitSettingMethod {
  return (
    INK_LIMIT_METHODS.find((method) => method === value) ??
    fail(`method must be one of ${INK_LIMIT_METHODS.join(', ')} (got ${describeValue(value)})`)
  );
}

/**
 * Strictly parses an ink-limit setting. `undefined` (absent) parses to `undefined`; anything else must
 * be a plain object with exactly a valid `limitPercent` and `method`, or this throws InvalidArgumentError.
 */
export function parseInkLimitSetting(value: unknown): InkLimitSetting | undefined {
  if (value === undefined) return undefined;
  const fields = readFields(value);
  for (const key of fields.keys()) {
    if (INK_LIMIT_SETTING_FIELDS.includes(key)) continue;
    fail(`unknown field "${key.slice(0, MAX_ECHOED_KEY_LENGTH)}"`);
  }
  return {
    limitPercent: readLimitPercent(fields.get('limitPercent')),
    method: readMethod(fields.get('method')),
  };
}

/** Lenient read of a stored job's `inkLimit`: an invalid value reads as absent (`undefined`). */
export function readJobInkLimit(value: unknown): InkLimitSetting | undefined {
  try {
    return parseInkLimitSetting(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) return undefined;
    throw error;
  }
}

/**
 * Job read path for `inkLimit`: keeps a valid setting, drops an invalid one so the job stays readable
 * with no ink limit requested, and adds no key when the setting is absent. Returns a new object.
 */
export function normalizeJobInkLimit<T extends { readonly inkLimit?: unknown }>(
  job: T,
): Omit<T, 'inkLimit'> | (Omit<T, 'inkLimit'> & { readonly inkLimit: InkLimitSetting }) {
  const { inkLimit, ...rest } = job;
  const setting = readJobInkLimit(inkLimit);
  return setting === undefined ? rest : { ...rest, inkLimit: setting };
}
