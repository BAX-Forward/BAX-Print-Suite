import { describe, expect, it } from "vitest";
import { createNester, layoutToJson, nest } from "../src/index.js";
import { createRng } from "../src/rng.js";
import type { Algorithm, NestItem, NestOptions } from "../src/types.js";
import { INCH, item, layoutViolations, roll } from "./helpers.js";

const ALGORITHMS: readonly Algorithm[] = ["maxrects", "skyline", "auto"];

function options(algorithm: Algorithm, extra: Partial<NestOptions> = {}): NestOptions {
  // A generous time budget with an iteration cap keeps `auto` machine-independent.
  return { gutterPt: 0, algorithm, seed: 7, timeBudgetMs: 60_000, maxIterations: 200, ...extra };
}

describe.each(ALGORITHMS)("%s: trivial cases", (algorithm) => {
  it("packs four 10 in squares on a 20 in roll into 20 in at 100%", () => {
    const layout = nest(roll(20 * INCH), [item("sq", 10 * INCH, 10 * INCH, { quantity: 4 })], options(algorithm));
    expect(layout.placements).toHaveLength(4);
    expect(layout.lengthUsedPt).toBeCloseTo(20 * INCH, 9);
    expect(layout.utilization).toBeCloseTo(1, 9);
    expect(layout.unplaced).toEqual([]);
    expect(layout.placements.map((p) => p.copy)).toEqual([0, 1, 2, 3]);
  });

  it("reports an item wider than the roll in every allowed rotation as too-wide", () => {
    const layout = nest(roll(25 * INCH), [item("big", 30 * INCH, 26 * INCH, { rotation: "any" })], options(algorithm));
    expect(layout.placements).toEqual([]);
    expect(layout.unplaced).toEqual([{ itemId: "big", reason: "too-wide", copies: 1 }]);
    expect(layout.lengthUsedPt).toBe(0);
    expect(layout.utilization).toBe(0);
  });

  it("rotates a 30 × 20 in item onto a 25 in roll when rotation is '90'", () => {
    const layout = nest(roll(25 * INCH), [item("wide", 30 * INCH, 20 * INCH, { rotation: "90" })], options(algorithm));
    expect(layout.unplaced).toEqual([]);
    expect(layout.placements).toHaveLength(1);
    const [placement] = layout.placements;
    expect(placement?.rotation).toBe(90);
    expect(placement?.footprint).toEqual({ w: 20 * INCH, h: 30 * INCH });
    expect(layout.lengthUsedPt).toBeCloseTo(30 * INCH, 9);
  });

  it("does not rotate the same item when rotation is 'none'", () => {
    const layout = nest(roll(25 * INCH), [item("wide", 30 * INCH, 20 * INCH)], options(algorithm));
    expect(layout.unplaced).toEqual([{ itemId: "wide", reason: "too-wide", copies: 1 }]);
  });
});

describe.each(ALGORITHMS)("%s: locks", (algorithm) => {
  const mixed = (lock: NestItem["lock"]): NestItem[] => {
    const rng = createRng(11);
    return Array.from({ length: 30 }, (_, i) =>
      item(`l${i}`, (2 + Math.floor(rng() * 20)) * INCH, (2 + Math.floor(rng() * 20)) * INCH, {
        rotation: "any",
        ...(lock ? { lock } : {}),
      }),
    );
  };

  it("never turns grain: along-roll items to 90 or 270", () => {
    const layout = nest(roll(40 * INCH), mixed({ grain: "along-roll" }), options(algorithm));
    expect(layout.placements).toHaveLength(30);
    for (const p of layout.placements) expect([0, 180]).toContain(p.rotation);
  });

  it("always turns grain: across-roll items to 90 or 270", () => {
    const layout = nest(roll(40 * INCH), mixed({ grain: "across-roll" }), options(algorithm));
    expect(layout.placements).toHaveLength(30);
    for (const p of layout.placements) expect([90, 270]).toContain(p.rotation);
  });

  it("honors orientation: 180 (overriding rotation and grain)", () => {
    const items = [
      item("upside", 10 * INCH, 4 * INCH, { rotation: "none", lock: { orientation: 180 } }),
      item("both", 10 * INCH, 4 * INCH, { rotation: "any", lock: { grain: "across-roll", orientation: 180 } }),
    ];
    const layout = nest(roll(30 * INCH), items, options(algorithm));
    expect(layout.placements.map((p) => [p.itemId, p.rotation])).toEqual([
      ["upside", 180],
      ["both", 180],
    ]);
    for (const p of layout.placements) expect(p.footprint).toEqual({ w: 10 * INCH, h: 4 * INCH });
  });

  it("reports locked-orientation when only the lock prevents a fit", () => {
    const items = [item("locked", 30 * INCH, 10 * INCH, { rotation: "any", lock: { grain: "along-roll" } })];
    const layout = nest(roll(25 * INCH), items, options(algorithm));
    expect(layout.unplaced).toEqual([{ itemId: "locked", reason: "locked-orientation", copies: 1 }]);
  });
});

