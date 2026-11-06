import { EPS } from "./geometry.js";
import type { Rotation } from "./types.js";

/** Most pages one n-up or booklet plan may hold. */
export const MAX_PAGES = 10_000;
/** Most sheets one n-up or booklet plan may produce. */
export const MAX_SHEETS = 5_000;
/** Most rows, and most columns, of one n-up grid. */
export const MAX_GRID = 50;

/** Invalid planner input: a bad or over-limit count, a bad length, or a cell that does not fit. */
export class NestInputError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "NestInputError";
  }
}

/** A page number (1-based) or an empty slot. */
export type PageSlot = number | "blank";

/** Exact ceil(a / b) for a non-negative integer a and a positive integer b. */
export function ceilDiv(a: number, b: number): number {
  const remainder = a % b;
  return (a - remainder) / b + (remainder === 0 ? 0 : 1);
}

/** Integer in [1, max]. */
export function requireCount(fn: string, name: string, value: number, max: number): void {
  if (!Number.isInteger(value)) throw new NestInputError(`${fn}: ${name} must be an integer, got ${value}`);
  if (value < 1) throw new NestInputError(`${fn}: ${name} must be at least 1, got ${value}`);
  if (value > max) throw new NestInputError(`${fn}: ${name} must be at most ${max}, got ${value}`);
}

export function requireFinite(fn: string, name: string, value: number): void {
  if (!Number.isFinite(value)) throw new NestInputError(`${fn}: ${name} must be a finite number, got ${value}`);
}

function requirePositive(fn: string, name: string, value: number): void {
  requireFinite(fn, name, value);
  if (value <= 0) throw new NestInputError(`${fn}: ${name} must be positive, got ${value}`);
}

export function requireNonNegative(fn: string, name: string, value: number): void {
  requireFinite(fn, name, value);
  if (value < 0) throw new NestInputError(`${fn}: ${name} must not be negative, got ${value}`);
}

/** Width and height in points. */
export interface NUpSize {
  readonly width: number;
  readonly height: number;
}

/** "upright" keeps the cell at 0 degrees, "turned" at 90, "auto" keeps whichever fits more cells (tie: upright). */
export type NUpOrientation = "upright" | "turned" | "auto";

export interface NUpOptions {
  sheet: NUpSize;
  /** Cell size before rotation. */
  cell: NUpSize;
  /** 1..MAX_GRID. Omitted: as many as fit, capped at MAX_GRID. */
  rows?: number;
  /** 1..MAX_GRID. Omitted: as many as fit, capped at MAX_GRID. */
  cols?: number;
  /** Gap between neighboring cells, both axes. 0..min(sheet width, sheet height). Default 0. */
  gutter?: number;
  /** Same on all four sheet edges. Default 0. */
  margin?: number;
  /** Default "upright". */
  orientation?: NUpOrientation;
  /** 1..MAX_PAGES. Omitted: the plan has no sheets. */
  pageCount?: number;
}

export interface NUpPlacement {
  /** Slot index on every sheet: row * cols + col. */
  readonly index: number;
  /** Row 0 is at the top of the sheet. */
  readonly row: number;
  /** Column 0 is at the left of the sheet. */
  readonly col: number;
  /** Bottom-left of the footprint, in sheet coordinates (y up). */
  readonly x: number;
  readonly y: number;
  /** Footprint after rotation. */
  readonly width: number;
  readonly height: number;
  readonly rotation: Rotation;
}

export interface NUpSheet {
  readonly index: number;
  /** `pages[k]` goes into `placements[k]`. */
  readonly pages: readonly PageSlot[];
}

export interface NUpPlan {
  readonly rows: number;
  readonly cols: number;
  readonly rotation: Rotation;
  readonly cellsPerSheet: number;
  /** 0 when no page count was given. */
  readonly pageCount: number;
  /** Empty slots on the last sheet. */
  readonly blankCount: number;
  readonly placements: readonly NUpPlacement[];
  readonly sheets: readonly NUpSheet[];
}

const FN = "planNUp";
const ORIENTATIONS: readonly NUpOrientation[] = ["upright", "turned", "auto"];

interface Grid {
  readonly rotation: Rotation;
  readonly w: number;
  readonly h: number;
  readonly rows: number;
  readonly cols: number;
}

function optionalCount(name: string, value: number | undefined, max: number): void {
  if (value === undefined) return;
  requireCount(FN, name, value, max);
}

function validate(opts: NUpOptions): void {
  const { sheet, cell } = opts;
  requirePositive(FN, "sheet width", sheet.width);
  requirePositive(FN, "sheet height", sheet.height);
  requirePositive(FN, "cell width", cell.width);
  requirePositive(FN, "cell height", cell.height);
  const gutter = opts.gutter ?? 0;
  requireNonNegative(FN, "gutter", gutter);
  const minSide = Math.min(sheet.width, sheet.height);
  if (gutter > minSide) {
    throw new NestInputError(`${FN}: gutter must be at most the smaller sheet side ${minSide}, got ${gutter}`);
  }
  const margin = opts.margin ?? 0;
  requireNonNegative(FN, "margin", margin);
  if (2 * margin >= minSide) {
    throw new NestInputError(`${FN}: margin ${margin} leaves no usable area on a ${sheet.width} x ${sheet.height} sheet`);
  }
  optionalCount("rows", opts.rows, MAX_GRID);
  optionalCount("cols", opts.cols, MAX_GRID);
  optionalCount("pageCount", opts.pageCount, MAX_PAGES);
  const orientation = opts.orientation ?? "upright";
  if (!ORIENTATIONS.includes(orientation)) {
    throw new NestInputError(`${FN}: orientation must be one of ${ORIENTATIONS.join(", ")}, got ${orientation}`);
  }
}

