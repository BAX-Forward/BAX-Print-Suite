import type { Rotation } from "./layout-types.js";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Segment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Axis-aligned rectangle; (x, y) is the minimum corner. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Affine matrix [a b c d e f] in the ISO 32000 §8.3.3 row-vector convention:
 * x' = a·x + c·y + e, y' = b·x + d·y + f.
 */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const OVERLAP_EPS = 1e-9;

export const translate = (tx: number, ty: number): Matrix => [1, 0, 0, 1, tx, ty];
export const scaling = (sx: number, sy: number): Matrix => [sx, 0, 0, sy, 0, 0];

/**
 * The matrix that applies `first`, then `second`. Not named `then`: a module
 * exporting `then` is thenable, so `await import()` of it breaks.
 */
export function compose(first: Matrix, second: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = first;
  const [a2, b2, c2, d2, e2, f2] = second;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

/** Applies matrices left to right. */
export function chain(...matrices: readonly Matrix[]): Matrix {
  return matrices.reduce((acc, m) => compose(acc, m), IDENTITY);
}

export function applyPoint(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function applySegment(m: Matrix, s: Segment): Segment {
  const a = applyPoint(m, { x: s.x1, y: s.y1 });
  const b = applyPoint(m, { x: s.x2, y: s.y2 });
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

export function boundsOf(points: readonly Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function applyRect(m: Matrix, r: Rect): Rect {
  return boundsOf([
    applyPoint(m, { x: r.x, y: r.y }),
    applyPoint(m, { x: r.x + r.w, y: r.y }),
    applyPoint(m, { x: r.x + r.w, y: r.y + r.h }),
    applyPoint(m, { x: r.x, y: r.y + r.h }),
  ]);
}

/** Rotation component of a matrix made of quarter turns. */
export function rotationOf(m: Matrix): Rotation {
  if (Math.abs(m[0] - 1) < 1e-9) return 0;
  if (Math.abs(m[1] - 1) < 1e-9) return 90;
  if (Math.abs(m[0] + 1) < 1e-9) return 180;
  return 270;
}

/** True when the interiors of two rectangles overlap (touching edges do not). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w - OVERLAP_EPS &&
    b.x < a.x + a.w - OVERLAP_EPS &&
    a.y < b.y + b.h - OVERLAP_EPS &&
    b.y < a.y + a.h - OVERLAP_EPS
  );
}

export function intersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
}

export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

/**
 * Area covered by a stroked segment with butt caps. Exact for axis-aligned
 * segments, conservative (bounding box) otherwise.
 */
export function strokeBounds(s: Segment, widthMm: number): Rect {
  const half = widthMm / 2;
  const box = boundsOf([
    { x: s.x1, y: s.y1 },
    { x: s.x2, y: s.y2 },
  ]);
  if (s.y1 === s.y2) return { x: box.x, y: box.y - half, w: box.w, h: 2 * half };
  if (s.x1 === s.x2) return { x: box.x - half, y: box.y, w: 2 * half, h: box.h };
  return inflate(box, half);
}

export interface ItemBox {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly bleedMm: number;
}

/**
 * Maps item-local trim coordinates (mm, origin at the trim box bottom-left,
 * unrotated artwork) into the layout frame (mm), for a footprint whose
 * bottom-left after a counter-clockwise rotation sits at (xMm, yMm).
 */
export function itemMatrix(xMm: number, yMm: number, rotation: Rotation, item: ItemBox): Matrix {
  const b = item.bleedMm;
  const w = item.widthMm + 2 * b;
  const h = item.heightMm + 2 * b;
  switch (rotation) {
    case 0:
      return [1, 0, 0, 1, xMm + b, yMm + b];
    case 90:
      return [0, 1, -1, 0, xMm + h - b, yMm + b];
    case 180:
      return [-1, 0, 0, -1, xMm + w - b, yMm + h - b];
    case 270:
      return [0, -1, 1, 0, xMm + b, yMm + w - b];
  }
}

/** Removes points closer than 1 µm to an earlier point, keeping order. */
export function uniquePoints(points: readonly Point[]): Point[] {
  const seen = new Set<string>();
  return points.filter((p) => {
    const key = `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
