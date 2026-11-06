import { InvalidArgumentError } from './errors.js';

/**
 * Spec 050a: the tiling a job carries. Model only: the setting names a panel grid by count and one seam
 * treatment for every seam; splitting the artwork into panels (Spec 009) happens in tile. Parsing is
 * strict: unknown fields are rejected at every level, and a missing setting means the job is not tiled.
 *
 * The shapes and bounds duplicate tile's `TileSpec` (`grid` in `count` mode, `seam`); core does not
 * import tile.
 */

export const TILING_SEAM_KINDS = ['butt', 'overlap', 'gap'] as const;

/** Mirrors `MAX_PANELS_PER_AXIS` in packages/tile/src/axis.ts. */
export const MAX_TILING_PANELS_PER_AXIS = 500;

/** Upper bound of `seam.overlapMm`; tile itself only asks for a finite number >= 0. */
export const TILING_MAX_OVERLAP_MM = 1000;

/** Upper bound of `seam.gapMm`; tile itself only asks for a finite number > 0. */
export const TILING_MAX_GAP_MM = 1000;

export type TilingSeamKind = (typeof TILING_SEAM_KINDS)[number];

export interface TilingGrid {
  /** Panels across, integer 1..500. */
  readonly columns: number;
  /** Panels down, integer 1..500. */
  readonly rows: number;
}

/** How neighbouring panels meet, as tile's `SeamTreatment`. */
export type TilingSeam =
  | { readonly kind: 'butt' }
  /** Without `overlapMm`, tile uses its default overlap of 25 mm. */
  | { readonly kind: 'overlap'; readonly overlapMm?: number }
  | { readonly kind: 'gap'; readonly gapMm: number };

export interface TilingSetting {
  readonly grid: TilingGrid;
  /** Without `seam`, tile uses its default seam (an overlap of 25 mm). */
  readonly seam?: TilingSeam;
}

const TILING_FIELDS: readonly string[] = ['grid', 'seam'];
const TILING_GRID_FIELDS: readonly string[] = ['columns', 'rows'];
const TILING_SEAM_FIELDS: Readonly<Record<TilingSeamKind, readonly string[]>> = {
  butt: ['kind'],
  overlap: ['kind', 'overlapMm'],
  gap: ['kind', 'gapMm'],
};

const MAX_ECHOED_KEY_LENGTH = 64;

function fail(message: string): never {
  throw new InvalidArgumentError(`tiling: ${message}`);
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

function readCount(path: string, value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TILING_PANELS_PER_AXIS) {
    return value;
  }
  return fail(`${path} must be an integer in 1..${String(MAX_TILING_PANELS_PER_AXIS)} (got ${describeValue(value)})`);
}

function readGrid(value: unknown): TilingGrid {
  const fields = readFields('grid', value, TILING_GRID_FIELDS);
  return { columns: readCount('grid.columns', fields.get('columns')), rows: readCount('grid.rows', fields.get('rows')) };
}

/** A finite length in mm, at least 0 (or above 0 when `positive`), at most `max`. */
function readLength(path: string, value: unknown, max: number, positive: boolean): number {
  const low = positive ? 'greater than 0' : 'at least 0';
  if (typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0) && value <= max) {
    return value;
  }
  return fail(`${path} must be a finite number ${low} and at most ${String(max)} (got ${describeValue(value)})`);
}

function readKind(value: unknown): TilingSeamKind {
  return (
    TILING_SEAM_KINDS.find((kind) => kind === value) ??
    fail(`seam.kind must be one of ${TILING_SEAM_KINDS.join(', ')} (got ${describeValue(value)})`)
  );
}

function readSeam(value: unknown): TilingSeam {
  // The kind decides which other fields the seam may have, so read it before checking for unknown fields.
  const kind = readKind(readFields('seam', value, ['kind', 'overlapMm', 'gapMm']).get('kind'));
  const fields = readFields('seam', value, TILING_SEAM_FIELDS[kind]);
  if (kind === 'butt') return { kind };
  if (kind === 'gap') return { kind, gapMm: readLength('seam.gapMm', fields.get('gapMm'), TILING_MAX_GAP_MM, true) };
  if (!fields.has('overlapMm')) return { kind };
  return { kind, overlapMm: readLength('seam.overlapMm', fields.get('overlapMm'), TILING_MAX_OVERLAP_MM, false) };
}

/**
 * Strictly parses a tiling setting. `undefined` (absent) parses to `undefined`; anything else must be a
 * plain object with a `grid` and an optional `seam`, or this throws InvalidArgumentError. Unknown fields
 * are rejected at every level, including the field of the other seam kind (`gapMm` on an overlap seam).
 *
 * An empty object `{}` is rejected: it names no grid, and the model keeps one spelling ("absent") for "not
 * tiled". A field that is present must hold a value; `{ grid, seam: undefined }` is rejected too.
 */
export function parseTilingSetting(value: unknown): TilingSetting | undefined {
  if (value === undefined) return undefined;
  const fields = readFields('', value, TILING_FIELDS);
  if (fields.size === 0) fail('must name a grid (got an empty object)');
  const grid = readGrid(fields.get('grid'));
  return fields.has('seam') ? { grid, seam: readSeam(fields.get('seam')) } : { grid };
}

/** Lenient read of a stored job's `tiling`: an invalid value reads as absent (`undefined`). */
export function readJobTiling(value: unknown): TilingSetting | undefined {
  try {
    return parseTilingSetting(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) return undefined;
    throw error;
  }
}

/**
 * Job read path for `tiling`: keeps a valid setting, drops an invalid one so the job stays readable and
 * untiled, and adds no key when the setting is absent. Returns a new object.
 */
export function normalizeJobTiling<T extends { readonly tiling?: unknown }>(
  job: T,
): Omit<T, 'tiling'> | (Omit<T, 'tiling'> & { readonly tiling: TilingSetting }) {
  const { tiling, ...rest } = job;
  const setting = readJobTiling(tiling);
  return setting === undefined ? rest : { ...rest, tiling: setting };
}
