import { EPS, type Rect } from "./geometry.js";
import type { PackInput, PackOutput } from "./pack.js";
import type { MaxRectsHeuristic } from "./types.js";

interface Candidate extends Rect {
  readonly o: number;
  readonly growth: number;
  readonly primary: number;
  readonly secondary: number;
}

/**
 * MaxRects (Jylänki 2010): maximal free-rectangle list with split and prune.
 *
 * Strip adaptation: the bin is W × (max length or a safe upper bound), so free
 * rectangles are very tall. Candidates are therefore ranked first by how much
 * they grow the used strip length, and the heuristics measure the leftover
 * height against the current strip top instead of the bin top.
 */
export function packMaxRects(input: PackInput, heuristic: MaxRectsHeuristic): PackOutput {
  let free: Rect[] = [{ x: 0, y: 0, w: input.binW, h: input.binH }];
  let top = 0;
  return input.pieces.map((options) => {
    let best: Candidate | undefined;
    for (const rect of free) {
      for (const option of options) {
        if (option.w > rect.w + EPS || option.h > rect.h + EPS) continue;
        const candidate = score(rect, option.w, option.h, option.o, top, heuristic);
        if (best === undefined || isBetter(candidate, best)) best = candidate;
      }
    }
    if (best === undefined) return undefined;
    free = splitFreeRects(free, best);
    top = Math.max(top, best.y + best.h);
    return { x: best.x, y: best.y, o: best.o };
  });
}

function score(
  rect: Rect,
  w: number,
  h: number,
  o: number,
  top: number,
  heuristic: MaxRectsHeuristic,
): Candidate {
  const rise = rect.y + h - top;
  const growth = rise > EPS ? rise : 0;
  const availableH = growth > 0 ? h : Math.min(rect.h, top - rect.y);
  const leftoverW = rect.w - w;
  const leftoverH = availableH - h;
  const shortSide = Math.min(leftoverW, leftoverH);
  const longSide = Math.max(leftoverW, leftoverH);
  const base = { x: rect.x, y: rect.y, w, h, o, growth };
  switch (heuristic) {
    case "blsf":
      return { ...base, primary: longSide, secondary: shortSide };
    case "baf":
      return { ...base, primary: rect.w * availableH - w * h, secondary: shortSide };
    case "bl":
      return { ...base, primary: rect.y + h, secondary: rect.x };
    default:
      return { ...base, primary: shortSide, secondary: longSide };
  }
}

function isBetter(a: Candidate, b: Candidate): boolean {
  if (a.growth !== b.growth) return a.growth < b.growth;
  if (a.primary !== b.primary) return a.primary < b.primary;
  if (a.secondary !== b.secondary) return a.secondary < b.secondary;
  if (a.y !== b.y) return a.y < b.y;
  return a.x < b.x;
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS
  );
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  );
}

/** Splits every free rect overlapped by `used`, then prunes non-maximal rects. */
function splitFreeRects(free: readonly Rect[], used: Rect): Rect[] {
  const kept: Rect[] = [];
  const created: Rect[] = [];
  const usedRight = used.x + used.w;
  const usedTop = used.y + used.h;
  for (const rect of free) {
    if (!intersects(rect, used)) {
      kept.push(rect);
      continue;
    }
    const rectRight = rect.x + rect.w;
    const rectTop = rect.y + rect.h;
    if (used.y > rect.y + EPS) created.push({ x: rect.x, y: rect.y, w: rect.w, h: used.y - rect.y });
    if (usedTop < rectTop - EPS) created.push({ x: rect.x, y: usedTop, w: rect.w, h: rectTop - usedTop });
    if (used.x > rect.x + EPS) created.push({ x: rect.x, y: rect.y, w: used.x - rect.x, h: rect.h });
    if (usedRight < rectRight - EPS) {
      created.push({ x: usedRight, y: rect.y, w: rectRight - usedRight, h: rect.h });
    }
  }
  // Old rects were maximal, so only new rects can be redundant. Of two equal new
  // rects the earlier one survives.
  const fresh = created.filter(
    (rect, i) =>
      rect.w > EPS &&
      rect.h > EPS &&
      !kept.some((k) => contains(k, rect)) &&
      !created.some((other, j) => j !== i && contains(other, rect) && (!contains(rect, other) || j < i)),
  );
  const survivors = kept.filter((k) => !fresh.some((f) => contains(f, k)));
  return [...survivors, ...fresh];
}
