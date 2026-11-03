import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { distributeAlongEdge, grommetPoints } from "../src/index.js";

const EPS = 1e-6;

const gapsOf = (xs: readonly number[]) => xs.slice(1).map((x, i) => x - xs[i]!);

describe("grommet placement", () => {
  it("puts 5 grommets with 4 gaps of 487.5 mm on a 2000 mm edge (inset 25, spacing 600)", () => {
    const xs = distributeAlongEdge(2000, 25, 600);
    expect(xs).toHaveLength(5);
    expect(xs).toEqual([25, 512.5, 1000, 1487.5, 1975]);
    for (const gap of gapsOf(xs)) expect(gap).toBeCloseTo(487.5, 9);
  });

  it("uses one gap when the span is exactly the spacing", () => {
    expect(distributeAlongEdge(650, 25, 600)).toEqual([25, 625]);
  });

  it("falls back to the edge midpoint when the inset leaves no span", () => {
    expect(distributeAlongEdge(40, 25, 600)).toEqual([20]);
  });

  it("property: gaps are equal, never exceed the spacing, use the fewest gaps, and both corners are present", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 50, max: 20_000, noNaN: true }),
        fc.double({ min: 0, max: 0.45, noNaN: true }),
        fc.double({ min: 5, max: 3_000, noNaN: true }),
        (length, insetFraction, spacing) => {
          const inset = length * insetFraction;
          const xs = distributeAlongEdge(length, inset, spacing);
          const span = length - 2 * inset;
          expect(xs[0]).toBeCloseTo(inset, 9);
          expect(xs[xs.length - 1]).toBe(length - inset);
          const gaps = gapsOf(xs);
          expect(gaps.length).toBeGreaterThanOrEqual(1);
          for (const g of gaps) {
            expect(Math.abs(g - gaps[0]!)).toBeLessThan(EPS * Math.max(1, span));
            expect(g).toBeLessThanOrEqual(spacing + EPS);
          }
          if (gaps.length > 1) expect(span / (gaps.length - 1)).toBeGreaterThan(spacing - EPS);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: all four corners carry a grommet and no position repeats", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 100, max: 10_000, noNaN: true }),
        fc.double({ min: 100, max: 10_000, noNaN: true }),
        fc.double({ min: 0, max: 45, noNaN: true }),
        fc.double({ min: 20, max: 2_000, noNaN: true }),
        (w, h, inset, spacing) => {
          const { points, warnings } = grommetPoints(w, h, inset, spacing, ["top", "bottom", "left", "right"]);
          expect(warnings).toEqual([]);
          const has = (x: number, y: number) => points.some((p) => Math.abs(p.x - x) < EPS && Math.abs(p.y - y) < EPS);
          expect(has(inset, inset)).toBe(true);
          expect(has(w - inset, inset)).toBe(true);
          expect(has(w - inset, h - inset)).toBe(true);
          expect(has(inset, h - inset)).toBe(true);
          const keys = points.map((p) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`);
          expect(new Set(keys).size).toBe(points.length);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("counts shared corners once on a full banner (2000 x 1000 mm)", () => {
    const { points } = grommetPoints(2000, 1000, 25, 600, ["top", "bottom", "left", "right"]);
    // 5 per long edge, 3 per short edge, 4 shared corners.
    expect(points).toHaveLength(5 + 5 + 3 + 3 - 4);
  });

  it("only places grommets on the enabled edges", () => {
    const { points } = grommetPoints(2000, 1000, 25, 600, ["top"]);
    expect(points.every((p) => p.y === 975)).toBe(true);
    expect(points).toHaveLength(5);
  });

  it("warns when the inset leaves no room between corners", () => {
    expect(grommetPoints(40, 1000, 25, 600, ["left"]).warnings).toHaveLength(1);
  });
});
