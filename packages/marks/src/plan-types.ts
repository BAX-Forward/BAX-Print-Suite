/**
 * The finishing plan: every mark and label resolved to geometry in the layout
 * frame (millimetres, Spec 003 frame: x across the roll, y along the feed,
 * origin at the lead-edge left corner of the usable area).
 */
import type { CodeMatrix, PanelRef, Symbology } from "./codes/index.js";
import type { Matrix, Point, Segment } from "./geometry.js";
import type { Rotation } from "./layout-types.js";
import type { Colorant, Edge, MarkKind } from "./schema.js";
import type { SymbolTable } from "./symbols.js";

export interface LinesPart {
  readonly type: "lines";
  readonly segments: readonly Segment[];
  readonly lineWidthMm: number;
  /** [on, off] in mm; solid when absent. */
  readonly dashMm?: readonly [number, number];
}

export interface DotsPart {
  readonly type: "dots";
  readonly centers: readonly Point[];
  readonly diameterMm: number;
  readonly style: "dot" | "crosshair";
  readonly lineWidthMm: number;
}

export interface SymbolInstance {
  readonly center: Point;
  /** Counter-clockwise rotation of the symbol (follows the artwork). */
  readonly rotation: Rotation;
}

export interface SymbolsPart {
  readonly type: "symbols";
  readonly symbolId: string;
  /** Unrotated symbol size. */
  readonly widthMm: number;
  readonly heightMm: number;
  readonly instances: readonly SymbolInstance[];
}

export interface LabelCode {
  readonly symbology: Symbology;
  readonly payload: string;
  /** Modules per side, without the quiet zone. */
  readonly size: number;
  readonly moduleMm: number;
  readonly quietZoneModules: number;
  readonly modules: CodeMatrix["modules"];
  /** Bottom-left of the quiet zone in the label frame. */
  readonly origin: Point;
  /** Side including the quiet zone. */
  readonly sideMm: number;
}

/**
 * A label in its own frame (u along the edge, v away from it, origin at the
 * bottom-left), placed by `matrix` (label frame → layout or item frame).
 */
export interface LabelPart {
  readonly type: "label";
  readonly edge: Edge;
  readonly matrix: Matrix;
  readonly widthMm: number;
  readonly heightMm: number;
  /** Rendered template text, before font normalization. */
  readonly text: string;
  /** Lines as drawn by the label font. */
  readonly lines: readonly string[];
  readonly fontSizePt: number;
  /** Bottom-left of the text block in the label frame. */
  readonly textOrigin: Point;
  readonly code?: LabelCode;
}

export type MarkPart = LinesPart | DotsPart | SymbolsPart | LabelPart;

export type ElementKind = MarkKind | "label";

export interface PlannedElement {
  /** `<itemId>#<copy>/<markId>`. */
  readonly id: string;
  readonly itemId: string;
  /** Zero-based copy number of the placement. */
  readonly copy: number;
  readonly markId: string;
  readonly kind: ElementKind;
  readonly parts: readonly MarkPart[];
}

export interface FinishingPlan {
  readonly version: 1;
  readonly colorant: Colorant;
  readonly elements: readonly PlannedElement[];
  readonly symbols: SymbolTable;
  readonly warnings: readonly string[];
}

/** The item a placement shows: trim size and bleed in mm. */
export interface ItemInfo {
  readonly itemId: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly bleedMm?: number;
  /** `copy.total` on the label; defaults to the number of placements of this item. */
  readonly copies?: number;
  /** Spec 009 panel position, shown as `panel.row` / `panel.col` and in the code payload. */
  readonly panel?: PanelRef;
}

/** Job ticket fields the label template and code payload read. */
export interface JobInfo {
  readonly id: string;
  readonly name?: string;
  readonly customer?: string;
  readonly mediaName?: string;
  readonly deviceName?: string;
  /** ISO 8601 date; defaults to today (pass it for reproducible output). */
  readonly date?: string;
  /** Job ticket metadata for `meta.<key>`. */
  readonly meta?: Readonly<Record<string, string | number>>;
}
