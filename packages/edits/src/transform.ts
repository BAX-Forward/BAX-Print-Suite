/**
 * 2D affine matrices in the PDF convention (ISO 32000-1 §8.3.3): `[a b c d e f]` maps
 * (x, y) to (a·x + c·y + e, b·x + d·y + f). Canvas 2D `transform()` uses the same layout.
 */
export type Matrix = readonly [number, number, number, number, number, number];

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export const PT_PER_INCH = 72;
export const PT_PER_MM = PT_PER_INCH / 25.4;

export const mmToPt = (mm: number): number => mm * PT_PER_MM;
export const ptToMm = (pt: number): number => pt / PT_PER_MM;

/** The matrix that applies `first`, then `then`. */
export function multiply(first: Matrix, then: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = first;
  const [a2, b2, c2, d2, e2, f2] = then;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export function translate(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}

export function scale(sx: number, sy: number = sx): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

export function determinant(m: Matrix): number {
  return m[0] * m[3] - m[1] * m[2];
}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = determinant(m);
  if (Math.abs(det) < 1e-12) throw new RangeError("Matrix is not invertible");
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(e * ia + f * ic), -(e * ib + f * id)];
}

export function applyToPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Axis-aligned bounding box of a transformed rectangle. */
export function transformRect(m: Matrix, r: Rect): Rect {
  const corners = [
    applyToPoint(m, r.x0, r.y0),
    applyToPoint(m, r.x1, r.y0),
    applyToPoint(m, r.x0, r.y1),
    applyToPoint(m, r.x1, r.y1),
  ];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Lengths of the transformed unit x and y vectors. */
export function axisLengths(m: Matrix): { x: number; y: number } {
  return { x: Math.hypot(m[0], m[1]), y: Math.hypot(m[2], m[3]) };
}

export function rectWidth(r: Rect): number {
  return r.x1 - r.x0;
}

export function rectHeight(r: Rect): number {
  return r.y1 - r.y0;
}

export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

export function rectContains(outer: Rect, inner: Rect, tolerance = 0.01): boolean {
  return (
    inner.x0 >= outer.x0 - tolerance &&
    inner.y0 >= outer.y0 - tolerance &&
    inner.x1 <= outer.x1 + tolerance &&
    inner.y1 <= outer.y1 + tolerance
  );
}

/** True when the rectangles overlap with positive area. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Largest absolute element difference. */
export function matrixDistance(m1: Matrix, m2: Matrix): number {
  return Math.max(...m1.map((v, i) => Math.abs(v - m2[i]!)));
}

/** Rounds values within `epsilon` of an integer, so output PDFs carry 0 rather than 6e-17. */
export function snapMatrix(m: Matrix, epsilon = 1e-9): Matrix {
  const snap = (v: number): number => {
    const r = Math.round(v);
    return Math.abs(v - r) < epsilon ? r : v;
  };
  const [a, b, c, d, e, f] = m;
  return [snap(a), snap(b), snap(c), snap(d), snap(e), snap(f)];
}

/**
 * Canvas transform for previewing edits on a pdf.js render of the *source* page.
 *
 * pdf.js composes `render({transform})` on top of `viewport.transform`, so the result maps
 * source user space → output footprint (the same `toFootprint` the layout stage draws with)
 * → canvas pixels of an output-sized canvas (y down). Preview and imposed output therefore
 * share one matrix (Spec 007 FR6).
 */
export function previewRenderTransform(
  toFootprint: Matrix,
  footprintHeightPt: number,
  viewportTransform: Matrix,
  pixelsPerPt: number,
): Matrix {
  const outputToCanvas: Matrix = [pixelsPerPt, 0, 0, -pixelsPerPt, 0, footprintHeightPt * pixelsPerPt];
  return multiply(multiply(invert(viewportTransform), toFootprint), outputToCanvas);
}
