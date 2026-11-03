/**
 * FR9: reusable grid definitions as `TileTemplate` JSON.
 *
 * A template stores everything in a `TileSpec`. With `absolute` positioning,
 * explicit seams are mm from the artwork origin, as in `TileSpec`. With
 * `relative` positioning they are fractions of the artwork width (x) or height
 * (y), strictly between 0 and 1, so one template fits artwork of any size.
 * Size limits, overlaps, gaps and bleed are physical and stay in mm either way.
 */
import { MAX_PANELS_PER_AXIS, treatmentError } from "./axis.js";
import type { GridDef, LabelStyle, Mm, PanelNaming, SeamTreatment, SizeAccounting, TilePage, TileSpec } from "./types.js";
import { isFiniteNumber } from "./units.js";

export const TILE_TEMPLATE_KIND = "bps.tile-template";
export const TILE_TEMPLATE_VERSION = 1;

export type SeamPositioning = "absolute" | "relative";

export interface TileTemplate extends Omit<TileSpec, "seamsX" | "seamsY"> {
  kind: typeof TILE_TEMPLATE_KIND;
  version: typeof TILE_TEMPLATE_VERSION;
  name: string;
  description?: string;
  positioning: SeamPositioning;
  /** mm (`absolute`) or fractions of the artwork width (`relative`). */
  seamsX?: number[];
  /** mm (`absolute`) or fractions of the artwork height (`relative`). */
  seamsY?: number[];
}

export type TemplateOptions =
  | { name: string; description?: string; positioning: "absolute" }
  | { name: string; description?: string; positioning: "relative"; page: TilePage };

export type ParseTemplateResult = { ok: true; template: TileTemplate } | { ok: false; errors: string[] };

/** Save a spec as a template. Relative positioning needs the artwork the seams were drawn on. */
export function templateFromSpec(spec: TileSpec, options: TemplateOptions): TileTemplate {
  const { seamsX, seamsY, ...rest } = spec;
  const page = options.positioning === "relative" ? options.page : undefined;
  const scale = (seams: readonly Mm[] | undefined, length: Mm | undefined): number[] | undefined =>
    seams?.map((s) => (length === undefined ? s : s / length));
  const x = scale(seamsX, page?.widthMm);
  const y = scale(seamsY, page?.heightMm);
  return {
    kind: TILE_TEMPLATE_KIND,
    version: TILE_TEMPLATE_VERSION,
    name: options.name,
    ...(options.description !== undefined ? { description: options.description } : {}),
    positioning: options.positioning,
    ...structuredClone(rest),
    ...(x ? { seamsX: x } : {}),
    ...(y ? { seamsY: y } : {}),
  };
}

/** Apply a template to artwork. Seam bounds against the artwork are checked later by `tile()`. */
export function specFromTemplate(template: TileTemplate, page: TilePage): TileSpec {
  const { kind: _kind, version: _version, name: _name, description: _description, positioning, seamsX, seamsY, ...rest } =
    template;
  const place = (seams: readonly number[] | undefined, length: Mm): Mm[] | undefined =>
    seams?.map((s) => (positioning === "relative" ? s * length : s));
  const x = place(seamsX, page.widthMm);
  const y = place(seamsY, page.heightMm);
  return {
    ...structuredClone(rest),
    ...(x ? { seamsX: x } : {}),
    ...(y ? { seamsY: y } : {}),
  };
}

export function serializeTileTemplate(template: TileTemplate): string {
  return `${JSON.stringify(template, null, 2)}\n`;
}

/**
 * Validate a template read from disk or the network (a JSON string or a parsed
 * value). Returns a fresh object holding only the known fields.
 */
