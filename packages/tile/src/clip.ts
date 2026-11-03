/**
 * FR8: clip cut contours to a panel's printed area.
 *
 * A panel is an axis-aligned rectangle and a contour is a polyline, so this
 * needs line clipping (Liang–Barsky), not general polygon booleans. That keeps
 * it free of the Clipper2 dependency whose allowlist decision is pending
 * (Spec 003). `clipContours` moves to `packages/cut` once Spec 004 lands.
 */
import type { Panel } from "./types.js";
import { mmToPt } from "./units.js";

export type Point = [number, number];

/**
 * Structural copy of Spec 004's `Contour` (points in pt, relative to the
 * page TrimBox bottom-left; for tiled artwork that is the artwork frame).
 */
export interface Contour {
  id: string;
  tool: string;
  source: { kind: "spot" | "layer"; name: string };
  closed: boolean;
  points: Point[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  areaSigned: number;
}

export interface RectPt {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClippedContour extends Contour {
  /**
   * `whole`: the contour lies entirely in the rectangle and is unchanged.
   * `open`: a fragment cut at the rectangle's edge; the operator decides whether to cut it.
   */
  clip: "whole" | "open";
  sourceContourId: string;
}

/** Points closer than this (pt) are merged; matches Spec 004's cleanup tolerance. */
const DUPLICATE_PT = 0.01;

export function clipContours(contours: readonly Contour[], area: RectPt): ClippedContour[] {
  return contours.flatMap((contour) => clipContour(contour, area));
}

/**
 * Clip contours to every panel's printed area. Output coordinates are in each
 * panel's frame (pt from the bottom-left of its printed area). Keyed by panel id.
 */
export function contoursForPanels(contours: readonly Contour[], panels: readonly Panel[]): Map<string, ClippedContour[]> {
  return new Map(
    panels.map((panel) => {
      const area: RectPt = {
        x: mmToPt(panel.printed.x),
        y: mmToPt(panel.printed.y),
        width: mmToPt(panel.printed.width),
        height: mmToPt(panel.printed.height),
      };
      const local = clipContours(contours, area).map((c) => translate(c, -area.x, -area.y));
      return [panel.id, local];
    }),
  );
}

function clipContour(contour: Contour, area: RectPt): ClippedContour[] {
  const { points } = contour;
  if (points.length === 0) return [];
  if (points.every((p) => inside(p, area))) {
    return [{ ...contour, points: points.map((p) => [p[0], p[1]]), clip: "whole", sourceContourId: contour.id }];
  }

  const segments: [Point, Point][] = [];
  points.forEach((p, i) => {
    const q = points[i + 1];
    if (q) segments.push([p, q]);
  });
  const first = points[0];
  const lastPoint = points[points.length - 1];
  if (contour.closed && first && lastPoint && !samePoint(first, lastPoint)) {
    segments.push([lastPoint, first]);
  }

  const fragments: Point[][] = [];
  let current: Point[] | undefined;
  let startsAtFirstPoint = false;
  let endsAtLastPoint = false;

  for (const [i, [p, q]] of segments.entries()) {
    const t = clipSegment(p, q, area);
    if (!t) {
      if (current) fragments.push(current);
      current = undefined;
      continue;
    }
    const [t0, t1] = t;
    const a = lerp(p, q, t0);
    const b = lerp(p, q, t1);
    if (t0 > 0 || !current) {
      if (current) fragments.push(current);
      current = [a, b];
      if (i === 0 && t0 === 0) startsAtFirstPoint = true;
    } else {
      current.push(b);
    }
    if (t1 < 1) {
      fragments.push(current);
      current = undefined;
    } else if (i === segments.length - 1) {
      endsAtLastPoint = true;
    }
  }
  if (current) fragments.push(current);

  // A closed contour whose start lies inside: the last fragment runs into the first.
  if (contour.closed && startsAtFirstPoint && endsAtLastPoint && fragments.length > 1) {
    const last = fragments.pop() as Point[];
    const head = fragments[0] as Point[];
    fragments[0] = [...last, ...head.slice(1)];
  }

  return fragments
    .map(dedupePoints)
    .filter((f) => f.length >= 2)
    .map((f, k) => ({
      ...contour,
      id: `${contour.id}#${k + 1}`,
      closed: false,
      points: f,
      bbox: bboxOf(f),
      areaSigned: 0,
      clip: "open" as const,
      sourceContourId: contour.id,
    }));
}

/** Liang–Barsky: the parameter interval of segment p→q inside the rectangle, or undefined. */
function clipSegment(p: Point, q: Point, r: RectPt): [number, number] | undefined {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const checks: [number, number][] = [
    [-dx, p[0] - r.x],
    [dx, r.x + r.width - p[0]],
    [-dy, p[1] - r.y],
    [dy, r.y + r.height - p[1]],
  ];
  let t0 = 0;
  let t1 = 1;
  for (const [denominator, distance] of checks) {
    if (denominator === 0) {
      if (distance < 0) return undefined;
      continue;
    }
    const t = distance / denominator;
    if (denominator < 0) {
      if (t > t1) return undefined;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return undefined;
      if (t < t1) t1 = t;
    }
  }
  return [t0, t1];
}

function inside(p: Point, r: RectPt): boolean {
  return p[0] >= r.x && p[0] <= r.x + r.width && p[1] >= r.y && p[1] <= r.y + r.height;
}

function lerp(p: Point, q: Point, t: number): Point {
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

function samePoint(a: Point, b: Point): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < DUPLICATE_PT;
}

function dedupePoints(points: Point[]): Point[] {
  return points.filter((p, i) => {
    const prev = points[i - 1];
    return prev === undefined || !samePoint(p, prev);
  });
}

function bboxOf(points: readonly Point[]): Contour["bbox"] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function translate(c: ClippedContour, dx: number, dy: number): ClippedContour {
  const b = c.bbox;
  return {
    ...c,
    points: c.points.map((p) => [p[0] + dx, p[1] + dy]),
    bbox: { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy },
  };
}
