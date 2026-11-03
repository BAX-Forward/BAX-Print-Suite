/** Thumbnails are capped at this edge length (Spec 002: "max 320 px"). */
export const MAX_THUMBNAIL_PX = 320;

export interface ThumbnailRequest {
  jobId: string;
  /** 0-based page index (Job.pages[].index). */
  pageIndex: number;
  maxPx: number;
}

export interface ThumbnailImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export interface ThumbnailRenderer {
  render(request: ThumbnailRequest): Promise<ThumbnailImage>;
}

/** A way of turning PDF bytes into page images (Web Worker, or main thread as a fallback). */
export interface RenderBackend {
  render(
    key: string,
    loadData: () => Promise<ArrayBuffer>,
    pageIndex: number,
    maxPx: number,
  ): Promise<ThumbnailImage>;
}

export function thumbnailScale(widthPt: number, heightPt: number, maxPx: number): number {
  const longest = Math.max(widthPt, heightPt);
  if (!(longest > 0)) return 1;
  return Math.min(maxPx, MAX_THUMBNAIL_PX) / longest;
}
