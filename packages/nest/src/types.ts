/** PDF points (1/72 in). Every length in this package uses this unit. */
export type Unit = number;

export interface Margins {
  left: Unit;
  right: Unit;
  lead: Unit;
  trail: Unit;
}

/**
 * Roll media (fixed width, open length). With `maxLengthPt` the roll is cut into
 * panels of at most that length; overflow continues on the next panel.
 * Local stand-in for the core `Media` type (ARCHITECTURE §4) until Spec 001 lands.
 */
export interface RollMedia {
  widthPt: Unit;
  margins: Margins;
  maxLengthPt?: Unit;
}

/** Quarter-turn rotation, counter-clockwise (PDF convention). */
export type Rotation = 0 | 90 | 180 | 270;

export interface Point {
  x: Unit;
  y: Unit;
}

/** Closed polygon ring (phase 2 true-shape nesting). */
export type Polygon = Point[];

export type RotationPolicy = "none" | "90" | "any";
export type GrainLock = "along-roll" | "across-roll";

export interface NestItem {
  id: string;
  jobId?: string;
  pageIndex?: number;
  /** Trim size (or bleed box, see bleedPt). */
  widthPt: Unit;
  heightPt: Unit;
  /** Extra on each side, included in the footprint. */
  bleedPt?: Unit;
  /** Expanded into copies. */
  quantity: number;
  /** Allowed set: none={0}, 90={0,90}, any={0,90,180,270}. */
  rotation: RotationPolicy;
  /** Locks override `rotation`; `orientation` overrides `grain`. */
  lock?: { grain?: GrainLock; orientation?: Rotation };
  /** Keep same-group items adjacent (best effort). */
  group?: string;
  /** Phase 2 true-shape (outer + holes); ignored by rectangle nesters. */
  shape?: Polygon[];
}

export type Algorithm = "maxrects" | "skyline" | "auto";
export type MaxRectsHeuristic = "bssf" | "blsf" | "baf" | "bl";
export type SkylineHeuristic = "bl" | "mwf";
export type SortOrder =
  | "area-desc"
  | "height-desc"
  | "width-desc"
  | "perimeter-desc"
  | "maxside-desc"
  | "input";

export interface NestOptions {
  gutterPt: Unit;
  algorithm: Algorithm;
  /** maxrects: bssf | blsf | baf | bl. skyline: bl | mwf. Unknown names fall back to the default. */
  heuristic?: string;
  sort?: SortOrder;
  seed?: number;
  /** `auto` only. Default 500 ms. */
  timeBudgetMs?: number;
  /** `auto` only. Cap on local-search iterations (keeps results machine-independent). */
  maxIterations?: number;
}

export interface Footprint {
  w: Unit;
  h: Unit;
}

export interface Placement {
  itemId: string;
  copy: number;
  /** Bottom-left of the footprint after rotation, in the usable-area frame. */
  xPt: Unit;
  yPt: Unit;
  rotation: Rotation;
  footprint: Footprint;
  /** Index into `Layout.panels`. */
  panel: number;
}

export type UnplacedReason = "too-wide" | "max-length" | "locked-orientation" | "invalid-size";

export interface Unplaced {
  itemId: string;
  reason: UnplacedReason;
  copies: number;
}

/** A roll segment. Panels are laid end to end along y. */
export interface Panel {
  index: number;
  offsetPt: Unit;
  lengthPt: Unit;
}

export interface Layout {
  placements: Placement[];
  mediaWidthPt: Unit;
  lengthUsedPt: Unit;
  /** sum(footprint areas incl. bleed) / (usable width × lengthUsed), 0..1. */
  utilization: number;
  unplaced: Unplaced[];
  algorithm: string;
  elapsedMs: number;
  media: RollMedia;
  panels: Panel[];
}

export interface Nester {
  readonly id: string;
  readonly supportsShapes: boolean;
  nest(media: RollMedia, items: readonly NestItem[], opts: NestOptions): Layout;
}
