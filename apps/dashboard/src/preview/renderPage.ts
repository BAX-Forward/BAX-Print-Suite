import type * as Pdfjs from 'pdfjs-dist';
import { thumbnailScale } from './types';

export type PdfDocument = Awaited<ReturnType<typeof Pdfjs.getDocument>['promise']>;

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Renders one page, scaled so its longest edge is at most `maxPx`, onto a canvas from `create`. */
export async function renderPageToCanvas<C>(
  doc: PdfDocument,
  pageIndex: number,
  maxPx: number,
  create: (width: number, height: number) => { canvas: C; context: Context2D },
): Promise<C> {
  const page = await doc.getPage(pageIndex + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: thumbnailScale(base.width, base.height, maxPx) });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const { canvas, context } = create(width, height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    // pdf.js types the context as the DOM one; OffscreenCanvas contexts expose the same drawing API.
    await page.render({ canvasContext: context as CanvasRenderingContext2D, viewport }).promise;
    return canvas;
  } finally {
    page.cleanup();
  }
}
