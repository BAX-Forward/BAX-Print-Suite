import { EPS, type Rect } from "./geometry.js";
import type { PackInput, PackOption, PackOutput } from "./pack.js";
import type { SkylineHeuristic } from "./types.js";

interface Segment {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

interface SkylineFit extends Rect {
  readonly o: number;
  readonly growth: number;
  readonly primary: number;
  readonly secondary: number;
}

interface WasteFit extends Rect {
  readonly index: number;
  readonly o: number;
  readonly areaLeft: number;
  readonly shortLeft: number;
}

/**
 * Skyline (Jylänki 2010) with Bottom-Left or Min-Waste-Fit, plus a waste map:
 * gaps trapped under a placed rectangle become free rectangles that are tried
 * first (best area fit, guillotine split on the shorter leftover axis).
 */
export function packSkyline(input: PackInput, heuristic: SkylineHeuristic): PackOutput {
  const { binW, binH } = input;
  let skyline: Segment[] = [{ x: 0, y: 0, w: binW }];
  let waste: Rect[] = [];
  let top = 0;
  return input.pieces.map((options) => {
    const recycled = bestWasteFit(waste, options);
    if (recycled) {
      waste = splitWaste(waste, recycled);
      return { x: recycled.x, y: recycled.y, o: recycled.o };
    }
    const spot = bestSkylineFit(skyline, options, binW, binH, top, heuristic);
    if (!spot) return undefined;
    waste = [...waste, ...wasteBelow(skyline, spot)];
    skyline = raise(skyline, spot);
    top = Math.max(top, spot.y + spot.h);
    return { x: spot.x, y: spot.y, o: spot.o };
  });
}

function fitAt(
  skyline: readonly Segment[],
  index: number,
  w: number,
  h: number,
  binW: number,
  binH: number,
): { y: number; waste: number } | undefined {
  const start = skyline[index];
  if (!start) return undefined;
  const x = start.x;
  if (x + w > binW + EPS) return undefined;
  let y = 0;
  let end = index;
  while (true) {
    const segment = skyline[end];
    if (!segment) return undefined;
    y = Math.max(y, segment.y);
    end++;
    if (segment.x + segment.w >= x + w - EPS) break;
  }
  if (y + h > binH + EPS) return undefined;
  let waste = 0;
  for (let i = index; i < end; i++) {
    const segment = skyline[i];
    if (!segment) continue;
    const overlap = Math.min(segment.x + segment.w, x + w) - segment.x;
    waste += (y - segment.y) * Math.max(0, overlap);
  }
  return { y, waste };
}

function bestSkylineFit(
  skyline: readonly Segment[],
  options: readonly PackOption[],
  binW: number,
  binH: number,
  top: number,
  heuristic: SkylineHeuristic,
): SkylineFit | undefined {
  let best: SkylineFit | undefined;
  for (const [index, segment] of skyline.entries()) {
    for (const option of options) {
      const fit = fitAt(skyline, index, option.w, option.h, binW, binH);
      if (!fit) continue;
      const roof = fit.y + option.h;
      const growth = roof - top > EPS ? roof - top : 0;
      const base = { x: segment.x, y: fit.y, w: option.w, h: option.h, o: option.o, growth };
      const candidate: SkylineFit =
        heuristic === "mwf"
          ? { ...base, primary: fit.waste, secondary: roof }
          : { ...base, primary: roof, secondary: segment.w };
      if (!best || isBetter(candidate, best)) best = candidate;
    }
  }
  return best;
}

function isBetter(a: SkylineFit, b: SkylineFit): boolean {
  if (a.growth !== b.growth) return a.growth < b.growth;
  if (a.primary !== b.primary) return a.primary < b.primary;
  if (a.secondary !== b.secondary) return a.secondary < b.secondary;
  return a.x < b.x;
}

function bestWasteFit(waste: readonly Rect[], options: readonly PackOption[]): WasteFit | undefined {
  let best: WasteFit | undefined;
  for (const [index, rect] of waste.entries()) {
    for (const option of options) {
      if (option.w > rect.w + EPS || option.h > rect.h + EPS) continue;
      const fit: WasteFit = {
        index,
        x: rect.x,
        y: rect.y,
        w: option.w,
        h: option.h,
        o: option.o,
        areaLeft: rect.w * rect.h - option.w * option.h,
        shortLeft: Math.min(rect.w - option.w, rect.h - option.h),
      };
      if (
        !best ||
        fit.areaLeft < best.areaLeft ||
        (fit.areaLeft === best.areaLeft && fit.shortLeft < best.shortLeft)
      ) {
        best = fit;
      }
    }
  }
  return best;
}

function splitWaste(waste: readonly Rect[], fit: WasteFit): Rect[] {
  const rect = waste[fit.index];
  if (!rect) return [...waste];
  const rightW = rect.w - fit.w;
  const topH = rect.h - fit.h;
  const remainders: Rect[] =
    rightW < topH
      ? [
          { x: rect.x + fit.w, y: rect.y, w: rightW, h: fit.h },
          { x: rect.x, y: rect.y + fit.h, w: rect.w, h: topH },
        ]
      : [
          { x: rect.x + fit.w, y: rect.y, w: rightW, h: rect.h },
          { x: rect.x, y: rect.y + fit.h, w: fit.w, h: topH },
        ];
  return [
    ...waste.slice(0, fit.index),
    ...waste.slice(fit.index + 1),
    ...remainders.filter((r) => r.w > EPS && r.h > EPS),
  ];
}

/** Empty space between the skyline and the bottom of a newly placed rect. */
function wasteBelow(skyline: readonly Segment[], spot: Rect): Rect[] {
  const right = spot.x + spot.w;
  const result: Rect[] = [];
  for (const segment of skyline) {
    const left = Math.max(segment.x, spot.x);
    const end = Math.min(segment.x + segment.w, right);
    if (end - left <= EPS || spot.y - segment.y <= EPS) continue;
    result.push({ x: left, y: segment.y, w: end - left, h: spot.y - segment.y });
  }
  return result;
}

function raise(skyline: readonly Segment[], spot: Rect): Segment[] {
  const right = spot.x + spot.w;
  const raised: Segment = { x: spot.x, y: spot.y + spot.h, w: spot.w };
  const result: Segment[] = [];
  let inserted = false;
  for (const segment of skyline) {
    const end = segment.x + segment.w;
    if (end <= spot.x + EPS) {
      result.push(segment);
      continue;
    }
    if (!inserted) {
      if (segment.x < spot.x - EPS) result.push({ x: segment.x, y: segment.y, w: spot.x - segment.x });
      result.push(raised);
      inserted = true;
    }
    if (end > right + EPS) {
      const start = Math.max(segment.x, right);
      result.push({ x: start, y: segment.y, w: end - start });
    }
  }
  if (!inserted) result.push(raised);
  return merge(result);
}

function merge(segments: readonly Segment[]): Segment[] {
  const result: Segment[] = [];
  for (const segment of segments) {
    if (segment.w <= EPS) continue;
    const last = result[result.length - 1];
    if (last && Math.abs(last.y - segment.y) <= EPS) {
      result[result.length - 1] = { x: last.x, y: last.y, w: segment.x + segment.w - last.x };
    } else {
      result.push(segment);
    }
  }
  return result;
}
