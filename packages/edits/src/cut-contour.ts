import type { CutContourEdit, CutContourSource, JobEdit } from "@bax-print/core";
import { EditError, computeGeometry, mapColorant, spotMappingsOf, type PageSource } from "./geometry.js";
import { mmToPt, ptToMm, rectHeight, rectWidth, transformRect, type Rect } from "./transform.js";

/** A page's boxes in PDF user space (ISO 32000-1 §14.11.2), with its `/Rotate` and `/UserUnit`. */
export interface PageBoxes {
  mediaBox: Rect;
  cropBox?: Rect;
  trimBox?: Rect;
  rotate?: number;
  userUnit?: number;
}

/**
 * The cut source chosen by a job's edits, independent of the page. Spot names are the
 * colorant names after every `spotMap` edit that follows the `cutContour` edit; names mapped
 * to process are dropped.
 */
export type CutSource = CutContourSource;

/**
 * The effective cut contour of one page. A `rect` is in the trim frame of the edited page
 * (points, origin at the bottom-left of the finished artwork, y up), the frame Spec 004
 * contours and `NestItem.shape` use.
 */
export type ResolvedCutContour =
  | { kind: "spot"; names: string[] }
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | { kind: "none" };

const TOLERANCE_PT = 1e-6;

/** The page source the edit geometry folds over: TrimBox, else MediaBox (Spec 007 FR2). */
export function pageSourceOfBoxes(boxes: PageBoxes): PageSource {
  return { box: boxes.trimBox ?? boxes.mediaBox, rotate: boxes.rotate, userUnit: boxes.userUnit };
}

function lastCutContourEdit(edits: readonly JobEdit[]): { edit: CutContourEdit; index: number } | undefined {
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index];
    if (edit !== undefined && edit.kind === "cutContour") return { edit, index };
  }
  return undefined;
}

function mappedSpotNames(names: readonly string[], later: readonly JobEdit[]): string[] {
  const mappings = spotMappingsOf(later);
  const mapped = names.flatMap((name) => {
    const target = mapColorant(mappings, name);
    return target.kind === "colorant" ? [target.name] : [];
  });
  return [...new Set(mapped)];
}

/** The cut source of the last `cutContour` edit, with spot names renamed by later `spotMap` edits. `undefined` without one. */
export function resolveCutSource(edits: readonly JobEdit[]): CutSource | undefined {
  const last = lastCutContourEdit(edits);
  if (!last) return undefined;
  const { source } = last.edit;
  return source.kind === "spot" ? { kind: "spot", names: mappedSpotNames(source.names, edits.slice(last.index + 1)) } : source;
}

function clipToTrim(box: Rect, widthPt: number, heightPt: number): Rect {
  return { x0: Math.max(box.x0, 0), y0: Math.max(box.y0, 0), x1: Math.min(box.x1, widthPt), y1: Math.min(box.y1, heightPt) };
}

/**
 * Resolves a page's effective cut contour after the whole edit stack (Spec 007e). A `trimBox`
 * source takes the page TrimBox (else CropBox, else MediaBox, as Spec 004 contours do), carries
 * it through the scale/rotate/mirror/crop edits, clips it to the edited artwork and offsets it
 * outward (+) or inward (-) by `offsetMm` at final size. Returns `undefined` when no edit sets
 * the cut contour, so the job's configured cut settings apply. Throws `EditError` when the
 * geometry can't apply or the rectangle has no area.
 */
export function resolveCutContour(edits: readonly JobEdit[], pageBoxes: PageBoxes): ResolvedCutContour | undefined {
  const last = lastCutContourEdit(edits);
  const source = resolveCutSource(edits);
  if (!last || !source) return undefined;
  if (source.kind !== "trimBox") return source;

  const g = computeGeometry(pageSourceOfBoxes(pageBoxes), edits);
  const cutBox = pageBoxes.trimBox ?? pageBoxes.cropBox ?? pageBoxes.mediaBox;
  const clipped = clipToTrim(transformRect(g.toTrim, cutBox), g.trimWidthPt, g.trimHeightPt);
  if (!(rectWidth(clipped) > TOLERANCE_PT && rectHeight(clipped) > TOLERANCE_PT)) {
    throw new EditError("cut box lies outside the edited artwork", last.index, last.edit.id);
  }
  const offset = mmToPt(source.offsetMm);
  const width = rectWidth(clipped) + 2 * offset;
  const height = rectHeight(clipped) + 2 * offset;
  if (!(width > TOLERANCE_PT && height > TOLERANCE_PT)) {
    const size = `${ptToMm(rectWidth(clipped)).toFixed(2)} × ${ptToMm(rectHeight(clipped)).toFixed(2)} mm`;
    throw new EditError(`inward offset of ${-source.offsetMm} mm leaves no cut area on the ${size} cut box`, last.index, last.edit.id);
  }
  return { kind: "rect", x: clipped.x0 - offset, y: clipped.y0 - offset, width, height };
}
