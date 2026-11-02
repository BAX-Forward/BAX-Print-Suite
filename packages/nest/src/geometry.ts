import type { Rotation } from "./types.js";

/** Tolerance (points) for geometric comparisons, far below any printable distance. */
export const EPS = 1e-7;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const COS_SIN: Readonly<Record<Rotation, readonly [number, number]>> = {
  0: [1, 0],
  90: [0, 1],
  180: [-1, 0],
  270: [0, -1],
};

/** Exact cosine and sine of a counter-clockwise quarter turn. */
export function cosSin(rotation: Rotation): readonly [number, number] {
  return COS_SIN[rotation] ?? COS_SIN[0];
}

/** Compact decimal for SVG/report output: 3 decimals, no "-0". */
export function formatNumber(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}
