import type { ItemInfo, Placement, Rotation } from "../src/index.js";
import { mmToPt } from "../src/index.js";

/** A placement whose footprint matches the item plus bleed, positioned in mm. */
export function placeMm(item: ItemInfo, xMm: number, yMm: number, rotation: Rotation = 0, copy = 0): Placement {
  const b = item.bleedMm ?? 0;
  const w = mmToPt(item.widthMm + 2 * b);
  const h = mmToPt(item.heightMm + 2 * b);
  const quarter = rotation === 90 || rotation === 270;
  return {
    itemId: item.itemId,
    copy,
    xPt: mmToPt(xMm),
    yPt: mmToPt(yMm),
    rotation,
    footprint: quarter ? { w: h, h: w } : { w, h },
  };
}

export interface GrayImage {
  readonly width: number;
  readonly height: number;
  /** One byte per pixel, 0 = black. */
  readonly gray: Uint8ClampedArray;
}

/** Rasterizes a module matrix (row 0 at the top) with a quiet zone. */
export function rasterize(modules: readonly (readonly boolean[])[], pxPerModule: number, quietModules: number): GrayImage {
  const n = modules.length;
  const side = (n + 2 * quietModules) * pxPerModule;
  const gray = new Uint8ClampedArray(side * side).fill(255);
  modules.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return;
      for (let dy = 0; dy < pxPerModule; dy++) {
        const y = (r + quietModules) * pxPerModule + dy;
        gray.fill(0, y * side + (c + quietModules) * pxPerModule, y * side + (c + quietModules + 1) * pxPerModule);
      }
    }),
  );
  return { width: side, height: side, gray };
}

export function grayToRgba(img: GrayImage): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  img.gray.forEach((v, i) => {
    out[4 * i] = v;
    out[4 * i + 1] = v;
    out[4 * i + 2] = v;
    out[4 * i + 3] = 255;
  });
  return out;
}

/** CommonJS packages expose their exports as `default` under some loaders and directly under others. */
export function interop<T>(mod: unknown): T {
  let m = mod;
  for (let i = 0; i < 2; i++) {
    const inner = (m as { default?: unknown } | null)?.default;
    if (inner === undefined || inner === null || typeof m === "function") break;
    m = inner;
  }
  return m as T;
}

export interface QrResult {
  readonly data: string;
}
type JsQr = (data: Uint8ClampedArray, width: number, height: number) => QrResult | null;

export async function decodeQr(rgba: Uint8ClampedArray, width: number, height: number): Promise<string | undefined> {
  const jsQR = interop<JsQr>(await import("jsqr"));
  return jsQR(rgba, width, height)?.data;
}
