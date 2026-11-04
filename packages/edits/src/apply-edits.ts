import type { JobEdit } from "@bax-print/core";
import { computeGeometry, type QuarterTurn } from "./geometry.js";
import { applyToPoint } from "./transform.js";

/** Same shape as the Spec 003 `Point` / `Polygon` (packages/nest/src/types.ts). */
export interface Point {
  x: number;
  y: number;
}
export type Polygon = Point[];

/**
 * Structural copy of the Spec 003 `NestItem` (packages/nest/src/types.ts), so this package
 * does not depend on the nester. A nest item is assignable to it and `applyEdits` returns
 * the caller's own type; it only reads and writes these fields.
 */
export interface NestItem {
  id: string;
  jobId?: string;
  pageIndex?: number;
  /** Trim size in points. */
  widthPt: number;
  heightPt: number;
  bleedPt?: number;
  quantity: number;
  rotation: "none" | "90" | "any";
  lock?: { grain?: "along-roll" | "across-roll"; orientation?: QuarterTurn };
  group?: string;
  /** Outer contour plus holes, in the item's trim frame. */
  shape?: Polygon[];
}

/**
 * Applies a job's edit stack to a nest item before nesting (Spec 007, consumed by Spec 003).
 * The item's footprint becomes the edited trim size plus bleed, or the `pageSize` override.
 */
export function applyEdits<T extends NestItem>(item: T, edits: readonly JobEdit[]): T {
  if (edits.length === 0) return item;
  const g = computeGeometry({ box: { x0: 0, y0: 0, x1: item.widthPt, y1: item.heightPt } }, edits);
  const shape = item.shape?.map((polygon) =>
    polygon.map(({ x, y }): Point => {
      const [tx, ty] = applyToPoint(g.toTrim, x, y);
      return { x: tx, y: ty };
    }),
  );
  const quantity = g.quantity ?? item.quantity;
  if (g.pageSizeOverride) {
    return { ...item, widthPt: g.footprintWidthPt, heightPt: g.footprintHeightPt, bleedPt: 0, quantity, shape };
  }
  const bleedPt = g.bleedMode !== null ? g.bleedPt : item.bleedPt === undefined ? undefined : item.bleedPt * g.scaleFactor;
  return { ...item, widthPt: g.trimWidthPt, heightPt: g.trimHeightPt, bleedPt, quantity, shape };
}
