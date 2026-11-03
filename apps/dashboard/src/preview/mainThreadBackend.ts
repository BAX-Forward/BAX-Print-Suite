import { renderPageToCanvas, type PdfDocument } from './renderPage';
import type { RenderBackend } from './types';

type PdfjsModule = typeof import('pdfjs-dist');

const MAX_OPEN_DOCUMENTS = 6;

/**
 * Fallback for browsers that cannot run pdf.js on OffscreenCanvas in a worker. pdf.js still
 * parses in its own worker; only rasterizing happens on the main thread.
 */
export function createMainThreadBackend(): RenderBackend {
  let pdfjs: Promise<PdfjsModule> | null = null;
  const docs = new Map<string, Promise<PdfDocument>>();

  function loadPdfjs(): Promise<PdfjsModule> {
    pdfjs ??= Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, workerUrl]) => {
      lib.GlobalWorkerOptions.workerSrc = workerUrl.default;
      return lib;
    });
    return pdfjs;
  }

  function openDocument(key: string, loadData: () => Promise<ArrayBuffer>): Promise<PdfDocument> {
    const existing = docs.get(key);
    if (existing) return existing;
    const opening = Promise.all([loadPdfjs(), loadData()]).then(
      // pdf.js may transfer (detach) the buffer it is given, so pass a copy.
      ([lib, data]) => lib.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false }).promise,
    );
    docs.set(key, opening);
    opening.catch(() => docs.delete(key));
    while (docs.size > MAX_OPEN_DOCUMENTS) {
      const oldest = docs.keys().next().value;
      if (oldest === undefined) break;
      const doc = docs.get(oldest);
      docs.delete(oldest);
      void doc?.then((d) => d.destroy()).catch(() => undefined);
    }
    return opening;
  }

  return {
    async render(key, loadData, pageIndex, maxPx) {
      const doc = await openDocument(key, loadData);
      const canvas = await renderPageToCanvas(doc, pageIndex, maxPx, (width, height) => {
        const element = document.createElement('canvas');
        element.width = width;
        element.height = height;
        const context = element.getContext('2d');
        if (!context) throw new Error('Canvas 2D context unavailable');
        return { canvas: element, context };
      });
      return { source: canvas, width: canvas.width, height: canvas.height };
    },
  };
}
