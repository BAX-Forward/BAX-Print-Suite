import { createMainThreadBackend } from './mainThreadBackend';
import type { RendererBackends } from './pdfThumbnailRenderer';
import { createWorkerBackend } from './workerBackend';

export const browserBackends: RendererBackends = {
  primary: () =>
    typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' ? null : createWorkerBackend(),
  fallback: createMainThreadBackend,
};
