import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nest } from "../src/index.js";
import { createRng } from "../src/rng.js";
import type { NestItem, NestOptions } from "../src/types.js";
import { INCH, layoutViolations, roll } from "./helpers.js";

interface PerfThreshold {
  readonly maxMs: number;
  readonly ciFactor: number;
}

const thresholds = JSON.parse(
  readFileSync(new URL("../bench/thresholds.json", import.meta.url), "utf8"),
) as { maxrectsBssf500: PerfThreshold };

function shopItems(count: number, seed: number): NestItem[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    widthPt: (4 + Math.floor(rng() * 40)) * INCH,
    heightPt: (4 + Math.floor(rng() * 40)) * INCH,
    quantity: 1,
    rotation: "any",
  }));
}

describe("performance", () => {
  it("runs MaxRects BSSF on 500 items within the time limit", () => {
    const media = roll(64 * INCH, 18);
    const items = shopItems(500, 42);
    const opts: NestOptions = { gutterPt: 7, algorithm: "maxrects", heuristic: "bssf" };
    nest(media, items, opts); // warm-up (JIT)

    const runs = 3;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      const layout = nest(media, items, opts);
      best = Math.min(best, performance.now() - start);
      expect(layout.placements).toHaveLength(500);
      if (i === 0) expect(layoutViolations(layout, media, 7)).toEqual([]);
    }
    const { maxMs, ciFactor } = thresholds.maxrectsBssf500;
    const limit = process.env.CI ? maxMs * ciFactor : maxMs;
    expect(best).toBeLessThan(limit);
  });
});
