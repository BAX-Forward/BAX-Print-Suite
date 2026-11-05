import type { CropEdit, JobEdit, ScaleEdit, SpotTarget } from "@bax-print/core";
import {
  determinant,
  invert,
  mmToPt,
  multiply,
  ptToMm,
  scale as scaleMatrix,
  transformRect,
  translate,
  type Matrix,
  type Rect,
} from "./transform.js";

export type QuarterTurn = 0 | 90 | 180 | 270;
export type BleedMode = "edge" | "mirror";

/** The page region a job prints from: TrimBox, else MediaBox (Spec 007 FR2), in PDF user space. */
export interface PageSource {
  box: Rect;
  /** Page `/Rotate`, clockwise degrees. */
  rotate?: number;
  /** Page `/UserUnit` (ISO 32000-1 §14.11.1); default 1. */
  userUnit?: number;
}

export interface SpotMapping {
  from: string;
  target: SpotTarget;
}

/**
 * Result of folding an edit stack over a page. Two frames are defined, both in points, y up:
 * - the **trim frame**: origin at the bottom-left of the finished (trimmed) artwork;
 * - the **footprint frame**: the output page/item, i.e. trim plus bleed, or the `pageSize` override.
 */
export interface EditedGeometry {
  trimWidthPt: number;
  trimHeightPt: number;
  /** Source user space → trim frame. */
  toTrim: Matrix;
  bleedPt: number;
  bleedMode: BleedMode | null;
  footprintWidthPt: number;
  footprintHeightPt: number;
  pageSizeOverride: boolean;
  /** Trim frame origin inside the footprint frame. */
  trimOriginX: number;
  trimOriginY: number;
  /** Source user space → footprint frame. This is what layout draws with and preview renders with. */
  toFootprint: Matrix;
  /** Source user-space region that ends up inside the trim. */
  visibleSource: Rect;
  /** Uniform scale applied by the edits alone (1 = unscaled; excludes UserUnit). */
  scaleFactor: number;
  /** Net transform summary: optional horizontal flip first, then this clockwise rotation (includes page `/Rotate`). */
  rotation: QuarterTurn;
  mirrored: boolean;
  quantity?: number;
  spotMappings: SpotMapping[];
  metadata: Record<string, string>;
}

export class EditError extends Error {
  readonly editIndex: number;
  readonly editId?: string;

  constructor(message: string, editIndex: number, editId?: string) {
    super(message);
    this.name = "EditError";
    this.editIndex = editIndex;
    this.editId = editId;
  }
}

interface Frame {
  widthPt: number;
  heightPt: number;
  matrix: Matrix;
  rotation: QuarterTurn;
  mirrored: boolean;
}

const TOLERANCE_PT = 1e-6;

export function normalizeQuarterTurn(degrees: number): QuarterTurn {
  return ((((Math.round(degrees / 90) * 90) % 360) + 360) % 360) as QuarterTurn;
}

function addTurns(a: QuarterTurn, b: QuarterTurn): QuarterTurn {
  return normalizeQuarterTurn(a + b);
}

/** Clockwise rotation of the frame, keeping its bottom-left corner at the origin. */
function rotateFrame(frame: Frame, turn: QuarterTurn): Frame {
  const w = frame.widthPt;
  const h = frame.heightPt;
  const rotation = addTurns(frame.rotation, turn);
  switch (turn) {
    case 0:
      return frame;
    case 90:
      return { ...frame, widthPt: h, heightPt: w, rotation, matrix: multiply(frame.matrix, [0, -1, 1, 0, 0, w]) };
    case 180:
      return { ...frame, rotation, matrix: multiply(frame.matrix, [-1, 0, 0, -1, w, h]) };
    case 270:
      return { ...frame, widthPt: h, heightPt: w, rotation, matrix: multiply(frame.matrix, [0, 1, -1, 0, h, 0]) };
  }
}

function mirrorFrame(frame: Frame, axis: "horizontal" | "vertical"): Frame {
  const flip: Matrix = axis === "horizontal" ? [-1, 0, 0, 1, frame.widthPt, 0] : [1, 0, 0, -1, 0, frame.heightPt];
  // `mirrored`/`rotation` describe the net transform as "horizontal flip first, then rotate".
  // Flipping after a rotation r equals flipping first and rotating by -r; a vertical flip is a
  // horizontal flip followed by a half turn.
  const negated = normalizeQuarterTurn(-frame.rotation);
  const rotation = axis === "horizontal" ? negated : addTurns(negated, 180);
  return { ...frame, matrix: multiply(frame.matrix, flip), mirrored: !frame.mirrored, rotation };
}

function scaleFrame(frame: Frame, factor: number): Frame {
  return {
    ...frame,
    widthPt: frame.widthPt * factor,
    heightPt: frame.heightPt * factor,
    matrix: multiply(frame.matrix, scaleMatrix(factor)),
  };
}

function scaleFactorOf(edit: ScaleEdit, frame: Frame, index: number): number {
  if (edit.fit) {
    const current = edit.fit.dimension === "width" ? frame.widthPt : frame.heightPt;
    return mmToPt(edit.fit.targetMm) / current;
  }
  if (edit.percent !== undefined && edit.percent > 0) return edit.percent / 100;
  throw new EditError("scale needs a positive percent or a fit target", index, edit.id);
}

