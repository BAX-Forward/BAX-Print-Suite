import {
  createCanvas,
  DOMMatrix,
  ImageData,
  Path2D,
  type Canvas,
  type SKRSContext2D,
} from "@napi-rs/canvas";

// pdf.js expects these DOM classes; Node has none of them. Set before pdf.js loads.
const globals = globalThis as Record<string, unknown>;
globals.DOMMatrix ??= DOMMatrix;
globals.Path2D ??= Path2D;
globals.ImageData ??= ImageData;

/** The small part of the pdf.js API the tests use. */
export interface PdfJsPage {
  readonly view: number[];
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: object): { promise: Promise<void> };
}

export interface PdfJsDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  destroy(): Promise<void>;
}

interface PdfJs {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfJsDocument> };
}

// A non-literal specifier keeps the type checker off pdf.js's own typings.
const PDFJS_MODULE = "pdfjs-dist/legacy/build/pdf.mjs";
const pdfjs = (await import(PDFJS_MODULE)) as PdfJs;

interface CanvasAndContext {
  canvas: Canvas | null;
  context: SKRSContext2D | null;
}

function pixels(size: number): number {
  return Math.max(1, Math.ceil(size));
}

/** Scratch canvases for pdf.js (groups, patterns), backed by @napi-rs/canvas. */
class NapiCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    const canvas = createCanvas(pixels(width), pixels(height));
    return { canvas, context: canvas.getContext("2d") };
  }

  reset(target: CanvasAndContext, width: number, height: number): void {
    if (!target.canvas) return;
    target.canvas.width = pixels(width);
    target.canvas.height = pixels(height);
  }

  destroy(target: CanvasAndContext): void {
    target.canvas = null;
    target.context = null;
  }
}

export type Rgb = readonly [number, number, number];

export interface Raster {
  readonly widthPx: number;
  readonly heightPx: number;
  /** RGB at a point in PDF page space (origin bottom-left of the MediaBox). */
  colorAt(xPt: number, yPt: number): Rgb;
}

/** Opens a PDF with pdf.js (the input is copied: pdf.js detaches its buffer). */
export function openWithPdfJs(bytes: Uint8Array): Promise<PdfJsDocument> {
  return pdfjs.getDocument({
    data: bytes.slice(),
    CanvasFactory: NapiCanvasFactory,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
}

export async function renderPage(bytes: Uint8Array, pageIndex: number, scale: number): Promise<Raster> {
  const doc = await openWithPdfJs(bytes);
  try {
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(pixels(viewport.width), pixels(viewport.height));
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;
    const { width, height } = canvas;
    const data = context.getImageData(0, 0, width, height).data;
    const [x0 = 0, , , y1 = 0] = page.view;
    return {
      widthPx: width,
      heightPx: height,
      colorAt(xPt, yPt) {
        const px = Math.floor((xPt - x0) * scale);
        const py = Math.floor((y1 - yPt) * scale);
        if (px < 0 || py < 0 || px >= width || py >= height) {
          throw new RangeError(`(${xPt}, ${yPt}) pt is outside the page`);
        }
        const i = (py * width + px) * 4;
        return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
      },
    };
  } finally {
    await doc.destroy();
  }
}
