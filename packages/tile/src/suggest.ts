import {
  axisFits,
  minUniformCount,
  seamBand,
  seamsError,
  uniformSeams,
  type AxisLimit,
} from "./axis.js";
import { seamTreatmentAt, tile, widthLimitMm } from "./tile.js";
import type { Mm, RectMm, SeamTreatment, TileIssue, TileLimits, TilePage, TileResult, TileSpec } from "./types.js";
import { EPS_MM, isFiniteNumber } from "./units.js";

export interface SuggestOptions extends Omit<TileSpec, "grid" | "seamsX" | "seamsY"> {
  /** User limit on panel width, measured per `accounting`. */
  maxWidthMm?: Mm;
  /** User limit on panel height, measured per `accounting`. */
  maxHeightMm?: Mm;
  /** Regions seams should avoid (faces, text, door handles), in the artwork frame. */
  keepOut?: RectMm[];
  /**
   * Panel-size spreads up to this many mm count as "equal widths" for the
   * tie-break, which lets seams move off keep-out regions. Default 0: only
   * exactly equal panels tie, so keep-outs decide between equal grids only.
   */
  widthToleranceMm?: Mm;
}

export interface Suggestion {
  spec: TileSpec;
  result: TileResult;
  panelCount: number;
  /** True when the grid was laid out for panels turned 90° on the medium. */
  rotated: boolean;
  /** (widest − narrowest visible column) + (tallest − shortest visible row), mm. */
  widthSpreadMm: Mm;
  /** Number of (seam, keep-out) pairs where the seam band crosses the region. */
  keepOutHits: number;
}

export type SuggestResult =
  | { ok: true; suggestion: Suggestion; alternatives: Suggestion[] }
  | { ok: false; issues: TileIssue[] };

type Range = [Mm, Mm];

/**
 * FR4: propose the grid with the fewest panels that satisfies the limits.
 * Ties break on equal panel widths, then on seams avoiding keep-out regions,
 * then on unrotated panels. Deterministic for a given input.
 */
export function suggest(page: TilePage, options: SuggestOptions = {}, limits: TileLimits = {}): SuggestResult {
  const { maxWidthMm, maxHeightMm, keepOut = [], widthToleranceMm = 0, ...rest } = options;
  const base: TileSpec = { ...rest, grid: { mode: "size", maxWidthMm, maxHeightMm } };

  const keepOutIssues = validateKeepOut(keepOut);
  if (keepOutIssues.length > 0) return { ok: false, issues: keepOutIssues };

  const rangesX: Range[] = keepOut.map((r) => [r.x, r.x + r.width]);
  const rangesY: Range[] = keepOut.map((r) => [r.y, r.y + r.height]);
  const accounting = base.accounting ?? "printed";
  const bleedMm = base.bleedMm ?? 0;
  const treatX = seamTreatmentAt(base, "x");
  const treatY = seamTreatmentAt(base, "y");
  const across = widthLimitMm(limits);
  const along = limits.maxLengthMm;

  const orientations = [{ rotated: false, xLimit: across, yLimit: along }];
  if (limits.allowRotation) orientations.push({ rotated: true, xLimit: along, yLimit: across });

  const candidates: Suggestion[] = [];
  for (const o of orientations) {
    const limitX: AxisLimit = { maxMm: maxWidthMm, accounting, printedLimitMm: o.xLimit };
    const limitY: AxisLimit = { maxMm: maxHeightMm, accounting, printedLimitMm: o.yLimit };
    const columns = minUniformCount(page.widthMm, treatX, bleedMm, limitX);
    const rows = minUniformCount(page.heightMm, treatY, bleedMm, limitY);
    if (columns === undefined || rows === undefined) continue;

    const uniformX = uniformSeams(page.widthMm, columns);
    const uniformY = uniformSeams(page.heightMm, rows);
    const seamOptionsX = dedupe([uniformX, avoidKeepOuts(page.widthMm, uniformX, treatX, bleedMm, limitX, rangesX)]);
    const seamOptionsY = dedupe([uniformY, avoidKeepOuts(page.heightMm, uniformY, treatY, bleedMm, limitY, rangesY)]);

    for (const seamsX of seamOptionsX) {
      for (const seamsY of seamOptionsY) {
        const spec: TileSpec = { ...rest, grid: { mode: "count", columns, rows }, seamsX, seamsY };
        const result = tile(page, spec, { ...limits, allowRotation: o.rotated });
        if (!result.ok) continue;
        candidates.push({
          spec,
          result,
          panelCount: result.panels.length,
          rotated: o.rotated,
          widthSpreadMm: widthSpread(result),
          keepOutHits: countHits(seamsX, treatX, rangesX) + countHits(seamsY, treatY, rangesY),
        });
      }
    }
  }

  if (candidates.length === 0) {
    // Explain why with the plain size-mode grid's issues.
    const issues = tile(page, base, limits).issues;
    return {
      ok: false,
      issues: issues.length > 0 ? issues : [{ code: "no-grid-fits", message: "no grid satisfies the limits" }],
    };
  }

  const bucket = (s: Suggestion): number => (s.widthSpreadMm <= widthToleranceMm + EPS_MM ? 0 : s.widthSpreadMm);
  const ranked = [...candidates].sort(
    (a, b) =>
      a.panelCount - b.panelCount ||
      bucket(a) - bucket(b) ||
      a.keepOutHits - b.keepOutHits ||
      a.widthSpreadMm - b.widthSpreadMm ||
      Number(a.rotated) - Number(b.rotated),
  );
  const [best, ...alternatives] = ranked;
  return { ok: true, suggestion: best as Suggestion, alternatives };
}

