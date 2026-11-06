/**
 * Tiling model (Spec 009).
 *
 * Units: millimetres. Frame: the **artwork frame**, origin at the bottom-left
 * corner of the artwork (the source page's TrimBox), x to the right, y up
 * (the PDF user-space convention, ISO 32000 §8.3.2.3).
 *
 * These types are owned by `packages/core` per Spec 009 once it exists; until
 * then they live here and core re-exports them (same approach as Spec 003's
 * local `RollMedia`).
 */

export type Mm = number;

export interface RectMm {
  x: Mm;
  y: Mm;
  width: Mm;
  height: Mm;
}

/** The artwork being tiled: its trim size. */
export interface TilePage {
  widthMm: Mm;
  heightMm: Mm;
}

/**
 * How two neighbouring panels meet (FR2).
 * - `overlap`: both neighbours print `overlapMm` past the seam.
 * - `butt`: panels meet exactly at the seam.
 * - `gap`: a `gapMm` strip centred on the seam is not printed (e.g. a frame
 *   between sections); each neighbour stops `gapMm / 2` short of the seam.
 */
export type SeamTreatment =
  | { kind: "overlap"; overlapMm?: Mm }
  | { kind: "butt" }
  | { kind: "gap"; gapMm: Mm };

/** FR1: a grid by panel count, or by maximum panel size. */
export type GridDef =
  | { mode: "count"; columns: number; rows: number }
  | { mode: "size"; maxWidthMm?: Mm; maxHeightMm?: Mm };

/** FR3: whether size limits in a `size` grid refer to the visible or printed panel. */
export type SizeAccounting = "visible" | "printed";

export type LabelStyle = "letters" | "numbers";

/** FR5: label naming. Default rows as letters, columns as numbers (`A1`, `A2`, ...). */
export interface PanelNaming {
  rows?: LabelStyle;
  cols?: LabelStyle;
  /** Placed between the row and column part. Default "" (or "-" when both parts use the same style). */
  separator?: string;
}

export interface TileSpec {
  grid: GridDef;
  /** Explicit vertical seam positions in mm from the artwork's left edge. Overrides `grid` on x. */
  seamsX?: Mm[];
  /** Explicit horizontal seam positions in mm from the artwork's bottom edge. Overrides `grid` on y. */
  seamsY?: Mm[];
  /** Default `printed`. */
  accounting?: SizeAccounting;
  /** Treatment for every seam without an individual entry. Default overlap of 25 mm. */
  seam?: SeamTreatment;
  /** Per-seam treatment, indexed like the seams on that axis (left to right). */
  seamTreatmentsX?: (SeamTreatment | null | undefined)[];
  /** Per-seam treatment, indexed like the seams on that axis (bottom to top). */
  seamTreatmentsY?: (SeamTreatment | null | undefined)[];
  /** Extra printed margin on every edge of every panel. Default 0. */
  bleedMm?: Mm;
  naming?: PanelNaming;
}

/**
 * Output limits taken from the device capability profile (ARCHITECTURE §3.8)
 * and the medium (Spec 005). Panel width runs across the medium, panel height
 * along the feed, unless `allowRotation` lets a panel turn 90°.
 */
export interface TileLimits {
  printableWidthMm?: Mm;
  maxLengthMm?: Mm;
  mediaWidthMm?: Mm;
  allowRotation?: boolean;
}

export type Side = "left" | "right" | "bottom" | "top";

/** What lies on one side of a panel: the artwork edge or a seam of some treatment. */
export type EdgeKind = "outer" | "overlap" | "butt" | "gap";

export interface Panel {
  /** Stable id `<row>-<col>` (matches Spec 006's `panel/<r>-<c>` payload); recorded by Spec 008. */
  id: string;
  /** 1-based, row 1 is the top row. */
  row: number;
  /** 1-based, column 1 is the leftmost column. */
  col: number;
  /** 1-based, row-major from the top-left panel. */
  index: number;
  label: string;
  labelParts: { row: string; col: string };
  /** The part of the artwork this panel shows after installation. */
  visible: RectMm;
  /** The part of the artwork this panel prints: visible + overlap + bleed. */
  printed: RectMm;
  edges: Record<Side, EdgeKind>;
  /** Overlap width printed past the seam on each side (0 unless the edge is `overlap`). */
  overlapMm: Record<Side, Mm>;
  /** True when the panel only fits the limits turned 90° on the medium. */
  rotate: boolean;
}

export type TileIssueCode =
  | "invalid-page"
  | "invalid-limits"
  | "invalid-grid"
  | "invalid-seam"
  | "invalid-treatment"
  | "invalid-bleed"
  | "invalid-keep-out"
  | "panel-too-small"
  | "overlap-exceeds-panel"
  | "no-grid-fits"
  | "exceeds-size-limit"
  | "exceeds-printable-width"
  | "exceeds-media-width"
  | "exceeds-max-length"
  | "invalid-panel-ref"
  | "unknown-panel"
  | "ambiguous-panel-ref";

export interface TileIssue {
  code: TileIssueCode;
  message: string;
  axis?: "x" | "y";
  seamIndex?: number;
  panelId?: string;
}

export interface TileResult {
  /** True when the grid is valid and every panel fits the limits. */
  ok: boolean;
  /** Empty when the grid itself is invalid; populated (with issues) when only limits fail. */
  panels: Panel[];
  columns: number;
  rows: number;
  seamsX: Mm[];
  seamsY: Mm[];
  issues: TileIssue[];
}
