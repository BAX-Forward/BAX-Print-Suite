/**
 * Local copies of the Spec 003 layout types and the Spec 004 registration-mark
 * types this package consumes. They mirror the published shapes so the real
 * packages can replace them (re-export or alias) once 003 and 004 merge.
 */
import type { PDFPage } from "pdf-lib";

/** Spec 003 Part A: PDF points everywhere. */
export type Rotation = 0 | 90 | 180 | 270;

export interface RollMedia {
  readonly widthPt: number;
  readonly margins: { readonly left: number; readonly right: number; readonly lead: number; readonly trail: number };
  readonly maxLengthPt?: number;
}

/**
 * A placement in the layout frame: origin at the lead-edge left corner of the
 * usable area, x across the roll, y along the feed. (xPt, yPt) is the
 * footprint's bottom-left after rotation. Rotation is counter-clockwise.
 */
export interface Placement {
  readonly itemId: string;
  /** Zero-based copy number (labels show it as copy.index = copy + 1). */
  readonly copy: number;
  readonly xPt: number;
  readonly yPt: number;
  readonly rotation: Rotation;
  readonly footprint: { readonly w: number; readonly h: number };
}

export interface Layout {
  readonly placements: readonly Placement[];
  readonly mediaWidthPt: number;
  readonly lengthUsedPt: number;
  readonly utilization: number;
  readonly unplaced: readonly { itemId: string; reason: string }[];
  readonly algorithm: string;
  readonly elapsedMs: number;
}

/** Page point = (originX + xPt · scale, originY + yPt · scale). */
export interface ImposeFrame {
  readonly originX: number;
  readonly originY: number;
  readonly scale: number;
}

/** Spec 003 Part B marks hook context. */
export interface MarksHookContext {
  readonly page: PDFPage;
  readonly layout: Pick<Layout, "placements">;
  readonly frame: ImposeFrame;
}

export type MarksHook = (ctx: MarksHookContext) => void | Promise<void>;

/** Spec 004 Part D: mark centres and diameters in the layout frame (points). */
export interface RegistrationMark {
  readonly id: string;
  readonly xPt: number;
  readonly yPt: number;
  readonly dPt: number;
}

export interface RegistrationMarks {
  readonly marks: readonly RegistrationMark[];
  readonly originMarkId: string;
}

/** Registration marks plus the 004 pattern and clearance used to build them. */
export interface RegistrationInput extends RegistrationMarks {
  readonly pattern?: "corners-4" | "corners-3" | "edges-n" | "edge-rows" | string;
  /** Default 3 mm, as in Spec 004 Part D. */
  readonly clearanceMm?: number;
}
