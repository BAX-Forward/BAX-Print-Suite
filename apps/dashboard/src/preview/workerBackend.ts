import type { RenderBackend } from './types';
import type { WithoutReqId, WorkerRequest, WorkerResponse } from './workerProtocol';

/** Documents kept parsed in the worker; older ones are closed to bound memory. */
const MAX_OPEN_DOCUMENTS = 6;

interface Pending {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
}

/** Renders thumbnails in a dedicated Web Worker (pdf.js + OffscreenCanvas). */
export function createWorkerBackend(): RenderBackend {
  const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  const opened = new Map<string, Promise<void>>();
  let nextReqId = 1;
  let broken: Error | null = null;

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.reqId);
    if (!entry) return;
    pending.delete(message.reqId);
    if (message.type === 'error') entry.reject(new Error(message.message));
    else entry.resolve(message);
  };

  worker.onerror = (event) => {
    broken = new Error(event.message || 'Preview worker failed');
    for (const entry of pending.values()) entry.reject(broken);
    pending.clear();
  };

  function call(request: WithoutReqId<WorkerRequest>, transfer: Transferable[] = []): Promise<WorkerResponse> {
    if (broken) return Promise.reject(broken);
    const reqId = nextReqId++;
    return new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      worker.postMessage({ ...request, reqId } as WorkerRequest, transfer);
    });
  }

  function evictOldest() {
    while (opened.size > MAX_OPEN_DOCUMENTS) {
      const oldest = opened.keys().next().value;
      if (oldest === undefined) return;
      opened.delete(oldest);
      void call({ type: 'close', key: oldest }).catch(() => undefined);
    }
  }

  function ensureOpen(key: string, loadData: () => Promise<ArrayBuffer>): Promise<void> {
    const existing = opened.get(key);
    if (existing) return existing;
    const opening = loadData().then(async (data) => {
      // Transfer a copy: the caller's buffer stays usable (e.g. for the main-thread fallback).
      const copy = data.slice(0);
      await call({ type: 'open', key, data: copy }, [copy]);
    });
    opened.set(key, opening);
    opening.catch(() => opened.delete(key));
    evictOldest();
    return opening;
  }

  return {
    async render(key, loadData, pageIndex, maxPx) {
      await ensureOpen(key, loadData);
      const response = await call({ type: 'render', key, pageIndex, maxPx });
      if (response.type !== 'rendered') throw new Error('Unexpected worker response');
      return { source: response.bitmap, width: response.width, height: response.height };
    },
  };
}
