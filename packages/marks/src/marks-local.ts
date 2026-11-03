/**
 * Mark geometry in the item-local trim frame: millimetres, origin at the trim
 * box bottom-left of the unrotated artwork. The planner maps it to the layout.
 */
import { uniquePoints, type ItemBox, type Point, type Segment } from "./geometry.js";
import type { Anchor, CropMark, CustomMark, Edge, FoldLine } from "./schema.js";

const seg = (x1: number, y1: number, x2: number, y2: number): Segment => ({ x1, y1, x2, y2 });

export interface LocalResult<T> {
  readonly value: T;
  readonly warnings: string[];
}

/** Eight corner lines on the trim edge extensions, starting at max(offset, bleed). */
export function cropSegments(item: ItemBox, spec: CropMark): LocalResult<Segment[]> {
  const { widthMm: w, heightMm: h, bleedMm: b } = item;
  const near = Math.max(spec.offsetMm, b);
  const far = near + spec.lengthMm;
  const warnings =
    spec.offsetMm < b ? [`crop offset ${spec.offsetMm} mm is inside the ${b} mm bleed; marks start at the bleed edge`] : [];
  return {
    value: [
      seg(-near, 0, -far, 0),
      seg(0, -near, 0, -far),
      seg(w + near, 0, w + far, 0),
      seg(w, -near, w, -far),
      seg(w + near, h, w + far, h),
      seg(w, h + near, w, h + far),
      seg(-near, h, -far, h),
      seg(0, h + near, 0, h + far),
    ],
    warnings,
  };
}

export function trimSegments(item: ItemBox): Segment[] {
  const { widthMm: w, heightMm: h } = item;
  return [seg(0, 0, w, 0), seg(w, 0, w, h), seg(w, h, 0, h), seg(0, h, 0, 0)];
}

/** One line per edge at `offsetMm` from it (positive = inside the trim). */
export function edgeLineSegments(item: ItemBox, edges: readonly Edge[], offsetMm: number): LocalResult<Segment[]> {
  const { widthMm: w, heightMm: h } = item;
  const byEdge: Record<Edge, Segment> = {
    bottom: seg(0, offsetMm, w, offsetMm),
    top: seg(0, h - offsetMm, w, h - offsetMm),
    left: seg(offsetMm, 0, offsetMm, h),
    right: seg(w - offsetMm, 0, w - offsetMm, h),
  };
  const warnings =
    offsetMm > Math.min(w, h) / 2 ? [`line offset ${offsetMm} mm is more than half the ${w} x ${h} mm item`] : [];
  return { value: edges.map((e) => byEdge[e]), warnings };
}

export interface FoldGeometry {
  readonly line: Segment;
  readonly ticks: Segment[];
}

export function foldSegments(item: ItemBox, spec: FoldLine): LocalResult<FoldGeometry> {
  const { widthMm: w, heightMm: h, bleedMm: b } = item;
  const p = spec.positionMm;
  const near = Math.max(spec.tickOffsetMm, b);
  const far = near + spec.tickLengthMm;
  const vertical = spec.axis === "vertical";
  const extent = vertical ? w : h;
  const warnings = p < 0 || p > extent ? [`fold position ${p} mm is outside the ${extent} mm trim`] : [];
  const line = vertical ? seg(p, 0, p, h) : seg(0, p, w, p);
  const ticks = !spec.ticks
    ? []
    : vertical
      ? [seg(p, -near, p, -far), seg(p, h + near, p, h + far)]
      : [seg(-near, p, -far, p), seg(w + near, p, w + far, p)];
  return { value: { line, ticks }, warnings };
}

export function anchorPoint(item: ItemBox, anchor: Anchor): Point {
  const { widthMm: w, heightMm: h } = item;
  const x = anchor.endsWith("left") ? 0 : anchor.endsWith("right") ? w : w / 2;
  const y = anchor.startsWith("top") ? h : anchor.startsWith("bottom") ? 0 : h / 2;
  return { x, y };
}

function repeatAlongEdge(length: number, inset: number, interval: number): number[] {
  const out: number[] = [];
  for (let s = inset; s <= length - inset + 1e-9; s += interval) out.push(s);
  return out.length > 0 ? out : [length / 2];
}

/** Centres of a custom symbol in the item-local frame. */
export function customCenters(item: ItemBox, spec: CustomMark): Point[] {
  const [dx, dy] = spec.offsetMm;
  const { widthMm: w, heightMm: h } = item;
  let base: Point[];
  if (spec.anchors) {
    base = spec.anchors.map((a) => anchorPoint(item, a));
  } else {
    const r = spec.repeat!;
    const i = r.insetMm;
    const enabled = new Set(r.edges);
    base = [];
    if (enabled.has("bottom")) base.push(...repeatAlongEdge(w, i, r.intervalMm).map((x) => ({ x, y: i })));
    if (enabled.has("right")) base.push(...repeatAlongEdge(h, i, r.intervalMm).map((y) => ({ x: w - i, y })));
    if (enabled.has("top")) base.push(...repeatAlongEdge(w, i, r.intervalMm).map((x) => ({ x, y: h - i })));
    if (enabled.has("left")) base.push(...repeatAlongEdge(h, i, r.intervalMm).map((y) => ({ x: i, y })));
  }
  return uniquePoints(base.map((p) => ({ x: p.x + dx, y: p.y + dy })));
}
