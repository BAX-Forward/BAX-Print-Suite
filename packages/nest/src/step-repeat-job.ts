import { PDFDocument } from "pdf-lib";
import {
  artSize,
  impose,
  pagePanels,
  panelFrame,
  placementMatrix,
  type Frame,
  type ImposeSource,
  type ImposeWarning,
  type SourceBox,
} from "./impose.js";
import { stepAndRepeat, type StepRepeatRotation } from "./step-repeat.js";
import type { Layout, Margins, Placement } from "./types.js";
import { POINTS_PER } from "./units.js";

/** A point in PDF points, `[x, y]`, y up. */
export type CutPoint = [number, number];

export interface CutBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * A flattened cut contour, structurally the same as the plugin SDK `Contour`
 * (spec 004 Part A) so this package stays free of imports from other packages.
 */
export interface Contour {
  id: string;
  tool: string;
  source: { kind: "spot" | "layer"; name: string };
  closed: boolean;
  /** Points in pt, relative to the imposed page's bottom-left, y up. */
  points: CutPoint[];
  bbox: CutBBox;
  areaSigned: number;
}

export interface StepRepeatJobOptions {
  sourcePdf: Uint8Array;
  /** Default 0. */
  pageIndex?: number;
  /** Page box that sets the item size. Contours always follow the trim box. */
  sourceBox: SourceBox;
  copies: number;
  rollWidthMm: number;
  /** Millimetres, not points. */
  marginsMm: Margins;
  gapXMm: number;
  gapYMm: number;
  rotate?: StepRepeatRotation;
  /** Semantic tool on every contour. Default "kiss". */
  cutTool?: string;
}

export interface StepRepeatJob {
  layout: Layout;
  imposedPdf: Uint8Array;
  /** One closed trim rectangle per copy, in `layout.placements` order. */
  cutContours: Contour[];
  /** Warnings from the impose step. */
  warnings: ImposeWarning[];
}

export const STEP_REPEAT_ITEM_ID = "art";
export const STEP_REPEAT_CUT_SOURCE_NAME = "trim";
const DEFAULT_CUT_TOOL = "kiss";

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface SourceBoxes {
  /** The box that sets the item size (trim or bleed). */
  readonly art: Rect;
  readonly trim: Rect;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readSourceBoxes(bytes: Uint8Array, pageIndex: number, kind: SourceBox): Promise<SourceBoxes> {
  if (bytes.length === 0) throw new Error("stepAndRepeatJob: source PDF is empty");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    throw new Error(`stepAndRepeatJob: cannot read source PDF (${errorMessage(error)})`);
  }
  const count = doc.getPageCount();
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= count) {
    throw new RangeError(`stepAndRepeatJob: source PDF has no page index ${pageIndex} (${count} pages)`);
  }
  const page = doc.getPage(pageIndex);
  const trim = page.getTrimBox();
  return { art: kind === "bleed" ? page.getBleedBox() : trim, trim };
}

/**
 * The trim box in art space. impose centers the footprint on the source box, so
 * art space starts at the box center minus half the footprint.
 */
function trimInArt(boxes: SourceBoxes, placement: Placement): Rect {
  const size = artSize(placement);
  const originX = boxes.art.x + boxes.art.width / 2 - size.w / 2;
  const originY = boxes.art.y + boxes.art.height / 2 - size.h / 2;
  const { trim } = boxes;
  return { x: trim.x - originX, y: trim.y - originY, width: trim.width, height: trim.height };
}

/** Maps an art-space rectangle onto the page and returns it as a counter-clockwise ring from the bottom-left. */
function trimContour(placement: Placement, frame: Frame, rect: Rect, tool: string): Contour {
  const [a, b, c, d, e, f] = placementMatrix(placement, frame);
  const corners: readonly (readonly [number, number])[] = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ];
  const xs = corners.map(([u, v]) => a * u + c * v + e);
  const ys = corners.map(([u, v]) => b * u + d * v + f);
  const bbox = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  return {
    id: `copy-${placement.copy}`,
    tool,
    source: { kind: "layer", name: STEP_REPEAT_CUT_SOURCE_NAME },
    closed: true,
    points: [
      [bbox.minX, bbox.minY],
      [bbox.maxX, bbox.minY],
      [bbox.maxX, bbox.maxY],
      [bbox.minX, bbox.maxY],
    ],
    bbox,
    areaSigned: (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY),
  };
}

function cutContours(layout: Layout, boxes: SourceBoxes, tool: string): Contour[] {
  const frames = new Map(pagePanels(layout).map((panel) => [panel.index, panelFrame(layout, panel)]));
  return layout.placements.map((placement) => {
    const frame = frames.get(placement.panel);
    if (!frame) throw new RangeError(`stepAndRepeatJob: placement ${placement.copy} has no panel ${placement.panel}`);
    return trimContour(placement, frame, trimInArt(boxes, placement), tool);
  });
}

/**
 * Step and repeat of one PDF page on roll media: the grid layout, the imposed
 * PDF (one page per panel) and one trim cut contour per copy in the imposed
 * page's coordinates. Throws for an unreadable source PDF, a missing page or
 * options that `stepAndRepeat` rejects.
 */
export async function stepAndRepeatJob(opts: StepRepeatJobOptions): Promise<StepRepeatJob> {
  const pageIndex = opts.pageIndex ?? 0;
  const boxes = await readSourceBoxes(opts.sourcePdf, pageIndex, opts.sourceBox);
  const layout = stepAndRepeat({
    item: {
      id: STEP_REPEAT_ITEM_ID,
      widthMm: boxes.art.width / POINTS_PER.mm,
      heightMm: boxes.art.height / POINTS_PER.mm,
    },
    copies: opts.copies,
    rollWidthMm: opts.rollWidthMm,
    marginsMm: opts.marginsMm,
    gapXMm: opts.gapXMm,
    gapYMm: opts.gapYMm,
    ...(opts.rotate === undefined ? {} : { rotate: opts.rotate }),
  });
  const source: ImposeSource = { pdfBytes: opts.sourcePdf, pageIndex, box: opts.sourceBox };
  const warnings: ImposeWarning[] = [];
  const imposedPdf = await impose(layout, new Map([[STEP_REPEAT_ITEM_ID, source]]), {
    onWarning: (warning) => {
      warnings.push(warning);
    },
  });
  return { layout, imposedPdf, cutContours: cutContours(layout, boxes, opts.cutTool ?? DEFAULT_CUT_TOOL), warnings };
}