function validateKeepOut(keepOut: readonly RectMm[]): TileIssue[] {
  return keepOut.flatMap((r, i) =>
    [r.x, r.y, r.width, r.height].every(isFiniteNumber) && r.width >= 0 && r.height >= 0
      ? []
      : [{ code: "invalid-keep-out" as const, message: `keep-out region ${i} needs finite x, y and width, height >= 0` }],
  );
}

function hitsAt(position: Mm, treatment: SeamTreatment, ranges: readonly Range[]): number {
  const [lo, hi] = seamBand(position, treatment);
  // A zero-width (butt) band hits only when strictly inside a region.
  return ranges.filter(([a, b]) => lo < b && hi > a).length;
}

function countHits(seams: readonly Mm[], treatmentAt: (i: number) => SeamTreatment, ranges: readonly Range[]): number {
  return seams.reduce((sum, s, i) => sum + hitsAt(s, treatmentAt(i), ranges), 0);
}

/**
 * Move each seam whose band crosses a keep-out region to the nearest position
 * just outside a region, provided the axis still fits its limits. Greedy, left
 * to right; a seam that cannot move stays put.
 */
function avoidKeepOuts(
  length: Mm,
  seams: readonly Mm[],
  treatmentAt: (i: number) => SeamTreatment,
  bleedMm: Mm,
  limit: AxisLimit,
  ranges: readonly Range[],
): Mm[] {
  let current = [...seams];
  for (let i = 0; i < current.length; i++) {
    const treatment = treatmentAt(i);
    const from = current[i];
    if (from === undefined || hitsAt(from, treatment, ranges) === 0) continue;
    const [bandLo, bandHi] = seamBand(0, treatment);
    const positions = ranges
      .flatMap(([a, b]) => [a - bandHi, b - bandLo])
      .filter((p) => hitsAt(p, treatment, ranges) === 0)
      .sort((p, q) => Math.abs(p - from) - Math.abs(q - from) || p - q);
    for (const p of positions) {
      const trial = current.map((s, j) => (j === i ? p : s));
      if (seamsError(length, trial) === undefined && axisFits(length, trial, treatmentAt, bleedMm, limit)) {
        current = trial;
        break;
      }
    }
  }
  return current;
}

function widthSpread(result: TileResult): Mm {
  const widths = result.panels.filter((p) => p.row === 1).map((p) => p.visible.width);
  const heights = result.panels.filter((p) => p.col === 1).map((p) => p.visible.height);
  const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);
  return spread(widths) + spread(heights);
}

function dedupe(options: Mm[][]): Mm[][] {
  const seen = new Set<string>();
  return options.filter((seams) => {
    const key = seams.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
