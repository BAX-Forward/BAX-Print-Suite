import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nest } from "../src/index.js";
import type { Algorithm, NestItem, NestOptions, RollMedia, Rotation } from "../src/types.js";
import { layoutViolations } from "./helpers.js";

const RUNS = 1000;
const ALGORITHMS: readonly Algorithm[] = ["maxrects", "skyline", "auto"];
const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

const size = fc.integer({ min: 1, max: 400 });

const lockArb: fc.Arbitrary<NestItem["lock"]> = fc.oneof(
  { weight: 4, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.record({ grain: fc.constantFrom("along-roll" as const, "across-roll" as const) }) },
  { weight: 1, arbitrary: fc.record({ orientation: fc.constantFrom(...ROTATIONS) }) },
);

const itemsArb: fc.Arbitrary<NestItem[]> = fc
  .array(
    fc.record({
      widthPt: size,
      heightPt: size,
      quantity: fc.integer({ min: 1, max: 3 }),
      rotation: fc.constantFrom("none" as const, "90" as const, "any" as const),
      bleedPt: fc.constantFrom(0, 0, 3, 9),
      lock: lockArb,
    }),
    { minLength: 0, maxLength: 12 },
  )
  .map((records) =>
    records.map(({ lock, ...record }, i): NestItem => ({ id: `i${i}`, ...record, ...(lock ? { lock } : {}) })),
  );

const mediaArb: fc.Arbitrary<RollMedia> = fc
  .record({
    widthPt: fc.integer({ min: 50, max: 1200 }),
    side: fc.integer({ min: 0, max: 20 }),
    lead: fc.integer({ min: 0, max: 20 }),
    maxLength: fc.option(fc.integer({ min: 100, max: 1500 }), { nil: undefined }),
  })
  .map(({ widthPt, side, lead, maxLength }) => ({
    widthPt,
    margins: { left: side, right: side, lead, trail: lead },
    ...(maxLength !== undefined ? { maxLengthPt: maxLength } : {}),
  }));

const gutterArb = fc.constantFrom(0, 0, 2, 7.5, 14);

describe.each(ALGORITHMS)("%s: random layouts", (algorithm) => {
  it(`has no overlaps, stays inside the usable area and accounts for every copy (${RUNS} cases)`, () => {
    fc.assert(
      fc.property(mediaArb, itemsArb, gutterArb, (media, items, gutterPt) => {
        const opts: NestOptions = { gutterPt, algorithm, seed: 5, timeBudgetMs: 60_000, maxIterations: 20 };
        const layout = nest(media, items, opts);

        expect(layoutViolations(layout, media, gutterPt)).toEqual([]);

        const expected = items.reduce((sum, i) => sum + i.quantity, 0);
        const unplaced = layout.unplaced.reduce((sum, u) => sum + u.copies, 0);
        expect(layout.placements.length + unplaced).toBe(expected);

        const byId = new Map(items.map((i) => [i.id, i]));
        for (const p of layout.placements) {
          const source = byId.get(p.itemId);
          if (!source) throw new Error(`unknown item ${p.itemId}`);
          const bleed = source.bleedPt ?? 0;
          const turned = p.rotation === 90 || p.rotation === 270;
          const w = (turned ? source.heightPt : source.widthPt) + 2 * bleed;
          const h = (turned ? source.widthPt : source.heightPt) + 2 * bleed;
          expect(p.footprint).toEqual({ w, h });
          if (source.lock?.orientation !== undefined) expect(p.rotation).toBe(source.lock.orientation);
          else if (source.lock?.grain === "along-roll") expect([0, 180]).toContain(p.rotation);
          else if (source.lock?.grain === "across-roll") expect([90, 270]).toContain(p.rotation);
          else if (source.rotation === "none") expect(p.rotation).toBe(0);
          else if (source.rotation === "90") expect([0, 90]).toContain(p.rotation);
        }

        expect(layout.utilization).toBeGreaterThanOrEqual(0);
        expect(layout.utilization).toBeLessThanOrEqual(1 + 1e-9);
      }),
      { numRuns: RUNS, seed: 20_260_301 },
    );
  });
});
