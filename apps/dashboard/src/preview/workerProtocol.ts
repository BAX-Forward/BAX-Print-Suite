/** Messages between the page and the pdf.js preview worker (pdf.worker.ts). */

export type WorkerRequest =
  | { type: 'open'; reqId: number; key: string; data: ArrayBuffer }
  | { type: 'render'; reqId: number; key: string; pageIndex: number; maxPx: number }
  | { type: 'close'; reqId: number; key: string };

export type WorkerResponse =
  | { type: 'ok'; reqId: number }
  | { type: 'rendered'; reqId: number; bitmap: ImageBitmap; width: number; height: number }
  | { type: 'error'; reqId: number; message: string };

export type WithoutReqId<T> = T extends unknown ? Omit<T, 'reqId'> : never;
