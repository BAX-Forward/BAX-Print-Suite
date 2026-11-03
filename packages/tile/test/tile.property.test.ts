import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { tile, type Panel, type RectMm, type SeamTreatment } from "../src/index.js";

const EPS = 1e-6;

/** Fixed so a failure or a slow case reproduces; change it to explore other inputs. */
const SEED = 9009;

const area = (r: RectMm): number => r.width * r.height;

function interiorsOverlap(a: RectMm, b: RectMm): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > EPS && h > EPS;
}

function insideArtwork(r: RectMm, widthMm: number, heightMm: number): boolean {
  return r.x >= -EPS && r.y >= -EPS && r.x + r.width <= widthMm + EPS && r.y + r.height <= heightMm + EPS;
}

/** Ids of the first pair of panels whose visible interiors overlap, if any. */
function firstOverlap(panels: readonly Panel[]): [string, string] | undefined {
  // Sweep by left edge: only panels starting before `a`'s right edge can overlap it,
  // so a grid of thousands of panels costs about panels × rows, not panels².
  const sorted = [...panels].sort((a, b) => a.visible.x - b.visible.x);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.visible.x >= a.visible.x + a.visible.width - EPS) break;
      if (interiorsOverlap(a.visible, b.visible)) return [a.id, b.id];
    }
  }
  return undefined;
}

/** Visible areas cover the artwork exactly once: contained, pairwise disjoint, and areas sum to the whole. */
function expectExactCover(panels: readonly Panel[], widthMm: number, heightMm: number): void {
  expect(panels.filter((p) => !insideArtwork(p.visible, widthMm, heightMm)).map((p) => p.id)).toEqual([]);
  expect(firstOverlap(panels)).toBeUndefined();
  const total = panels.reduce((s, p) => s + area(p.visible), 0);
  expect(Math.abs(total - widthMm * heightMm)).toBeLessThanOrEqual(EPS * widthMm * heightMm);
}

/** Sorted, distinct seams as thousandths of the length, so neighbours are at least length / 1000 apart. */
const seamFractions = fc
  .uniqueArray(fc.integer({ min: 1, max: 999 }), { maxLength: 7 })
  .map((ks) => [...ks].sort((a, b) => a - b));

const pageArb = fc.record({
  widthMm: fc.integer({ min: 200, max: 20_000 }),
  heightMm: fc.integer({ min: 200, max: 10_000 }),
});

/** Overlap or butt treatments whose overlap stays under the narrowest panel. */
function treatmentArb(maxOverlap: number): fc.Arbitrary<SeamTreatment> {
  return fc.oneof(
    fc.constant<SeamTreatment>({ kind: "butt" }),
    fc.double({ min: 0, max: maxOverlap, noNaN: true }).map<SeamTreatment>((overlapMm) => ({ kind: "overlap", overlapMm })),
  );
}

function minGap(length: number, seams: readonly number[]): number {
  const edges = [0, ...seams, length];
  return Math.min(...edges.slice(1).map((e, i) => e - edges[i]));
}

