import { createRng, type Rng } from "../src/rng.js";
import type { NestItem, RollMedia } from "../src/types.js";
import { POINTS_PER } from "../src/units.js";

export interface BenchInstance {
  readonly name: string;
  readonly family: "perfect" | "shop";
  readonly n: number;
  readonly seed: number;
  readonly media: RollMedia;
  readonly items: readonly NestItem[];
  /** Known optimal strip length (perfect packings only). */
  readonly optimumPt?: number;
}

export const PERFECT_SIZES: readonly number[] = [10, 25, 50, 100, 200];
export const PERFECT_SEEDS = 10;
export const PERFECT_WIDTH_PT = 1000;
export const PERFECT_LENGTH_PT = 1000;
export const SHOP_ROLL_PT = 1626 * POINTS_PER.mm;
export const SHOP_ITEMS = 40;

const NO_MARGINS = { left: 0, right: 0, lead: 0, trail: 0 };
/** Cuts land between 25% and 75% of the side, which avoids slivers. */
const CUT_MIN_SHARE = 0.25;
const CUT_SPAN_SHARE = 0.5;
const MAX_SHOP_QUANTITY = 20;

/** Common shop print sizes in inches (posters, signs, a 2 × 6 ft banner). */
const SHOP_SIZES_IN: readonly (readonly [number, number])[] = [
  [24, 36],
  [18, 24],
  [11, 17],
  [36, 48],
  [24, 72],
];

interface Box {
  readonly w: number;
  readonly h: number;
}

function shuffle<T>(values: readonly T[], rng: Rng): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = result[i] as T;
    result[i] = result[j] as T;
    result[j] = a;
  }
  return result;
}

/**
 * Perfect packing with a known optimum: recursively guillotine-cuts a W × L
 * strip (integer points) into n rectangles, largest first along its longer
 * side, then shuffles them. The optimal length is L (100% utilization).
 */
export function perfectPacking(n: number, seed: number): BenchInstance {
  const rng = createRng(seed * 7919 + n);
  let boxes: Box[] = [{ w: PERFECT_WIDTH_PT, h: PERFECT_LENGTH_PT }];
  while (boxes.length < n) {
    let index = 0;
    boxes.forEach((box, i) => {
      const current = boxes[index] as Box;
      if (box.w * box.h > current.w * current.h) index = i;
    });
    const box = boxes[index] as Box;
    const side = Math.max(box.w, box.h);
    if (side < 2) break;
    const cut = Math.min(side - 1, Math.max(1, Math.round(side * (CUT_MIN_SHARE + CUT_SPAN_SHARE * rng()))));
    const parts: Box[] =
      box.w >= box.h
        ? [
            { w: cut, h: box.h },
            { w: box.w - cut, h: box.h },
          ]
        : [
            { w: box.w, h: cut },
            { w: box.w, h: box.h - cut },
          ];
    boxes = [...boxes.slice(0, index), ...parts, ...boxes.slice(index + 1)];
  }
  const items = shuffle(boxes, rng).map(
    (box, i): NestItem => ({ id: `p${i}`, widthPt: box.w, heightPt: box.h, quantity: 1, rotation: "any" }),
  );
  return {
    name: `perfect-n${n}-s${seed}`,
    family: "perfect",
    n,
    seed,
    media: { widthPt: PERFECT_WIDTH_PT, margins: NO_MARGINS },
    items,
    optimumPt: PERFECT_LENGTH_PT,
  };
}

/** Shop-like mix on a 1626 mm (64 in) roll: common sizes at quantities 1–20, `count` copies in total. */
export function shopMix(seed: number, count = SHOP_ITEMS): BenchInstance {
  const rng = createRng(seed * 104_729 + count);
  const items: NestItem[] = [];
  let remaining = count;
  while (remaining > 0) {
    const [w, h] = SHOP_SIZES_IN[Math.floor(rng() * SHOP_SIZES_IN.length)] ?? [24, 36];
    const quantity = 1 + Math.floor(rng() * Math.min(MAX_SHOP_QUANTITY, remaining));
    items.push({
      id: `s${items.length}-${w}x${h}`,
      widthPt: w * POINTS_PER.in,
      heightPt: h * POINTS_PER.in,
      quantity,
      rotation: "any",
    });
    remaining -= quantity;
  }
  return {
    name: `shop-${count}-s${seed}`,
    family: "shop",
    n: count,
    seed,
    media: { widthPt: SHOP_ROLL_PT, margins: NO_MARGINS },
    items,
  };
}

export function perfectInstances(sizes: readonly number[] = PERFECT_SIZES, seeds = PERFECT_SEEDS): BenchInstance[] {
  return sizes.flatMap((n) => Array.from({ length: seeds }, (_, seed) => perfectPacking(n, seed + 1)));
}
