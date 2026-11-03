/**
 * Render PDF pages with pdf.js (Apache-2.0) in Node. Canvases come from the
 * document's own canvas factory so they match the canvas library pdf.js uses
 * for its Path2D and DOMMatrix polyfills.
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PT_PER_MM } from "../../src/index.js";

/** Render resolution. Whole-mm geometry lands on pixel boundaries at this scale. */
export const PX_PER_MM = 2;

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row 0 at the top. */
  data: Uint8ClampedArray;
}

interface CanvasAndContext {
  context: { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } };
}

export async function renderPages(pdf: Uint8Array): Promise<Raster[]> {
  // pdf.js takes ownership of the buffer it is given, so pass a copy.
  const doc = await getDocument({
    data: pdf.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    const factory = (doc as unknown as { canvasFactory: { create(w: number, h: number): CanvasAndContext } })
      .canvasFactory;
    const rasters: Raster[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: PX_PER_MM / PT_PER_MM });
      const width = Math.round(viewport.width);
      const height = Math.round(viewport.height);
      const { context } = factory.create(width, height);
      await page.render({ canvasContext: context as never, viewport }).promise;
      rasters.push({ width, height, data: context.getImageData(0, 0, width, height).data });
    }
    return rasters;
  } finally {
    await doc.destroy();
  }
}

/** RGB of the pixel at (col, row); row 0 is the top. */
export function rgbAt(raster: Raster, col: number, row: number): [number, number, number] {
  if (col < 0 || row < 0 || col >= raster.width || row >= raster.height) {
    throw new RangeError(`pixel (${col}, ${row}) is outside the ${raster.width} × ${raster.height} raster`);
  }
  const i = (row * raster.width + col) * 4;
  return [raster.data[i], raster.data[i + 1], raster.data[i + 2]];
}

/** RGB at a point given in mm from the raster's bottom-left corner. */
export function rgbAtMm(raster: Raster, xMm: number, yMm: number): [number, number, number] {
  return rgbAt(raster, Math.floor(xMm * PX_PER_MM), Math.floor(raster.height - yMm * PX_PER_MM));
}

export function maxChannelDiff(a: readonly number[], b: readonly number[]): number {
  return Math.max(...a.map((v, i) => Math.abs(v - b[i])));
}
