import { describe, expect, it } from "vitest";
import { perfectInstances, PERFECT_SIZES, shopMix } from "./generate.js";
import { loadThresholds, runInstance, summarize } from "./measure.js";

const thresholds = loadThresholds();
const auto = { algorithm: "auto" } as const;

describe("utilization thresholds (auto, generated instances)", () => {
  const small = PERFECT_SIZES.filter((n) => n <= thresholds.perfectSmall.maxN);
  const large = PERFECT_SIZES.filter(
    (n) => n >= thresholds.perfectLarge.minN && n <= thresholds.perfectLarge.maxN,
  );

  it.each(small)("perfect packings, n = %i: mean length/optimum within limit", (n) => {
    const results = perfectInstances([n]).map((instance) => runInstance(instance, auto, thresholds.timeBudgetMs));
    expect(results.every((r) => r.unplaced === 0)).toBe(true);
    const summary = summarize(results);
    expect(summary.meanLengthRatio).toBeDefined();
    expect(summary.meanLengthRatio ?? Infinity).toBeLessThanOrEqual(thresholds.perfectSmall.maxMeanLengthRatio);
  });

  it.each(large)("perfect packings, n = %i: mean and worst utilization within limits", (n) => {
    const results = perfectInstances([n]).map((instance) => runInstance(instance, auto, thresholds.timeBudgetMs));
    expect(results.every((r) => r.unplaced === 0)).toBe(true);
    const summary = summarize(results);
    expect(summary.meanUtilization).toBeGreaterThanOrEqual(thresholds.perfectLarge.minMeanUtilization);
    expect(summary.worstUtilization).toBeGreaterThanOrEqual(thresholds.perfectLarge.minWorstUtilization);
  });

  it("shop-like mix: utilization within limit", () => {
    const instance = shopMix(1, thresholds.shopMix.items);
    const copies = instance.items.reduce((sum, item) => sum + item.quantity, 0);
    expect(copies).toBe(thresholds.shopMix.items);
    const result = runInstance(instance, auto, thresholds.timeBudgetMs);
    expect(result.unplaced).toBe(0);
    expect(result.utilization).toBeGreaterThanOrEqual(thresholds.shopMix.minUtilization);
  });
});
