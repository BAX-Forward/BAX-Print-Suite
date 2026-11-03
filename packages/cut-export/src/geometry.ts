import type { BBox, Contour, Point, SemanticTool } from "@bax-print/plugin-sdk";

export const PT_PER_MM = 72 / 25.4;
export const MM_PER_INCH = 25.4;

export const mmToPt = (mm: number): number => mm * PT_PER_MM;
export const ptToMm = (pt: number): number => pt / PT_PER_MM;

/**
 * Half-away-from-zero rounding (2.5 -> 3, -2.5 -> -3). `Math.round` alone rounds
 * negative halves toward +infinity, which would make output depend on the origin.
 */
export function roundHalfAwayFromZero(value: number): number {
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  return rounded === 0 ? 0 : rounded; // no negative zero
}

/** Rounds half away from zero to `decimals` places and prints exactly that many decimals. */
export function formatFixed(value: number, decimals: number): string {
  const factor = 10 ** decimals;
  return (roundHalfAwayFromZero(value * factor) / factor).toFixed(decimals);
}

/** Like `formatFixed` but without trailing zeros ("12.5", "10", "1.3807"). */
export function formatCompact(value: number, decimals = 4): string {
  const factor = 10 ** decimals;
  return String(roundHalfAwayFromZero(value * factor) / factor);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function bboxOf(points: readonly Point[]): BBox {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return points.reduce<BBox>(
    (box, [x, y]) => ({
      minX: Math.min(box.minX, x),
      minY: Math.min(box.minY, y),
      maxX: Math.max(box.maxX, x),
      maxY: Math.max(box.maxY, y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

/** Shoelace area; positive for counter-clockwise rings in a y-up frame. */
export function signedArea(points: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    twice += x0 * y1 - x1 * y0;
  }
  return twice / 2;
}

/** Builds a Contour with derived bbox and signed area. Points are in pt. */
export function makeContour(args: {
  id: string;
  tool: SemanticTool;
  points: Point[];
  closed: boolean;
  source?: Contour["source"];
}): Contour {
  return {
    id: args.id,
    tool: args.tool,
    source: args.source ?? { kind: "spot", name: String(args.tool) },
    closed: args.closed,
    points: args.points,
    bbox: bboxOf(args.points),
    areaSigned: args.closed ? signedArea(args.points) : 0,
  };
}

/** Removes consecutive points closer than `epsilon` (same units as the points). */
export function dedupeConsecutive(points: readonly Point[], epsilon: number): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || distance(last, p) >= epsilon) out.push(p);
  }
  return out;
}

/** A file-name-safe stem derived from a job id. */
export function safeFileStem(jobId: string, maxLength = 64): string {
  const cleaned = jobId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : "job";
}
