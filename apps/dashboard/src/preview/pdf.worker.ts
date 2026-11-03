/**
 * Web Worker that renders PDF page thumbnails with pdf.js onto OffscreenCanvas, so parsing and
 * rasterizing never block the UI thread. Results are transferred back as ImageBitmaps.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { renderPageToCanvas, type PdfDocument } from './renderPage';
import type { WorkerRequest, WorkerResponse } from './workerProtocol';

GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

interface CanvasAndContext {
  canvas: OffscreenCanvas | null;
  context: OffscreenCanvasRenderingContext2D | null;
}

/** pdf.js defaults to DOM canvases; workers have no document, so hand it OffscreenCanvas. */
class OffscreenCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(target: CanvasAndContext, width: number, height: number): void {
    if (!target.canvas) return;
    target.canvas.width = width;
    target.canvas.height = height;
  }

  destroy(target: CanvasAndContext): void {
    if (target.canvas) {
      target.canvas.width = 0;
      target.canvas.height = 0;
    }
    target.canvas = null;
    target.context = null;
  }
}

/** The default filter factory builds SVG filters in the DOM; skip them (screen preview only). */
class NoopFilterFactory {
  addFilter(): string {
    return 'none';
  }
  addHCMFilter(): string {
    return 'none';
  }
  addAlphaFilter(): string {
    return 'none';
  }
  addLuminosityFilter(): string {
    return 'none';
  }
  addHighlightHCMFilter(): string {
    return 'none';
  }
  destroy(): void {}
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const docs = new Map<string, Promise<PdfDocument>>();

function openDocument(data: ArrayBuffer): Promise<PdfDocument> {
  const params: Record<string, unknown> = {
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: true,
    CanvasFactory: OffscreenCanvasFactory,
    FilterFactory: NoopFilterFactory,
  };
  return getDocument(params as unknown as Parameters<typeof getDocument>[0]).promise;
}

async function handle(request: WorkerRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'open': {
        const doc = openDocument(request.data);
        docs.set(request.key, doc);
        try {
          await doc;
        } catch (error) {
          docs.delete(request.key);
          throw error;
        }
        scope.postMessage({ type: 'ok', reqId: request.reqId });
        return;
      }
      case 'close': {
        const doc = docs.get(request.key);
        docs.delete(request.key);
        if (doc) await (await doc).destroy();
        scope.postMessage({ type: 'ok', reqId: request.reqId });
        return;
      }
      case 'render': {
        const doc = docs.get(request.key);
        if (!doc) throw new Error(`Document ${request.key} is not open`);
        const canvas = await renderPageToCanvas(await doc, request.pageIndex, request.maxPx, (w, h) => {
          const offscreen = new OffscreenCanvas(w, h);
          const context = offscreen.getContext('2d');
          if (!context) throw new Error('OffscreenCanvas 2D context unavailable');
          return { canvas: offscreen, context };
        });
        const bitmap = canvas.transferToImageBitmap();
        scope.postMessage(
          { type: 'rendered', reqId: request.reqId, bitmap, width: bitmap.width, height: bitmap.height },
          [bitmap],
        );
        return;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ type: 'error', reqId: request.reqId, message });
  }
}

scope.onmessage = (event) => {
  void handle(event.data);
};
