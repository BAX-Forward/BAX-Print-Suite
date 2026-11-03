import { uniquePoints, type Point } from "./geometry.js";
import type { Edge } from "./schema.js";

const SPAN_EPS = 1e-9;

/**
 * Positions along an edge of `lengthMm`: one at `insetMm` from each corner and
 * the rest evenly between them, using the fewest equal gaps that are ≤ `spacingMm`.
 * Returns the edge midpoint alone when the edge is too short for two corners.
 */
export function distributeAlongEdge(lengthMm: number, insetMm: number, spacingMm: number): number[] {
  const span = lengthMm - 2 * insetMm;
  if (span <= SPAN_EPS) return [lengthMm / 2];
  const gaps = Math.max(1, Math.ceil(span / spacingMm - SPAN_EPS));
  const step = span / gaps;
  return Array.from({ length: gaps + 1 }, (_, i) => (i === gaps ? lengthMm - insetMm : insetMm + i * step));
}

export interface GrommetLayout {
  readonly points: Point[];
  readonly warnings: string[];
}

/**
 * Grommet centres in the item-local trim frame, walking the enabled edges
 * counter-clockwise from the bottom-left corner. Shared corners appear once.
 */
export function grommetPoints(
  widthMm: number,
  heightMm: number,
  insetMm: number,
  spacingMm: number,
  edges: readonly Edge[],
): GrommetLayout {
  const warnings: string[] = [];
  if (widthMm <= 2 * insetMm || heightMm <= 2 * insetMm) {
    warnings.push(`grommet inset ${insetMm} mm leaves no room between corners on a ${widthMm} x ${heightMm} mm item`);
  }
  const along = (length: number) => distributeAlongEdge(length, insetMm, spacingMm);
  const enabled = new Set(edges);
  const points: Point[] = [];
  if (enabled.has("bottom")) points.push(...along(widthMm).map((x) => ({ x, y: insetMm })));
  if (enabled.has("right")) points.push(...along(heightMm).map((y) => ({ x: widthMm - insetMm, y })));
  if (enabled.has("top")) points.push(...along(widthMm).reverse().map((x) => ({ x, y: heightMm - insetMm })));
  if (enabled.has("left")) points.push(...along(heightMm).reverse().map((y) => ({ x: insetMm, y })));
  return { points: uniquePoints(points), warnings };
}