describe("tile() properties", () => {
  it("custom seams: visible areas tile the artwork exactly, and seams are preserved", () => {
    const arb = fc
      .record({ page: pageArb, kx: seamFractions, ky: seamFractions })
      .chain(({ page, kx, ky }) => {
        const seamsX = kx.map((k) => (k * page.widthMm) / 1000);
        const seamsY = ky.map((k) => (k * page.heightMm) / 1000);
        const maxOverlap = Math.min(minGap(page.widthMm, seamsX), minGap(page.heightMm, seamsY));
        return fc.record({
          page: fc.constant(page),
          seamsX: fc.constant(seamsX),
          seamsY: fc.constant(seamsY),
          tx: fc.array(treatmentArb(maxOverlap), { minLength: seamsX.length, maxLength: seamsX.length }),
          ty: fc.array(treatmentArb(maxOverlap), { minLength: seamsY.length, maxLength: seamsY.length }),
          bleedMm: fc.double({ min: 0, max: 20, noNaN: true }),
        });
      });

    fc.assert(
      fc.property(arb, ({ page, seamsX, seamsY, tx, ty, bleedMm }) => {
        const result = tile(page, {
          grid: { mode: "count", columns: 1, rows: 1 },
          seamsX,
          seamsY,
          seamTreatmentsX: tx,
          seamTreatmentsY: ty,
          bleedMm,
        });

        expect(result.ok).toBe(true);
        expect(result.seamsX).toEqual(seamsX);
        expect(result.seamsY).toEqual(seamsY);
        expect(result.panels).toHaveLength((seamsX.length + 1) * (seamsY.length + 1));
        expectExactCover(result.panels, page.widthMm, page.heightMm);

        // Every inner visible edge sits exactly on a seam.
        const left = new Set(result.panels.filter((p) => p.col > 1).map((p) => p.visible.x));
        expect([...left].sort((a, b) => a - b)).toEqual(seamsX);

        // Printed = visible + overlap + bleed on every side.
        for (const p of result.panels) {
          expect(p.printed.x).toBeCloseTo(p.visible.x - p.overlapMm.left - bleedMm, 9);
          expect(p.printed.width).toBeCloseTo(p.visible.width + p.overlapMm.left + p.overlapMm.right + 2 * bleedMm, 9);
          expect(p.printed.height).toBeCloseTo(p.visible.height + p.overlapMm.bottom + p.overlapMm.top + 2 * bleedMm, 9);
        }
      }),
      { numRuns: 200, seed: SEED },
    );
  });

  it("size grids: every printed panel fits the user, device and medium limits", () => {
    const arb = fc.record({
      page: pageArb,
      overlapMm: fc.integer({ min: 0, max: 60 }),
      bleedMm: fc.integer({ min: 0, max: 10 }),
      accounting: fc.constantFrom("visible" as const, "printed" as const),
      maxWidthMm: fc.option(fc.integer({ min: 100, max: 5000 }), { nil: undefined }),
      maxHeightMm: fc.option(fc.integer({ min: 100, max: 5000 }), { nil: undefined }),
      printableWidthMm: fc.option(fc.integer({ min: 300, max: 3200 }), { nil: undefined }),
      mediaWidthMm: fc.option(fc.integer({ min: 300, max: 3200 }), { nil: undefined }),
      maxLengthMm: fc.option(fc.integer({ min: 300, max: 50_000 }), { nil: undefined }),
    });

    fc.assert(
      fc.property(arb, (c) => {
        const limits = { printableWidthMm: c.printableWidthMm, mediaWidthMm: c.mediaWidthMm, maxLengthMm: c.maxLengthMm };
        const result = tile(
          c.page,
          {
            grid: { mode: "size", maxWidthMm: c.maxWidthMm, maxHeightMm: c.maxHeightMm },
            accounting: c.accounting,
            seam: { kind: "overlap", overlapMm: c.overlapMm },
            bleedMm: c.bleedMm,
          },
          limits,
        );

        if (!result.ok) {
          // The only acceptable failure for valid input: no grid fits.
          expect(result.issues.map((i) => i.code)).toContain("no-grid-fits");
          return;
        }
        const across = Math.min(c.printableWidthMm ?? Infinity, c.mediaWidthMm ?? Infinity);
        const along = c.maxLengthMm ?? Infinity;
        for (const p of result.panels) {
          const measured = c.accounting === "visible" ? p.visible : p.printed;
          expect(measured.width).toBeLessThanOrEqual((c.maxWidthMm ?? Infinity) + EPS);
          expect(measured.height).toBeLessThanOrEqual((c.maxHeightMm ?? Infinity) + EPS);
          expect(p.printed.width).toBeLessThanOrEqual(across + EPS);
          expect(p.printed.height).toBeLessThanOrEqual(along + EPS);
        }
        expectExactCover(result.panels, c.page.widthMm, c.page.heightMm);
      }),
      // Unsatisfiable cases search up to the per-axis maximum, so keep the run count moderate.
      { numRuns: 100, seed: SEED },
    );
  });

  it("size grids: the largest generated grid (200 × 100 panels) checks in reasonable time", () => {
    // Regression: the pairwise cover check was quadratic and hung on grids this size.
    const page = { widthMm: 20_000, heightMm: 10_000 };
    const result = tile(page, {
      grid: { mode: "size", maxWidthMm: 100, maxHeightMm: 100 },
      accounting: "visible",
      seam: { kind: "overlap", overlapMm: 0 },
      bleedMm: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.columns).toBe(200);
    expect(result.rows).toBe(100);
    expectExactCover(result.panels, page.widthMm, page.heightMm);
  });

  it("gap seams: visible areas plus the gap strips cover the artwork", () => {
    fc.assert(
      fc.property(pageArb, fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 30 }), (page, columns, gapMm) => {
        const result = tile(page, { grid: { mode: "count", columns, rows: 1 }, seam: { kind: "gap", gapMm } });

        expect(result.ok).toBe(true);
        const visible = result.panels.reduce((s, p) => s + p.visible.width, 0);
        expect(visible + (columns - 1) * gapMm).toBeCloseTo(page.widthMm, 6);
      }),
      { seed: SEED },
    );
  });
});
