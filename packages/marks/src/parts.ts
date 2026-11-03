import {
  applyPoint,
  applyRect,
  applySegment,
  boundsOf,
  rotationOf,
  compose,
  strokeBounds,
  type Matrix,
  type Rect,
} from "./geometry.js";
import type { Rotation } from "./layout-types.js";
import type { MarkPart, PlannedElement } from "./plan-types.js";

/** Maps a part through `m` (item frame → layout frame). */
export function transformPart(part: MarkPart, m: Matrix): MarkPart {
  switch (part.type) {
    case "lines":
      return { ...part, segments: part.segments.map((s) => applySegment(m, s)) };
    case "dots":
      return { ...part, centers: part.centers.map((p) => applyPoint(m, p)) };
    case "symbols": {
      const turn = rotationOf(m);
      return {
        ...part,
        instances: part.instances.map((i) => ({
          center: applyPoint(m, i.center),
          rotation: ((i.rotation + turn) % 360) as Rotation,
        })),
      };
    }
    case "label":
      return { ...part, matrix: compose(part.matrix, m) };
  }
}

/** Areas a part covers (one rectangle per stroke, dot, symbol or label). */
export function partShapes(part: MarkPart): Rect[] {
  switch (part.type) {
    case "lines":
      return part.segments.map((s) => strokeBounds(s, part.lineWidthMm));
    case "dots": {
      const r = part.diameterMm / 2 + (part.style === "crosshair" ? part.lineWidthMm / 2 : 0);
      return part.centers.map((c) => ({ x: c.x - r, y: c.y - r, w: 2 * r, h: 2 * r }));
    }
    case "symbols":
      return part.instances.map((i) => {
        const quarter = i.rotation === 90 || i.rotation === 270;
        const w = quarter ? part.heightMm : part.widthMm;
        const h = quarter ? part.widthMm : part.heightMm;
        return { x: i.center.x - w / 2, y: i.center.y - h / 2, w, h };
      });
    case "label":
      return [applyRect(part.matrix, { x: 0, y: 0, w: part.widthMm, h: part.heightMm })];
  }
}

export function elementShapes(element: Pick<PlannedElement, "parts">): Rect[] {
  return element.parts.flatMap(partShapes);
}

/** Union of all shapes, or undefined for an element that draws nothing. */
export function elementBounds(element: Pick<PlannedElement, "parts">): Rect | undefined {
  const shapes = elementShapes(element);
  if (shapes.length === 0) return undefined;
  return boundsOf(shapes.flatMap((r) => [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
  ]));
}
