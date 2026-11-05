import type { JobEdit } from "@bax-print/core";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  clip,
  concatTransformationMatrix,
  drawObject,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  type PDFContext,
  type PDFObject,
  type PDFOperator,
  type PDFPage,
} from "pdf-lib";
import { computeGeometry, selectedPages, type EditedGeometry, type PageSource } from "./geometry.js";
import { multiply, normalizeRect, snapMatrix, type Matrix, type Rect } from "./transform.js";

/**
 * Draws one edited page as a single output page with pdf-lib. This is the per-job layout
 * path; nesting (Spec 003) draws each placement with the same `toFootprint` matrix.
 *
 * The source page is embedded as a Form XObject, so vector content, spot colours and
 * transparency groups are carried as-is; nothing is rasterized.
 */

/** Width of the artwork edge strip stretched outward by `addBleed` in `edge` mode. */
export const EDGE_SAMPLE_PT = 0.5;

function resolve(context: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  return obj instanceof PDFRef ? context.lookup(obj) : obj;
}

function rectFromArray(context: PDFContext, obj: PDFObject | undefined): Rect | undefined {
  const arr = resolve(context, obj);
  if (!(arr instanceof PDFArray) || arr.size() !== 4) return undefined;
  const values = arr.asArray().map((v) => resolve(context, v));
  if (!values.every((v): v is PDFNumber => v instanceof PDFNumber)) return undefined;
  const [x0, y0, x1, y1] = values.map((v) => v.asNumber()) as [number, number, number, number];
  return normalizeRect(x0, y0, x1, y1);
}

export function mediaBoxOf(page: PDFPage): Rect {
  const { width, height } = page.getSize();
  return rectFromArray(page.doc.context, page.node.MediaBox()) ?? { x0: 0, y0: 0, x1: width, y1: height };
}

/** TrimBox, else MediaBox: the same rule preflight uses (Spec 007 FR2). */
export function pageSourceOf(page: PDFPage): PageSource {
  const context = page.doc.context;
  const trim = rectFromArray(context, page.node.get(PDFName.of("TrimBox")));
  const userUnit = resolve(context, page.node.get(PDFName.of("UserUnit")));
  return {
    box: trim ?? mediaBoxOf(page),
    rotate: page.getRotation().angle,
    userUnit: userUnit instanceof PDFNumber ? userUnit.asNumber() : 1,
  };
}

function drawRegion(region: Rect, matrix: Matrix, xObject: PDFName): PDFOperator[] {
  const [a, b, c, d, e, f] = snapMatrix(matrix);
  return [
    pushGraphicsState(),
    rectangle(region.x0, region.y0, region.x1 - region.x0, region.y1 - region.y0),
    clip(),
    endPath(),
    concatTransformationMatrix(a, b, c, d, e, f),
    drawObject(xObject),
    popGraphicsState(),
  ];
}

/** Reflects x about `axis` and stretches by `k` (k = 1 is a plain mirror). */
const reflectX = (axis: number, k: number): Matrix => [-k, 0, 0, 1, axis * (1 + k), 0];
const reflectY = (axis: number, k: number): Matrix => [1, 0, 0, -k, 0, axis * (1 + k)];

/** The trim area plus up to eight bleed regions, each with the matrix that fills it. */
export function bleedRegions(g: EditedGeometry): { region: Rect; matrix: Matrix }[] {
  const left = g.trimOriginX;
  const bottom = g.trimOriginY;
  const right = left + g.trimWidthPt;
  const top = bottom + g.trimHeightPt;
  const trim: Rect = { x0: left, y0: bottom, x1: right, y1: top };
  const regions = [{ region: trim, matrix: g.toFootprint }];
  if (g.bleedMode === null || g.bleedPt <= 0) return regions;

  const b = g.bleedPt;
  const kx = g.bleedMode === "mirror" ? 1 : b / Math.min(EDGE_SAMPLE_PT, g.trimWidthPt / 2);
  const ky = g.bleedMode === "mirror" ? 1 : b / Math.min(EDGE_SAMPLE_PT, g.trimHeightPt / 2);
  const columns = [
    { x0: left - b, x1: left, m: reflectX(left, kx) },
    { x0: left, x1: right, m: null },
    { x0: right, x1: right + b, m: reflectX(right, kx) },
  ];
  const rows = [
    { y0: bottom - b, y1: bottom, m: reflectY(bottom, ky) },
    { y0: bottom, y1: top, m: null },
    { y0: top, y1: top + b, m: reflectY(top, ky) },
  ];
  for (const col of columns) {
    for (const row of rows) {
      if (!col.m && !row.m) continue;
      let matrix = g.toFootprint;
      if (col.m) matrix = multiply(matrix, col.m);
      if (row.m) matrix = multiply(matrix, row.m);
      regions.push({ region: { x0: col.x0, y0: row.y0, x1: col.x1, y1: row.y1 }, matrix });
    }
  }
  return regions;
}

export interface ImposeResult {
  pdf: Uint8Array;
  geometry: EditedGeometry;
}

export interface ImposePagesResult {
  pdf: Uint8Array;
  /** 0-based source page index of each output page, in output order. */
  pageIndices: number[];
  /** Edited geometry of each output page, in output order. */
  geometries: EditedGeometry[];
}

/** Appends one edited source page to `out` and returns its geometry. */
async function addEditedPage(out: PDFDocument, sourcePage: PDFPage, edits: readonly JobEdit[]): Promise<EditedGeometry> {
  const geometry = computeGeometry(pageSourceOf(sourcePage), edits);
  const page = out.addPage([geometry.footprintWidthPt, geometry.footprintHeightPt]);
  // Contents is optional (ISO 32000-1, 7.7.3.3): a page without it is blank, and pdf-lib can't embed it.
  if (!sourcePage.node.Contents()) return geometry;
  const media = mediaBoxOf(sourcePage);
  // An identity form matrix keeps the embedded page in source user-space coordinates.
  const embedded = await out.embedPage(
    sourcePage,
    { left: media.x0, bottom: media.y0, right: media.x1, top: media.y1 },
    [1, 0, 0, 1, 0, 0],
  );
  page.node.normalize();
  const name = page.node.newXObject("BpsArt", embedded.ref);
  page.pushOperators(...bleedRegions(geometry).flatMap(({ region, matrix }) => drawRegion(region, matrix, name)));
  return geometry;
}

function loadSource(source: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
}

export async function imposeEdited(source: Uint8Array, pageIndex: number, edits: readonly JobEdit[]): Promise<ImposeResult> {
  const sourceDoc = await loadSource(source);
  const out = await PDFDocument.create();
  const geometry = await addEditedPage(out, sourceDoc.getPage(pageIndex), edits);
  return { pdf: await out.save(), geometry };
}

/**
 * Draws every page the job prints (the `pages` edit, else all pages) in ascending order, each
 * with the rest of the edit stack applied. Throws `EditError` for a selection or edit that can't apply.
 */
export async function imposeEditedPages(source: Uint8Array, edits: readonly JobEdit[]): Promise<ImposePagesResult> {
  const sourceDoc = await loadSource(source);
  const pageIndices = selectedPages(edits, sourceDoc.getPageCount());
  const out = await PDFDocument.create();
  const geometries: EditedGeometry[] = [];
  for (const pageIndex of pageIndices) {
    geometries.push(await addEditedPage(out, sourceDoc.getPage(pageIndex), edits));
  }
  return { pdf: await out.save(), pageIndices, geometries };
}
