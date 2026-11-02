import type { Piece, Problem } from "./prepare.js";
import type { StripResult } from "./strip.js";
import type { Layout, Placement, Unplaced } from "./types.js";

/** Converts a packing result into the public Layout (placements in input order). */
export function buildLayout(
  problem: Problem,
  result: StripResult,
  algorithm: string,
  elapsedMs: number,
): Layout {
  const placements: Placement[] = [...result.placed]
    .sort((a, b) => a.piece.key - b.piece.key)
    .map((p) => ({
      itemId: p.piece.itemId,
      copy: p.piece.copy,
      xPt: p.x,
      yPt: p.y,
      rotation: p.orientation.rotation,
      footprint: { w: p.orientation.w, h: p.orientation.h },
      panel: p.panel,
    }));
  const usedArea = result.placed.reduce((sum, p) => sum + p.piece.area, 0);
  const available = problem.usableWidth * result.lengthUsed;
  return {
    placements,
    mediaWidthPt: problem.media.widthPt,
    lengthUsedPt: result.lengthUsed,
    utilization: available > 0 ? usedArea / available : 0,
    unplaced: [...problem.unplaced, ...overflowUnplaced(result.overflow)],
    algorithm,
    elapsedMs,
    media: problem.media,
    panels: [...result.panels],
  };
}

function overflowUnplaced(overflow: readonly Piece[]): Unplaced[] {
  const counts = new Map<string, number>();
  for (const piece of overflow) counts.set(piece.itemId, (counts.get(piece.itemId) ?? 0) + 1);
  return [...counts].map(([itemId, copies]): Unplaced => ({ itemId, reason: "max-length", copies }));
}

export interface LayoutJsonOptions {
  /** Include `elapsedMs` (default false, so equal inputs give byte-identical JSON). */
  timing?: boolean;
  space?: number;
}

/** Canonical layout JSON. Without timing it is byte-identical for the same input and seed. */
export function layoutToJson(layout: Layout, opts: LayoutJsonOptions = {}): string {
  const value = opts.timing === true ? layout : { ...layout, elapsedMs: undefined };
  return JSON.stringify(value, null, opts.space);
}