export function parseTileTemplate(input: unknown): ParseTemplateResult {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] };
    }
  }
  if (!isRecord(value)) return { ok: false, errors: ["template must be a JSON object"] };

  const errors: string[] = [];
  if (value.kind !== TILE_TEMPLATE_KIND) errors.push(`kind must be "${TILE_TEMPLATE_KIND}"`);
  if (value.version !== TILE_TEMPLATE_VERSION) errors.push(`version must be ${TILE_TEMPLATE_VERSION}`);
  if (typeof value.name !== "string" || value.name.trim() === "") errors.push("name must be a non-empty string");
  if (value.description !== undefined && typeof value.description !== "string") {
    errors.push("description must be a string");
  }
  const positioning = value.positioning;
  if (positioning !== "absolute" && positioning !== "relative") {
    errors.push('positioning must be "absolute" or "relative"');
  }

  const grid = parseGrid(value.grid, errors);
  const seamsX = parseSeams(value.seamsX, "seamsX", positioning, errors);
  const seamsY = parseSeams(value.seamsY, "seamsY", positioning, errors);
  const accounting = parseAccounting(value.accounting, errors);
  const seam = value.seam === undefined ? undefined : parseTreatment(value.seam, "seam", errors);
  const seamTreatmentsX = parseTreatmentList(value.seamTreatmentsX, "seamTreatmentsX", errors);
  const seamTreatmentsY = parseTreatmentList(value.seamTreatmentsY, "seamTreatmentsY", errors);
  if (value.bleedMm !== undefined && !(isFiniteNumber(value.bleedMm) && value.bleedMm >= 0)) {
    errors.push("bleedMm must be a finite number >= 0");
  }
  const naming = parseNaming(value.naming, errors);

  if (errors.length > 0 || !grid) return { ok: false, errors };
  const template: TileTemplate = {
    kind: TILE_TEMPLATE_KIND,
    version: TILE_TEMPLATE_VERSION,
    name: value.name as string,
    ...(value.description !== undefined ? { description: value.description as string } : {}),
    positioning: positioning as SeamPositioning,
    grid,
    ...(seamsX ? { seamsX } : {}),
    ...(seamsY ? { seamsY } : {}),
    ...(accounting ? { accounting } : {}),
    ...(seam ? { seam } : {}),
    ...(seamTreatmentsX ? { seamTreatmentsX } : {}),
    ...(seamTreatmentsY ? { seamTreatmentsY } : {}),
    ...(value.bleedMm !== undefined ? { bleedMm: value.bleedMm as Mm } : {}),
    ...(naming ? { naming } : {}),
  };
  return { ok: true, template };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGrid(value: unknown, errors: string[]): GridDef | undefined {
  if (!isRecord(value)) {
    errors.push("grid must be an object");
    return undefined;
  }
  if (value.mode === "count") {
    const valid = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_PANELS_PER_AXIS;
    if (!valid(value.columns) || !valid(value.rows)) {
      errors.push(`grid.columns and grid.rows must be integers from 1 to ${MAX_PANELS_PER_AXIS}`);
      return undefined;
    }
    return { mode: "count", columns: value.columns as number, rows: value.rows as number };
  }
  if (value.mode === "size") {
    const optionalPositive = (n: unknown): boolean => n === undefined || (isFiniteNumber(n) && n > 0);
    if (!optionalPositive(value.maxWidthMm) || !optionalPositive(value.maxHeightMm)) {
      errors.push("grid.maxWidthMm and grid.maxHeightMm must be finite numbers > 0 when set");
      return undefined;
    }
    return {
      mode: "size",
      ...(value.maxWidthMm !== undefined ? { maxWidthMm: value.maxWidthMm as Mm } : {}),
      ...(value.maxHeightMm !== undefined ? { maxHeightMm: value.maxHeightMm as Mm } : {}),
    };
  }
  errors.push('grid.mode must be "count" or "size"');
  return undefined;
}

function parseSeams(value: unknown, field: string, positioning: unknown, errors: string[]): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isFiniteNumber)) {
    errors.push(`${field} must be an array of finite numbers`);
    return undefined;
  }
  if (value.length + 1 > MAX_PANELS_PER_AXIS) {
    errors.push(`${field}: at most ${MAX_PANELS_PER_AXIS} panels per axis`);
    return undefined;
  }
  const inRange = positioning === "relative" ? (s: number) => s > 0 && s < 1 : (s: number) => s > 0;
  const bound = positioning === "relative" ? "strictly between 0 and 1" : "> 0";
  for (const [i, s] of value.entries()) {
    const prev = value[i - 1];
    if (!inRange(s)) {
      errors.push(`${field}[${i}] must be ${bound}`);
      return undefined;
    }
    if (prev !== undefined && s <= prev) {
      errors.push(`${field} must be strictly increasing (index ${i})`);
      return undefined;
    }
  }
  return [...value];
}

function parseAccounting(value: unknown, errors: string[]): SizeAccounting | undefined {
  if (value === undefined) return undefined;
  if (value === "visible" || value === "printed") return value;
  errors.push('accounting must be "visible" or "printed"');
  return undefined;
}

function parseTreatment(value: unknown, field: string, errors: string[]): SeamTreatment | undefined {
  if (!isRecord(value)) {
    errors.push(`${field} must be an object`);
    return undefined;
  }
  let treatment: SeamTreatment;
  switch (value.kind) {
    case "overlap":
      treatment = value.overlapMm === undefined ? { kind: "overlap" } : { kind: "overlap", overlapMm: value.overlapMm as Mm };
      break;
    case "butt":
      treatment = { kind: "butt" };
      break;
    case "gap":
      treatment = { kind: "gap", gapMm: value.gapMm as Mm };
      break;
    default:
      errors.push(`${field}.kind must be "overlap", "butt" or "gap"`);
      return undefined;
  }
  const error = treatmentError(treatment);
  if (error) {
    errors.push(`${field}: ${error}`);
    return undefined;
  }
  return treatment;
}

function parseTreatmentList(value: unknown, field: string, errors: string[]): (SeamTreatment | null)[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return undefined;
  }
  // `null` keeps a slot on the default treatment (JSON has no `undefined`).
  return value.map((t, i) => (t === null ? null : (parseTreatment(t, `${field}[${i}]`, errors) ?? null)));
}

function parseNaming(value: unknown, errors: string[]): PanelNaming | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push("naming must be an object");
    return undefined;
  }
  const style = (v: unknown): boolean => v === undefined || v === "letters" || v === "numbers";
  if (!style(value.rows) || !style(value.cols)) {
    errors.push('naming.rows and naming.cols must be "letters" or "numbers"');
    return undefined;
  }
  if (value.separator !== undefined && typeof value.separator !== "string") {
    errors.push("naming.separator must be a string");
    return undefined;
  }
  return {
    ...(value.rows !== undefined ? { rows: value.rows as LabelStyle } : {}),
    ...(value.cols !== undefined ? { cols: value.cols as LabelStyle } : {}),
    ...(value.separator !== undefined ? { separator: value.separator as string } : {}),
  };
}