describe.each(ALGORITHMS)("%s: gutter, margins, panels", (algorithm) => {
  it("keeps a gutter between items but lets them touch the margins", () => {
    const gutter = INCH / 2;
    const squares = [item("sq", 10 * INCH, 10 * INCH, { quantity: 2 })];
    const tight = nest(roll(20 * INCH), squares, options(algorithm, { gutterPt: gutter }));
    expect(tight.lengthUsedPt).toBeCloseTo(20 * INCH + gutter, 9);
    const roomy = nest(roll(20 * INCH + gutter), squares, options(algorithm, { gutterPt: gutter }));
    expect(roomy.lengthUsedPt).toBeCloseTo(10 * INCH, 9);
    expect(layoutViolations(roomy, roll(20 * INCH + gutter), gutter)).toEqual([]);
    expect(Math.min(...roomy.placements.map((p) => p.xPt))).toBeCloseTo(0, 9);
  });

  it("measures utilization against the usable width (inside the margins)", () => {
    const media = roll(22 * INCH, INCH);
    const layout = nest(media, [item("sq", 10 * INCH, 10 * INCH, { quantity: 4 })], options(algorithm));
    expect(layout.mediaWidthPt).toBe(22 * INCH);
    expect(layout.lengthUsedPt).toBeCloseTo(20 * INCH, 9);
    expect(layout.utilization).toBeCloseTo(1, 9);
    expect(layoutViolations(layout, media, 0)).toEqual([]);
  });

  it("includes bleed in the footprint", () => {
    const layout = nest(roll(30 * INCH), [item("b", 10 * INCH, 5 * INCH, { bleedPt: 9 })], options(algorithm));
    expect(layout.placements[0]?.footprint).toEqual({ w: 10 * INCH + 18, h: 5 * INCH + 18 });
  });

  it("continues on a new panel past maxLengthPt and reports items longer than it", () => {
    const media = roll(10 * INCH, 0, 25 * INCH);
    const items = [item("sq", 10 * INCH, 10 * INCH, { quantity: 3 }), item("tall", 5 * INCH, 26 * INCH)];
    const layout = nest(media, items, options(algorithm));
    expect(layout.panels).toEqual([
      { index: 0, offsetPt: 0, lengthPt: 20 * INCH },
      { index: 1, offsetPt: 20 * INCH, lengthPt: 10 * INCH },
    ]);
    expect(layout.lengthUsedPt).toBeCloseTo(30 * INCH, 9);
    expect(layout.placements.map((p) => p.panel).sort()).toEqual([0, 0, 1]);
    expect(layout.unplaced).toEqual([{ itemId: "tall", reason: "max-length", copies: 1 }]);
    expect(layoutViolations(layout, media, 0)).toEqual([]);
  });
});

describe("input validation", () => {
  it("reports invalid sizes instead of throwing", () => {
    const items = [
      item("nan", Number.NaN, 10),
      item("neg", -5, 10),
      item("zero", 10, 0),
      item("bleed", 10, 10, { bleedPt: -1 }),
      item("ok", 10, 10),
      item("none", 10, 10, { quantity: 0 }),
    ];
    const layout = nest(roll(100), items, options("maxrects"));
    expect(layout.unplaced.map((u) => [u.itemId, u.reason])).toEqual([
      ["nan", "invalid-size"],
      ["neg", "invalid-size"],
      ["zero", "invalid-size"],
      ["bleed", "invalid-size"],
    ]);
    expect(layout.placements.map((p) => p.itemId)).toEqual(["ok"]);
  });

  it("survives a nonsensical roll and options", () => {
    const bad = { widthPt: Number.NaN, margins: { left: -1, right: Infinity, lead: 0, trail: 0 } };
    const opts = { gutterPt: Number.NaN, algorithm: "bogus" as Algorithm, heuristic: "nope", seed: Number.NaN };
    const layout = nest(bad, [item("a", 10, 10)], opts);
    expect(layout.placements).toEqual([]);
    expect(layout.unplaced[0]?.reason).toBe("too-wide");
  });

  it("falls back to default heuristics for unknown names", () => {
    const layout = nest(roll(100), [item("a", 10, 10)], options("skyline", { heuristic: "BOGUS" }));
    expect(layout.algorithm).toBe("skyline/bl/area-desc");
  });
});

describe("determinism", () => {
  const rng = createRng(3);
  const items = Array.from({ length: 60 }, (_, i) =>
    item(`d${i}`, (1 + Math.floor(rng() * 30)) * INCH, (1 + Math.floor(rng() * 30)) * INCH, {
      rotation: i % 3 === 0 ? "none" : "any",
      quantity: 1 + (i % 3),
      bleedPt: i % 4 === 0 ? 9 : 0,
    }),
  );

  it.each(ALGORITHMS)("%s gives byte-identical layout JSON for the same input and seed", (algorithm) => {
    const media = roll(64 * INCH, 18);
    const opts = options(algorithm, { gutterPt: 14 });
    const first = layoutToJson(nest(media, items, opts));
    const second = layoutToJson(nest(media, structuredClone(items), { ...opts }));
    expect(second).toBe(first);
    expect(first).not.toContain("elapsedMs");
  });

  it("includes timing only on request", () => {
    const layout = nest(roll(100), [item("a", 10, 10)], options("maxrects"));
    expect(layoutToJson(layout, { timing: true })).toContain("elapsedMs");
  });
});

describe("nesters", () => {
  it("exposes rectangle nesters behind the Nester interface", () => {
    for (const algorithm of ALGORITHMS) {
      const nester = createNester(algorithm);
      expect(nester.id).toBe(algorithm);
      expect(nester.supportsShapes).toBe(false);
    }
  });

  it("ignores item shapes in the rectangle phase", () => {
    const shape = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]];
    const layout = nest(roll(100), [item("tri", 10, 10, { shape })], options("auto"));
    expect(layout.placements[0]?.footprint).toEqual({ w: 10, h: 10 });
  });
});
