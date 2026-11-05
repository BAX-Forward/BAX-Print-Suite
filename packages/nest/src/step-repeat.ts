import { EPS } from "./geometry.js";
import type { Layout, Margins, Placement, Rotation } from "./types.js";
import { POINTS_PER } from "./units.js";

export type StepRepeatRotation = "none" | "auto";

export interface StepRepeatItem {
  id: string;
  widthMm: number;
  heightMm: number;
}

export interface StepRepeatOptions {
  item: StepRepeatItem;
  copies: number;
  /** Cap on grid cells (rows x columns); defaults to MAX_STEP_REPEAT_PLACEMENTS. */
  maxPlacements?: number;
  rollWidthMm: number;
  /** Millimetres, not points. */
  marginsMm: Margins;
  /** Gap between neighboring columns (across the roll). */
  gapXMm: number;
  /** Gap between neighboring rows (along the feed). */
  gapYMm: number;
  /** "auto" tries 0 and 90 degrees and keeps the shorter length (tie: 0). Default "none". */
  rotate?: StepRepeatRotation;
}

export const STEP_REPEAT_ALGORITHM = "step-repeat";

/** One orientation's grid, in millimetres. */
interface Grid {
  readonly rotation: Rotation;
  readonly w: number;
  readonly h: number;
  readonly columns: number;
  readonly rows: number;
  readonly lengthMm: number;
}

const toPt = (mm: number): number => mm * POINTS_PER.mm;

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`stepAndRepeat: ${name} must be a finite number, got ${value}`);
}

function requirePositive(name: string, value: number): void {
  requireFinite(name, value);
  if (value <= 0) throw new RangeError(`stepAndRepeat: ${name} must be positive, got ${value}`);
}

function requireNonNegative(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0) throw new RangeError(`stepAndRepeat: ${name} must not be negative, got ${value}`);
}

/** Most copies one step-and-repeat request may ask for (memory guard for route inputs). */
export const MAX_STEP_REPEAT_COPIES = 10_000;
/**
 * Default cap on grid cells (rows x columns) one layout may span. A full grid never exceeds
 * twice the copies, so the default leaves headroom over MAX_STEP_REPEAT_COPIES; callers can
 * lower it with `maxPlacements`.
 */
export const MAX_STEP_REPEAT_PLACEMENTS = 20_000;

function validate(opts: StepRepeatOptions): void {
  if (!Number.isInteger(opts.copies) || opts.copies < 1) {
    throw new RangeError(`stepAndRepeat: copies must be a positive integer, got ${opts.copies}`);
  }
  if (opts.copies > MAX_STEP_REPEAT_COPIES) {
    throw new RangeError(`stepAndRepeat: copies must be at most ${MAX_STEP_REPEAT_COPIES}, got ${opts.copies}`);
  }
  requirePositive("item width", opts.item.widthMm);
  requirePositive("item height", opts.item.heightMm);
  requirePositive("roll width", opts.rollWidthMm);
  requireNonNegative("gapXMm", opts.gapXMm);
  requireNonNegative("gapYMm", opts.gapYMm);
  const { left, right, lead, trail } = opts.marginsMm;
  for (const [side, value] of [["left", left], ["right", right], ["lead", lead], ["trail", trail]] as const) {
    requireNonNegative(`${side} margin`, value);
  }
}

/** Grid for one orientation, or undefined when a single copy is wider than the printable width. */
function gridFor(
  rotation: Rotation,
  w: number,
  h: number,
  printableWidth: number,
  opts: StepRepeatOptions,
): Grid | undefined {
  const fit = Math.floor((printableWidth + opts.gapXMm + EPS) / (w + opts.gapXMm));
  if (fit < 1) return undefined;
  const columns = Math.min(fit, opts.copies);
  const rows = Math.ceil(opts.copies / columns);
  const maxPlacements = opts.maxPlacements ?? MAX_STEP_REPEAT_PLACEMENTS;
  if (rows * columns > maxPlacements) {
    throw new RangeError(`stepAndRepeat: ${rows} x ${columns} placements exceed the limit of ${maxPlacements}`);
  }
  return { rotation, w, h, columns, rows, lengthMm: rows * h + (rows - 1) * opts.gapYMm };
}

function chooseGrid(opts: StepRepeatOptions, printableWidth: number): Grid | undefined {
  const { widthMm, heightMm } = opts.item;
  const upright = gridFor(0, widthMm, heightMm, printableWidth, opts);
  if (opts.rotate !== "auto") return upright;
  const turned = gridFor(90, heightMm, widthMm, printableWidth, opts);
  if (!upright) return turned;
  if (!turned) return upright;
  return turned.lengthMm < upright.lengthMm - EPS ? turned : upright;
}

/**
 * Places `copies` copies of one item in a grid on roll media: as many columns as
 * fit across the printable width, filled row by row from the lead edge. Gaps
 * separate neighboring copies only, so copies may touch the margins. Throws a
 * RangeError for invalid input or an item that does not fit in any allowed rotation.
 */
export function stepAndRepeat(opts: StepRepeatOptions): Layout {
  const start = performance.now();
  validate(opts);
  const { marginsMm: margins } = opts;
  const printableWidth = opts.rollWidthMm - margins.left - margins.right;
  const grid = chooseGrid(opts, printableWidth);
  if (!grid) {
    const turns = opts.rotate === "auto" ? "in either rotation" : "without rotation";
    throw new RangeError(
      `stepAndRepeat: item ${opts.item.id} is wider than the printable width ${printableWidth} mm ${turns}`,
    );
  }

  const footprint = { w: toPt(grid.w), h: toPt(grid.h) };
  const placements: Placement[] = Array.from({ length: opts.copies }, (_, copy) => ({
    itemId: opts.item.id,
    copy,
    xPt: toPt((copy % grid.columns) * (grid.w + opts.gapXMm)),
    yPt: toPt(Math.floor(copy / grid.columns) * (grid.h + opts.gapYMm)),
    rotation: grid.rotation,
    footprint: { ...footprint },
    panel: 0,
  }));
  const lengthUsedPt = toPt(grid.lengthMm);
  const available = toPt(printableWidth) * lengthUsedPt;
  return {
    placements,
    mediaWidthPt: toPt(opts.rollWidthMm),
    lengthUsedPt,
    utilization: available > 0 ? (opts.copies * footprint.w * footprint.h) / available : 0,
    unplaced: [],
    algorithm: STEP_REPEAT_ALGORITHM,
    elapsedMs: performance.now() - start,
    media: {
      widthPt: toPt(opts.rollWidthMm),
      margins: {
        left: toPt(margins.left),
        right: toPt(margins.right),
        lead: toPt(margins.lead),
        trail: toPt(margins.trail),
      },
    },
    panels: [{ index: 0, offsetPt: 0, lengthPt: lengthUsedPt }],
  };
}
