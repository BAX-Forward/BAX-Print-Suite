import type { EdgeKind, Mm, SeamTreatment, SizeAccounting, TileIssueCode } from "./types.js";
import { EPS_MM, isFiniteNumber } from "./units.js";

/**
 * About one inch: a common wallcovering and vinyl overlap that tolerates
 * installer error and material movement (Spec 009 FR2).
 */
export const DEFAULT_OVERLAP_MM = 25;
export const DEFAULT_SEAM: SeamTreatment = { kind: "overlap", overlapMm: DEFAULT_OVERLAP_MM };

/** Upper bound on panels per axis; keeps size-mode search and validation bounded. */
export const MAX_PANELS_PER_AXIS = 500;

/** One panel's extent along one axis, in the artwork frame. */
export interface AxisSpan {
  visLo: Mm;
  visHi: Mm;
  prLo: Mm;
  prHi: Mm;
  loEdge: EdgeKind;
  hiEdge: EdgeKind;
  loOverlap: Mm;
  hiOverlap: Mm;
}

export interface AxisProblem {
  code: TileIssueCode;
  message: string;
  seamIndex?: number;
}

export function overlapOf(treatment: SeamTreatment): Mm {
  return treatment.kind === "overlap" ? (treatment.overlapMm ?? DEFAULT_OVERLAP_MM) : 0;
}

export function gapOf(treatment: SeamTreatment): Mm {
  return treatment.kind === "gap" ? treatment.gapMm : 0;
}

/** The strip around a seam where the seam shows on the wall: the overlap, or the unprinted gap. */
export function seamBand(position: Mm, treatment: SeamTreatment): [Mm, Mm] {
  const half = Math.max(overlapOf(treatment), gapOf(treatment) / 2);
  return [position - half, position + half];
}

export function treatmentError(treatment: SeamTreatment): string | undefined {
  switch (treatment.kind) {
    case "overlap":
      if (treatment.overlapMm !== undefined && !(isFiniteNumber(treatment.overlapMm) && treatment.overlapMm >= 0)) {
        return "overlapMm must be a finite number >= 0";
      }
      return undefined;
    case "butt":
      return undefined;
    case "gap":
      if (!(isFiniteNumber(treatment.gapMm) && treatment.gapMm > 0)) {
        return "gapMm must be a finite number > 0";
      }
      return undefined;
    default:
      return `unknown seam treatment "${String((treatment as { kind?: unknown }).kind)}"`;
  }
}

/** Seams that divide `length` into `count` equal visible parts. */
export function uniformSeams(length: Mm, count: number): Mm[] {
  return Array.from({ length: count - 1 }, (_, i) => ((i + 1) * length) / count);
}

/** Error message for an explicit seam list, or undefined when valid. */
export function seamsError(length: Mm, seams: readonly Mm[]): string | undefined {
  if (seams.length + 1 > MAX_PANELS_PER_AXIS) {
    return `at most ${MAX_PANELS_PER_AXIS} panels per axis`;
  }
  for (let i = 0; i < seams.length; i++) {
    const s = seams[i];
    const prev = seams[i - 1];
    if (!isFiniteNumber(s)) return `seam ${i} is not a finite number`;
    if (s <= 0 || s >= length) return `seam ${i} at ${s} mm is outside the artwork (0, ${length})`;
    if (prev !== undefined && s <= prev) return `seams must be strictly increasing (seam ${i})`;
  }
  return undefined;
}

/**
 * Panel extents along one axis. `treatments[i]` applies to `seams[i]`.
 * Bleed is added on every edge of every panel's printed extent.
 */
export function axisSpans(
  length: Mm,
  seams: readonly Mm[],
  treatments: readonly SeamTreatment[],
  bleedMm: Mm,
): AxisSpan[] {
  const count = seams.length + 1;
  return Array.from({ length: count }, (_, i) => {
    const lo = i === 0 ? undefined : treatments[i - 1];
    const hi = i === count - 1 ? undefined : treatments[i];
    const loSeam = seams[i - 1];
    const hiSeam = seams[i];
    const visLo = lo && loSeam !== undefined ? loSeam + gapOf(lo) / 2 : 0;
    const visHi = hi && hiSeam !== undefined ? hiSeam - gapOf(hi) / 2 : length;
    const loOverlap = lo ? overlapOf(lo) : 0;
    const hiOverlap = hi ? overlapOf(hi) : 0;
    return {
      visLo,
      visHi,
      prLo: visLo - loOverlap - bleedMm,
      prHi: visHi + hiOverlap + bleedMm,
      loEdge: lo ? lo.kind : "outer",
      hiEdge: hi ? hi.kind : "outer",
      loOverlap,
      hiOverlap,
    };
  });
}

/** Geometric problems of a span list: empty panels, or overlaps wider than a neighbour. */
export function axisProblems(spans: readonly AxisSpan[]): AxisProblem[] {
  const problems: AxisProblem[] = [];
  spans.forEach((span, i) => {
    if (span.visHi - span.visLo <= EPS_MM) {
      problems.push({ code: "panel-too-small", message: `panel ${i + 1} has no visible area` });
    }
  });
  spans.forEach((span, i) => {
    const next = spans[i + 1];
    if (!next) return;
    const overlap = span.hiOverlap;
    const narrowest = Math.min(span.visHi - span.visLo, next.visHi - next.visLo);
    if (overlap > narrowest + EPS_MM) {
      problems.push({
        code: "overlap-exceeds-panel",
        seamIndex: i,
        message: `overlap of ${overlap} mm at seam ${i} is wider than a neighbouring panel (${narrowest} mm)`,
      });
    }
  });
  return problems;
}

export function spanSize(span: AxisSpan, accounting: SizeAccounting): Mm {
  return accounting === "visible" ? span.visHi - span.visLo : span.prHi - span.prLo;
}

export interface AxisLimit {
  /** User size limit, measured per `accounting`. */
  maxMm?: Mm;
  accounting: SizeAccounting;
  /** Device or medium limit, always measured on the printed size. */
  printedLimitMm?: Mm;
}

export function spanFits(span: AxisSpan, limit: AxisLimit): boolean {
  if (limit.maxMm !== undefined && spanSize(span, limit.accounting) > limit.maxMm + EPS_MM) return false;
  if (limit.printedLimitMm !== undefined && span.prHi - span.prLo > limit.printedLimitMm + EPS_MM) return false;
  return true;
}

/** True when the seams give a geometrically valid axis whose panels all fit `limit`. */
export function axisFits(
  length: Mm,
  seams: readonly Mm[],
  treatmentAt: (seamIndex: number) => SeamTreatment,
  bleedMm: Mm,
  limit: AxisLimit,
): boolean {
  const spans = axisSpans(length, seams, seams.map((_, i) => treatmentAt(i)), bleedMm);
  return axisProblems(spans).length === 0 && spans.every((span) => spanFits(span, limit));
}

/** Fewest equal panels along an axis that fit `limit`, or undefined if none up to the per-axis maximum. */
export function minUniformCount(
  length: Mm,
  treatmentAt: (seamIndex: number) => SeamTreatment,
  bleedMm: Mm,
  limit: AxisLimit,
): number | undefined {
  for (let count = 1; count <= MAX_PANELS_PER_AXIS; count++) {
    if (axisFits(length, uniformSeams(length, count), treatmentAt, bleedMm, limit)) return count;
  }
  return undefined;
}
