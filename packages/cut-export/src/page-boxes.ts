// Page boxes of a production PDF (Spec 007h): the MediaBox, CropBox and TrimBox
// of one page with its `/Rotate` and `/UserUnit`, as the edit geometry and the
// trim-box cut contour read them (ISO 32000-1 §7.7.3.3, §14.11.2).

import { CutterDriverError } from "@bax-print/plugin-sdk";
import { PDFDocument, PDFName, PDFNumber, type PDFArray, type PDFPageLeaf } from "pdf-lib";

/** A box in PDF user space, normalised so `x0 <= x1` and `y0 <= y1`. A structural copy of `Rect` in `@bax-print/edits`. */
export interface PdfBoxRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A page's boxes in PDF user space with its `/Rotate` and `/UserUnit`. A structural copy of
 * `PageBoxes` in `@bax-print/edits`, so this package needs no dependency on the edits package.
 * The boxes are not scaled by `userUnit` and not rotated; the edit geometry applies both.
 */
export interface PdfPageBoxes {
  mediaBox: PdfBoxRect;
  cropBox: PdfBoxRect;
  /** The page TrimBox, else its CropBox, else its MediaBox (Spec 004). */
  trimBox: PdfBoxRect;
  /** Clockwise degrees: 0, 90, 180 or 270. */
  rotate: number;
  userUnit: number;
}

const USER_UNIT = PDFName.of("UserUnit");

function invalid(message: string): CutterDriverError {
  return new CutterDriverError("invalid-job", message);
}

function rectOf(array: PDFArray, name: string): PdfBoxRect {
  if (array.size() !== 4) throw invalid(`page ${name} must have four numbers`);
  const [a, b, c, d] = [0, 1, 2, 3].map((index) => array.lookup(index, PDFNumber).asNumber());
  if (a === undefined || b === undefined || c === undefined || d === undefined || ![a, b, c, d].every(Number.isFinite)) {
    throw invalid(`page ${name} must have four finite numbers`);
  }
  return { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
}

/** A box is clipped to the box it defaults to (ISO 32000-1 §14.11.2). */
function clip(box: PdfBoxRect, to: PdfBoxRect, name: string): PdfBoxRect {
  const clipped = { x0: Math.max(box.x0, to.x0), y0: Math.max(box.y0, to.y0), x1: Math.min(box.x1, to.x1), y1: Math.min(box.y1, to.y1) };
  if (!(clipped.x1 > clipped.x0 && clipped.y1 > clipped.y0)) throw invalid(`page ${name} has no area inside the page`);
  return clipped;
}

function normalisedRotate(rotate: number): number {
  if (!Number.isInteger(rotate) || rotate % 90 !== 0) throw invalid(`page /Rotate must be a multiple of 90, got ${rotate}`);
  return ((rotate % 360) + 360) % 360;
}

function userUnitOf(page: PDFPageLeaf): number {
  const value = page.lookupMaybe(USER_UNIT, PDFNumber)?.asNumber() ?? 1;
  if (!(Number.isFinite(value) && value > 0)) throw invalid(`page /UserUnit must be a positive number, got ${value}`);
  return value;
}

function boxesOf(page: PDFPageLeaf): PdfPageBoxes {
  // MediaBox, CropBox and Rotate are inherited from the parent Pages nodes; TrimBox is not.
  const mediaBox = rectOf(page.MediaBox(), "MediaBox");
  const crop = page.CropBox();
  const cropBox = crop ? clip(rectOf(crop, "CropBox"), mediaBox, "CropBox") : mediaBox;
  const trim = page.TrimBox();
  const trimBox = trim ? clip(rectOf(trim, "TrimBox"), cropBox, "TrimBox") : cropBox;
  const rotate = normalisedRotate(page.Rotate()?.asNumber() ?? 0);
  return { mediaBox, cropBox, trimBox, rotate, userUnit: userUnitOf(page) };
}

/** The loaded document and its page count; a document without a readable page tree is not a readable PDF. */
async function loadPdf(pdfBytes: Uint8Array): Promise<{ pdf: PDFDocument; pageCount: number }> {
  try {
    // Page boxes are never encrypted, so an encrypted document still has readable boxes.
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
    return { pdf, pageCount: pdf.getPageCount() };
  } catch (error) {
    throw invalid(`source document is not a readable PDF: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reads the boxes of one page of a PDF (Spec 007h). A missing CropBox is the MediaBox and a
 * missing TrimBox the CropBox; both are clipped to the box they default to. `/Rotate` is
 * inherited from the parent Pages nodes and normalised to 0, 90, 180 or 270; `/UserUnit`
 * defaults to 1. Throws `CutterDriverError("invalid-job")` when the bytes are not a readable
 * PDF, the page index is out of range or a box, `/Rotate` or `/UserUnit` is malformed.
 */
export async function readPageBoxes(pdfBytes: Uint8Array, pageIndex = 0): Promise<PdfPageBoxes> {
  const { pdf, pageCount } = await loadPdf(pdfBytes);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
    throw invalid(`page index ${pageIndex} is out of range for a document with ${pageCount} page(s)`);
  }
  try {
    return boxesOf(pdf.getPage(pageIndex).node);
  } catch (error) {
    if (error instanceof CutterDriverError) throw error;
    throw invalid(`page ${pageIndex} has malformed page boxes: ${error instanceof Error ? error.message : String(error)}`);
  }
}