/** Length of `count` cells of `size` with gutters between them. */
function span(count: number, size: number, gutter: number): number {
  return count * size + (count - 1) * gutter;
}

function fitCount(usable: number, size: number, gutter: number): number {
  return Math.min(MAX_GRID, Math.floor((usable + gutter + EPS) / (size + gutter)));
}

/** Grid for one rotation, or undefined when not even the requested (or one) cell fits. */
function gridFor(rotation: Rotation, w: number, h: number, opts: NUpOptions): Grid | undefined {
  const gutter = opts.gutter ?? 0;
  const margin = opts.margin ?? 0;
  const usableW = opts.sheet.width - 2 * margin;
  const usableH = opts.sheet.height - 2 * margin;
  const cols = opts.cols ?? fitCount(usableW, w, gutter);
  const rows = opts.rows ?? fitCount(usableH, h, gutter);
  if (cols < 1 || rows < 1) return undefined;
  if (span(cols, w, gutter) > usableW + EPS || span(rows, h, gutter) > usableH + EPS) return undefined;
  return { rotation, w, h, rows, cols };
}

function chooseGrid(opts: NUpOptions): Grid | undefined {
  const { width, height } = opts.cell;
  const orientation = opts.orientation ?? "upright";
  if (orientation === "upright") return gridFor(0, width, height, opts);
  if (orientation === "turned") return gridFor(90, height, width, opts);
  const upright = gridFor(0, width, height, opts);
  const turned = gridFor(90, height, width, opts);
  if (!upright) return turned;
  if (!turned) return upright;
  return turned.rows * turned.cols > upright.rows * upright.cols ? turned : upright;
}

function placementsFor(grid: Grid, opts: NUpOptions): NUpPlacement[] {
  const gutter = opts.gutter ?? 0;
  const margin = opts.margin ?? 0;
  const top = opts.sheet.height - margin;
  return Array.from({ length: grid.rows * grid.cols }, (_, index) => {
    const col = index % grid.cols;
    const row = (index - col) / grid.cols;
    return {
      index,
      row,
      col,
      x: margin + col * (grid.w + gutter),
      y: top - grid.h - row * (grid.h + gutter),
      width: grid.w,
      height: grid.h,
      rotation: grid.rotation,
    };
  });
}

function sheetsFor(pageCount: number, cellsPerSheet: number): NUpSheet[] {
  const sheetCount = ceilDiv(pageCount, cellsPerSheet);
  if (sheetCount > MAX_SHEETS) {
    throw new NestInputError(
      `${FN}: ${pageCount} pages at ${cellsPerSheet} per sheet need ${sheetCount} sheets, more than the limit of ${MAX_SHEETS}`,
    );
  }
  return Array.from({ length: sheetCount }, (_, index) => ({
    index,
    pages: Array.from({ length: cellsPerSheet }, (_unused, slot): PageSlot => {
      const page = index * cellsPerSheet + slot + 1;
      return page <= pageCount ? page : "blank";
    }),
  }));
}

/**
 * Plans an n-up grid of equal cells on a sheet and assigns pages to the cells in
 * reading order (left to right, top to bottom), sheet after sheet. The grid is
 * anchored at the top-left margin corner; gutters separate neighboring cells
 * only. Pure: no rendering, no I/O. Throws a NestInputError for invalid input or
 * a cell (or requested grid) that does not fit.
 */
export function planNUp(opts: NUpOptions): NUpPlan {
  validate(opts);
  const grid = chooseGrid(opts);
  if (!grid) {
    const requested = `${opts.rows ?? "auto"} rows x ${opts.cols ?? "auto"} cols`;
    throw new NestInputError(
      `${FN}: ${requested} of ${opts.cell.width} x ${opts.cell.height} cells do not fit a ` +
        `${opts.sheet.width} x ${opts.sheet.height} sheet with margin ${opts.margin ?? 0} and gutter ${opts.gutter ?? 0}`,
    );
  }
  const cellsPerSheet = grid.rows * grid.cols;
  const pageCount = opts.pageCount ?? 0;
  const sheets = pageCount === 0 ? [] : sheetsFor(pageCount, cellsPerSheet);
  return {
    rows: grid.rows,
    cols: grid.cols,
    rotation: grid.rotation,
    cellsPerSheet,
    pageCount,
    blankCount: sheets.length * cellsPerSheet - pageCount,
    placements: placementsFor(grid, opts),
    sheets,
  };
}
