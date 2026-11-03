import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream, rgb } from "pdf-lib";
import type { ImposeFrame, ItemInfo, MarksHookContext, Placement } from "../src/index.js";
import { mmToPt } from "../src/index.js";
import type { GrayImage } from "./helpers.js";
import { interop } from "./helpers.js";

/** The decoded content streams of a page, joined (load from saved bytes first). */
export function pageContent(doc: PDFDocument, index = 0): string {
  const contents = doc.getPage(index).node.Contents();
  if (!contents) return "";
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  return streams
    .map((s) => (s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString("latin1") : ""))
    .join("\n");
}

export interface Imposition {
  readonly bytes: Uint8Array;
  readonly pageWidthPt: number;
  readonly pageHeightPt: number;
  readonly frame: ImposeFrame;
}

/**
 * A stand-in for a Spec 003 imposition: one page with each placement's bleed
 * box painted as "artwork" (a fill plus a few inner shapes in other colours).
 */
export async function imposeFixture(
  placements: readonly Placement[],
  pageWidthPt: number,
  pageHeightPt: number,
  frame: ImposeFrame,
): Promise<Imposition> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([pageWidthPt, pageHeightPt]);
  placements.forEach((p, i) => {
    const x = frame.originX + p.xPt * frame.scale;
    const y = frame.originY + p.yPt * frame.scale;
    const w = p.footprint.w * frame.scale;
    const h = p.footprint.h * frame.scale;
    page.drawRectangle({ x, y, width: w, height: h, color: rgb(0.2 + 0.3 * (i % 3), 0.6, 0.85) });
    page.drawRectangle({ x: x + w * 0.1, y: y + h * 0.1, width: w * 0.3, height: h * 0.5, color: rgb(0.9, 0.3, 0.1) });
    page.drawEllipse({ x: x + w * 0.7, y: y + h * 0.5, xScale: w * 0.15, yScale: h * 0.3, color: rgb(1, 0.9, 0.2) });
    page.drawLine({ start: { x, y }, end: { x: x + w, y: y + h }, thickness: 2, color: rgb(0.1, 0.1, 0.4) });
  });
  return { bytes: await doc.save(), pageWidthPt, pageHeightPt, frame };
}

/** Loads an imposition and returns the hook context Spec 003 would pass to `marks.draw()`. */
export async function hookContext(
  imp: Imposition,
  placements: readonly Placement[],
): Promise<{ doc: PDFDocument; ctx: MarksHookContext }> {
  const doc = await PDFDocument.load(imp.bytes);
  return { doc, ctx: { page: doc.getPage(0), layout: { placements }, frame: imp.frame } };
}

export const placementTrimPx = (
  item: ItemInfo,
  p: Placement,
  imp: Imposition,
  scale: number,
): { x0: number; y0: number; x1: number; y1: number } => {
  const b = mmToPt(item.bleedMm ?? 0) * imp.frame.scale;
  const left = imp.frame.originX + p.xPt * imp.frame.scale + b;
  const bottom = imp.frame.originY + p.yPt * imp.frame.scale + b;
  const right = imp.frame.originX + (p.xPt + p.footprint.w) * imp.frame.scale - b;
  const top = imp.frame.originY + (p.yPt + p.footprint.h) * imp.frame.scale - b;
  // pdf.js puts the page top at pixel row 0. Stay one pixel inside the trim edge.
  return {
    x0: Math.ceil(left * scale) + 1,
    x1: Math.floor(right * scale) - 1,
    y0: Math.ceil((imp.pageHeightPt - top) * scale) + 1,
    y1: Math.floor((imp.pageHeightPt - bottom) * scale) - 1,
  };
};

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

interface CanvasAndContext {
  readonly canvas: unknown;
  readonly context: {
    getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  };
}

interface PdfjsOptionalContentConfig {
  getGroups(): Record<string, { name: string | null }> | null;
  setVisibility(id: string, visible: boolean): void;
}

interface PdfjsPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: Record<string, unknown>): { promise: Promise<void> };
}

interface PdfjsDocument {
  readonly canvasFactory?: { create(w: number, h: number): CanvasAndContext };
  getPage(n: number): Promise<PdfjsPage>;
  getOptionalContentConfig(): Promise<PdfjsOptionalContentConfig>;
  destroy(): Promise<void>;
}

interface Pdfjs {
  getDocument(o: Record<string, unknown>): { promise: Promise<PdfjsDocument> };
}

let pdfjsPromise: Promise<Pdfjs> | undefined;

async function loadPdfjs(): Promise<Pdfjs> {
  // Registers the worker handler on globalThis so pdf.js runs in-process (no worker thread).
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return interop<Pdfjs>(await import("pdfjs-dist/legacy/build/pdf.mjs"));
}

async function createCanvas(doc: PdfjsDocument, w: number, h: number): Promise<CanvasAndContext> {
  if (doc.canvasFactory) return doc.canvasFactory.create(w, h);
  const napi = interop<{ createCanvas(w: number, h: number): { getContext(t: "2d"): CanvasAndContext["context"] } }>(
    await import("@napi-rs/canvas"),
  );
  const canvas = napi.createCanvas(w, h);
  return { canvas, context: canvas.getContext("2d") };
}

export interface RenderOptions {
  readonly scale: number;
  /** Optional content group names to hide. */
  readonly hide?: readonly string[];
}

/** Renders page 1 with pdf.js onto a white background. */
export async function renderPage(bytes: Uint8Array, opts: RenderOptions): Promise<{ image: RgbaImage; groups: string[] }> {
  pdfjsPromise ??= loadPdfjs();
  const pdfjs = await pdfjsPromise;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: opts.scale });
    const width = Math.round(viewport.width);
    const height = Math.round(viewport.height);
    const config = await doc.getOptionalContentConfig();
    const groups = Object.entries(config.getGroups() ?? {});
    for (const [id, group] of groups) if (group.name !== null && opts.hide?.includes(group.name)) config.setVisibility(id, false);
    const cc = await createCanvas(doc, width, height);
    await page.render({
      canvasContext: cc.context,
      viewport,
      background: "rgb(255,255,255)",
      optionalContentConfigPromise: Promise.resolve(config),
    }).promise;
    const { data } = cc.context.getImageData(0, 0, width, height);
    return { image: { width, height, data: new Uint8ClampedArray(data) }, groups: groups.map(([, g]) => g.name ?? "") };
  } finally {
    await doc.destroy();
  }
}

/** Largest per-channel difference inside a pixel rectangle (inclusive bounds). */
export function maxDiff(a: RgbaImage, b: RgbaImage, r: { x0: number; y0: number; x1: number; y1: number }): number {
  let max = 0;
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const i = 4 * (y * a.width + x);
      for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(a.data[i + c]! - b.data[i + c]!));
    }
  }
  return max;
}

/** A grayscale crop of an RGBA image. */
export function cropGray(img: RgbaImage, x0: number, y0: number, w: number, h: number): GrayImage {
  const gray = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 4 * ((y0 + y) * img.width + (x0 + x));
      gray[y * w + x] = Math.round(0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!);
    }
  }
  return { width: w, height: h, gray };
}
