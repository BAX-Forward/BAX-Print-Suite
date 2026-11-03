import type { ApiClient } from '../api/client';
import type { RenderBackend, ThumbnailImage, ThumbnailRenderer, ThumbnailRequest } from './types';

type PreviewApi = Pick<ApiClient, 'getJobFile' | 'getPreview'>;

export interface RendererBackends {
  /** Preferred backend (Web Worker). Return null when unsupported. */
  primary: () => RenderBackend | null;
  /** Used when the primary is unavailable or fails. */
  fallback: () => RenderBackend;
}

/** PDFs kept in memory for re-rendering; oldest are dropped first. */
const MAX_CACHED_FILES = 8;

/**
 * Thumbnail pipeline: try the server's `GET /jobs/:id/preview` (RenderEngine, M5+). While that
 * answers 501, render the stored PDF with pdf.js in a Web Worker, falling back to the main thread.
 */
export function createPdfThumbnailRenderer(api: PreviewApi, backends: RendererBackends): ThumbnailRenderer {
  let serverPreviews: 'unknown' | 'available' | 'unavailable' = 'unknown';
  const files = new Map<string, Promise<ArrayBuffer>>();
  let primary: RenderBackend | null | undefined;
  let fallback: RenderBackend | undefined;

  function loadFile(jobId: string): Promise<ArrayBuffer> {
    const cached = files.get(jobId);
    if (cached) return cached;
    const loading = api.getJobFile(jobId);
    files.set(jobId, loading);
    loading.catch(() => files.delete(jobId));
    while (files.size > MAX_CACHED_FILES) {
      const oldest = files.keys().next().value;
      if (oldest === undefined) break;
      files.delete(oldest);
    }
    return loading;
  }

  async function fromServer(request: ThumbnailRequest): Promise<ThumbnailImage | null> {
    if (serverPreviews === 'unavailable') return null;
    try {
      const blob = await api.getPreview(request.jobId, request.pageIndex + 1, request.maxPx);
      if (!blob) {
        serverPreviews = 'unavailable';
        return null;
      }
      serverPreviews = 'available';
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // Older servers or transient errors: render locally this time, ask again next time.
      return null;
    }
  }

  function getPrimary(): RenderBackend | null {
    if (primary === undefined) {
      try {
        primary = backends.primary();
      } catch {
        primary = null;
      }
    }
    return primary;
  }

  return {
    async render(request) {
      const served = await fromServer(request);
      if (served) return served;

      const load = () => loadFile(request.jobId);
      const worker = getPrimary();
      if (worker) {
        try {
          return await worker.render(request.jobId, load, request.pageIndex, request.maxPx);
        } catch (error) {
          console.warn('Worker preview failed; rendering on the main thread instead.', error);
        }
      }
      fallback ??= backends.fallback();
      return fallback.render(request.jobId, load, request.pageIndex, request.maxPx);
    },
  };
}