function cropFrame(frame: Frame, edit: CropEdit, index: number): Frame {
  const x = mmToPt(edit.box.xMm);
  const y = mmToPt(edit.box.yMm);
  const w = mmToPt(edit.box.widthMm);
  const h = mmToPt(edit.box.heightMm);
  if (x + w > frame.widthPt + TOLERANCE_PT || y + h > frame.heightPt + TOLERANCE_PT) {
    const size = `${ptToMm(frame.widthPt).toFixed(2)} × ${ptToMm(frame.heightPt).toFixed(2)} mm`;
    throw new EditError(`crop box extends past the current artwork (${size})`, index, edit.id);
  }
  return { ...frame, widthPt: w, heightPt: h, matrix: multiply(frame.matrix, translate(-x, -y)) };
}

/** Folds the edit list over a page, in order. Throws `EditError` for an edit that can't apply. */
export function computeGeometry(source: PageSource, edits: readonly JobEdit[] = []): EditedGeometry {
  const unit = source.userUnit !== undefined && source.userUnit > 0 ? source.userUnit : 1;
  const { box } = source;
  const initial: Frame = {
    widthPt: (box.x1 - box.x0) * unit,
    heightPt: (box.y1 - box.y0) * unit,
    matrix: multiply(translate(-box.x0, -box.y0), scaleMatrix(unit)),
    rotation: 0,
    mirrored: false,
  };
  if (!(initial.widthPt > 0 && initial.heightPt > 0)) throw new EditError("page box has no area", -1);

  let frame = rotateFrame(initial, normalizeQuarterTurn(source.rotate ?? 0));
  let bleedPt = 0;
  let bleedMode: BleedMode | null = null;
  let pageSize: { widthPt: number; heightPt: number } | null = null;
  let quantity: number | undefined;
  const spotMappings: SpotMapping[] = [];
  const metadata: Record<string, string> = {};

  for (const [index, edit] of edits.entries()) {
    switch (edit.kind) {
      case "scale":
        frame = scaleFrame(frame, scaleFactorOf(edit, frame, index));
        break;
      case "rotate":
        frame = rotateFrame(frame, normalizeQuarterTurn(edit.degrees));
        break;
      case "mirror":
        frame = mirrorFrame(frame, edit.axis ?? "horizontal");
        break;
      case "crop":
        frame = cropFrame(frame, edit, index);
        break;
      case "addBleed":
        bleedPt = mmToPt(edit.mm);
        bleedMode = edit.mm > 0 ? edit.mode : null;
        break;
      case "pageSize":
        pageSize = { widthPt: mmToPt(edit.widthMm), heightPt: mmToPt(edit.heightMm) };
        break;
      case "copies":
        quantity = edit.count;
        break;
      case "spotMap":
        spotMappings.push({ from: edit.from, target: edit.to });
        break;
      case "cutContour":
        // No effect on geometry; see `resolveCutContour`.
        break;
      case "metadata":
        Object.assign(metadata, edit.values);
        break;
    }
  }

  const trimWidthPt = frame.widthPt;
  const trimHeightPt = frame.heightPt;
  const footprintWidthPt = pageSize ? pageSize.widthPt : trimWidthPt + 2 * bleedPt;
  const footprintHeightPt = pageSize ? pageSize.heightPt : trimHeightPt + 2 * bleedPt;
  const trimOriginX = pageSize ? (footprintWidthPt - trimWidthPt) / 2 : bleedPt;
  const trimOriginY = pageSize ? (footprintHeightPt - trimHeightPt) / 2 : bleedPt;

  return {
    trimWidthPt,
    trimHeightPt,
    toTrim: frame.matrix,
    bleedPt,
    bleedMode,
    footprintWidthPt,
    footprintHeightPt,
    pageSizeOverride: pageSize !== null,
    trimOriginX,
    trimOriginY,
    toFootprint: multiply(frame.matrix, translate(trimOriginX, trimOriginY)),
    visibleSource: transformRect(invert(frame.matrix), { x0: 0, y0: 0, x1: trimWidthPt, y1: trimHeightPt }),
    scaleFactor: Math.sqrt(Math.abs(determinant(frame.matrix))) / unit,
    rotation: frame.rotation,
    mirrored: frame.mirrored,
    quantity,
    spotMappings,
    metadata,
  };
}

/** Spot mappings of an edit list, in order. Page-independent. */
export function spotMappingsOf(edits: readonly JobEdit[]): SpotMapping[] {
  return edits.flatMap((edit) => (edit.kind === "spotMap" ? [{ from: edit.from, target: edit.to }] : []));
}

/** Applies spot mappings in order: a later mapping sees the result of earlier ones. */
export function mapColorant(mappings: readonly SpotMapping[], name: string): SpotTarget {
  let current: SpotTarget = { kind: "colorant", name };
  for (const mapping of mappings) {
    if (current.kind === "colorant" && current.name === mapping.from) current = mapping.target;
  }
  return current;
}

/** Geometric validation of an edit list against each page. Returns human-readable errors. */
export function geometryErrors(sources: readonly PageSource[], edits: readonly JobEdit[]): string[] {
  const errors: string[] = [];
  sources.forEach((source, page) => {
    try {
      computeGeometry(source, edits);
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      const where = error.editIndex >= 0 ? `edits[${error.editIndex}]` : "page";
      errors.push(`page ${page + 1}, ${where}: ${error.message}`);
    }
  });
  return errors;
}
