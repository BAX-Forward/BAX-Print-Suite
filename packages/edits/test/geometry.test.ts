import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { JobEdit } from "@bax-print/core";
import {
  EditError,
  applyEdits,
  applyToPoint,
  computeGeometry,
  geometryErrors,
  invert,
  mapColorant,
  matrixDistance,
  mmToPt,
  multiply,
  previewRenderTransform,
  ptToMm,
  type EditedGeometry,
  type Matrix,
  type NestItem,
  type PageSource,
} from "../src/index.js";

const EPSILON = 1e-9;
/** Explicit cap so a property run cannot grow without bound. */
const PROPERTY_RUNS = 100;

const sourceArb: fc.Arbitrary<PageSource> = fc
  .record({
    x0: fc.double({ min: -1000, max: 1000, noNaN: true }),
    y0: fc.double({ min: -1000, max: 1000, noNaN: true }),
    w: fc.double({ min: 1, max: 3000, noNaN: true }),
    h: fc.double({ min: 1, max: 3000, noNaN: true }),
    rotate: fc.constantFrom(0, 90, 180, 270),
    userUnit: fc.constantFrom(1, 2.5),
  })
  .map(({ x0, y0, w, h, rotate, userUnit }) => ({ box: { x0, y0, x1: x0 + w, y1: y0 + h }, rotate, userUnit }));

/** Edits that never fail on any page: no crop. */
const editArb: fc.Arbitrary<JobEdit> = fc.oneof(
  fc.double({ min: 10, max: 400, noNaN: true }).map((percent): JobEdit => ({ kind: "scale", percent })),
  fc.constantFrom(0, 90, 180, 270).map((degrees): JobEdit => ({ kind: "rotate", degrees: degrees as 0 | 90 | 180 | 270 })),
  fc.constantFrom("horizontal", "vertical").map((axis): JobEdit => ({ kind: "mirror", axis: axis as "horizontal" | "vertical" })),
);

const prefixArb = fc.array(editArb, { maxLength: 4 });

function expectSameGeometry(actual: EditedGeometry, expected: EditedGeometry): void {
  expect(matrixDistance(actual.toTrim, expected.toTrim)).toBeLessThan(EPSILON);
  expect(Math.abs(actual.trimWidthPt - expected.trimWidthPt)).toBeLessThan(EPSILON);
  expect(Math.abs(actual.trimHeightPt - expected.trimHeightPt)).toBeLessThan(EPSILON);
  expect(Math.abs(actual.scaleFactor - expected.scaleFactor)).toBeLessThan(EPSILON);
  expect(actual.rotation).toBe(expected.rotation);
  expect(actual.mirrored).toBe(expected.mirrored);
}

describe("applyEdits properties (Spec 007 acceptance 3)", () => {
  it("rotate 90 four times is the identity", () => {
    const rotate: JobEdit = { kind: "rotate", degrees: 90 };
    fc.assert(
      fc.property(sourceArb, prefixArb, (source, prefix) => {
        expectSameGeometry(computeGeometry(source, [...prefix, rotate, rotate, rotate, rotate]), computeGeometry(source, prefix));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("scale then inverse scale is the identity within 1e-9", () => {
    fc.assert(
      fc.property(sourceArb, prefixArb, fc.double({ min: 1, max: 1000, noNaN: true }), (source, prefix, percent) => {
        const edits: JobEdit[] = [...prefix, { kind: "scale", percent }, { kind: "scale", percent: 10_000 / percent }];
        expectSameGeometry(computeGeometry(source, edits), computeGeometry(source, prefix));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("fit to a width, then fit back to the original width, is the identity within 1e-9", () => {
    fc.assert(
      fc.property(sourceArb, fc.double({ min: 10, max: 5000, noNaN: true }), (source, targetMm) => {
        const base = computeGeometry(source);
        const edits: JobEdit[] = [
          { kind: "scale", fit: { dimension: "width", targetMm } },
          { kind: "scale", fit: { dimension: "width", targetMm: ptToMm(base.trimWidthPt) } },
        ];
        expectSameGeometry(computeGeometry(source, edits), base);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("mirror twice is the identity, on either axis", () => {
    fc.assert(
      fc.property(sourceArb, prefixArb, fc.constantFrom("horizontal" as const, "vertical" as const), (source, prefix, axis) => {
        const mirror: JobEdit = { kind: "mirror", axis };
        expectSameGeometry(computeGeometry(source, [...prefix, mirror, mirror]), computeGeometry(source, prefix));
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("the trim frame always covers exactly the edited artwork", () => {
    fc.assert(
      fc.property(sourceArb, prefixArb, (source, edits) => {
        const g = computeGeometry(source, edits);
        const unit = source.userUnit ?? 1;
        const corners = [
          [source.box.x0, source.box.y0],
          [source.box.x1, source.box.y0],
          [source.box.x0, source.box.y1],
          [source.box.x1, source.box.y1],
        ].map(([x, y]) => applyToPoint(g.toTrim, x, y));
        const tolerance = 1e-6 * Math.max(g.trimWidthPt, g.trimHeightPt);
        expect(Math.min(...corners.map((c) => c[0]))).toBeCloseTo(0, 6);
        expect(Math.min(...corners.map((c) => c[1]))).toBeCloseTo(0, 6);
        expect(Math.abs(Math.max(...corners.map((c) => c[0])) - g.trimWidthPt)).toBeLessThan(tolerance);
        expect(Math.abs(Math.max(...corners.map((c) => c[1])) - g.trimHeightPt)).toBeLessThan(tolerance);
        const area = (source.box.x1 - source.box.x0) * (source.box.y1 - source.box.y0) * unit * unit;
        expect(g.trimWidthPt * g.trimHeightPt).toBeCloseTo(area * g.scaleFactor ** 2, 3);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it("applyEdits on a nest item: rotate ×4 and mirror ×2 restore size and shape", () => {
    const item: NestItem = {
      id: "item-1",
      widthPt: 300,
      heightPt: 120,
      quantity: 2,
      rotation: "any",
      shape: [
        [
          { x: 0, y: 0 },
          { x: 300, y: 0 },
          { x: 300, y: 120 },
          { x: 0, y: 120 },
        ],
      ],
    };
    const rotate: JobEdit = { kind: "rotate", degrees: 90 };
    const mirror: JobEdit = { kind: "mirror" };
    for (const edits of [[rotate, rotate, rotate, rotate], [mirror, mirror]]) {
      const result = applyEdits(item, edits);
      expect(result.widthPt).toBeCloseTo(item.widthPt, 9);
      expect(result.heightPt).toBeCloseTo(item.heightPt, 9);
      result.shape?.[0].forEach(({ x, y }, i) => {
        expect(x).toBeCloseTo(item.shape![0][i].x, 9);
        expect(y).toBeCloseTo(item.shape![0][i].y, 9);
      });
    }
  });
});

describe("computeGeometry", () => {
  const a4: PageSource = { box: { x0: 0, y0: 0, x1: mmToPt(210), y1: mmToPt(297) } };

  it("uses the box as given and reports no change without edits", () => {
    const g = computeGeometry({ box: { x0: 10, y0: 20, x1: 110, y1: 70 } });
    expect(g.trimWidthPt).toBe(100);
    expect(g.trimHeightPt).toBe(50);
    expect(applyToPoint(g.toTrim, 10, 20)).toEqual([0, 0]);
    expect(g.scaleFactor).toBe(1);
    expect(g.footprintWidthPt).toBe(100);
  });

  it("rotates clockwise: the source's bottom-left corner ends top-left", () => {
    const g = computeGeometry({ box: { x0: 0, y0: 0, x1: 100, y1: 50 } }, [{ kind: "rotate", degrees: 90 }]);
    expect([g.trimWidthPt, g.trimHeightPt]).toEqual([50, 100]);
    expect(applyToPoint(g.toTrim, 0, 0)).toEqual([0, 100]);
    expect(g.rotation).toBe(90);
  });

  it("applies the page /Rotate before the edits", () => {
    const g = computeGeometry({ box: { x0: 0, y0: 0, x1: 100, y1: 50 }, rotate: 90 }, [{ kind: "rotate", degrees: 270 }]);
    expect([g.trimWidthPt, g.trimHeightPt]).toEqual([100, 50]);
    expect(g.rotation).toBe(0);
  });

  it("mirrors horizontally by default", () => {
    const g = computeGeometry({ box: { x0: 0, y0: 0, x1: 100, y1: 50 } }, [{ kind: "mirror" }]);
    expect(applyToPoint(g.toTrim, 0, 0)).toEqual([100, 0]);
    expect(g.mirrored).toBe(true);
  });

  it("scales by percent and by fit target", () => {
    expect(computeGeometry(a4, [{ kind: "scale", percent: 200 }]).trimWidthPt).toBeCloseTo(mmToPt(420), 9);
    const fit = computeGeometry(a4, [{ kind: "scale", fit: { dimension: "height", targetMm: 594 } }]);
    expect(ptToMm(fit.trimWidthPt)).toBeCloseTo(420, 9);
    expect(fit.scaleFactor).toBeCloseTo(2, 12);
  });

  it("includes UserUnit in the size but not in scaleFactor", () => {
    const g = computeGeometry({ box: { x0: 0, y0: 0, x1: 100, y1: 100 }, userUnit: 10 }, [{ kind: "scale", percent: 50 }]);
    expect(g.trimWidthPt).toBeCloseTo(500, 9);
    expect(g.scaleFactor).toBeCloseTo(0.5, 12);
  });

  it("crops in the current frame and records the visible source region", () => {
    const g = computeGeometry(a4, [{ kind: "crop", box: { xMm: 10, yMm: 20, widthMm: 100, heightMm: 50 } }]);
    expect(ptToMm(g.trimWidthPt)).toBeCloseTo(100, 9);
    expect(ptToMm(g.trimHeightPt)).toBeCloseTo(50, 9);
    expect(ptToMm(g.visibleSource.x0)).toBeCloseTo(10, 9);
    expect(ptToMm(g.visibleSource.y1)).toBeCloseTo(70, 9);
  });

  it("rejects a crop past the artwork with an EditError naming the edit", () => {
    const edits: JobEdit[] = [{ kind: "rotate", degrees: 0 }, { kind: "crop", box: { xMm: 200, yMm: 0, widthMm: 20, heightMm: 10 } }];
    expect(() => computeGeometry(a4, edits)).toThrow(EditError);
    try {
      computeGeometry(a4, edits);
    } catch (error) {
      expect((error as EditError).editIndex).toBe(1);
    }
    expect(geometryErrors([a4, a4], edits)).toEqual([expect.stringContaining("page 1, edits[1]"), expect.stringContaining("page 2, edits[1]")]);
  });

  it("adds bleed around the trim, and the last addBleed wins", () => {
    const g = computeGeometry(a4, [
      { kind: "addBleed", mm: 10, mode: "edge" },
      { kind: "addBleed", mm: 5, mode: "mirror" },
    ]);
    expect(ptToMm(g.footprintWidthPt)).toBeCloseTo(220, 9);
    expect(g.bleedMode).toBe("mirror");
    expect(ptToMm(g.trimOriginX)).toBeCloseTo(5, 9);
    expect(computeGeometry(a4, [{ kind: "addBleed", mm: 5, mode: "edge" }, { kind: "addBleed", mm: 0, mode: "edge" }]).bleedMode).toBeNull();
  });

  it("centres the trim inside a pageSize override", () => {
    const g = computeGeometry(a4, [{ kind: "pageSize", widthMm: 250, heightMm: 300 }]);
    expect(g.pageSizeOverride).toBe(true);
    expect(ptToMm(g.trimOriginX)).toBeCloseTo(20, 9);
    expect(ptToMm(g.trimOriginY)).toBeCloseTo(1.5, 9);
    expect(applyToPoint(g.toFootprint, 0, 0).map(ptToMm)[0]).toBeCloseTo(20, 9);
  });

  it("collects copies, spot mappings and metadata without changing geometry", () => {
    const g = computeGeometry(a4, [
      { kind: "copies", count: 3 },
      { kind: "spotMap", from: "Spot A", to: { kind: "colorant", name: "Spot B" } },
      { kind: "metadata", values: { customer: "Example Ltd" } },
      { kind: "metadata", values: { orderNumber: "4711" } },
    ]);
    expect(g.quantity).toBe(3);
    expect(g.spotMappings).toHaveLength(1);
    expect(g.metadata).toEqual({ customer: "Example Ltd", orderNumber: "4711" });
    expect(g.trimWidthPt).toBeCloseTo(mmToPt(210), 9);
  });
});

describe("mapColorant", () => {
  it("applies mappings in order, so renames chain and merges converge", () => {
    const mappings = [
      { from: "A", target: { kind: "colorant" as const, name: "B" } },
      { from: "B", target: { kind: "colorant" as const, name: "C" } },
      { from: "D", target: { kind: "process" as const } },
    ];
    expect(mapColorant(mappings, "A")).toEqual({ kind: "colorant", name: "C" });
    expect(mapColorant(mappings, "B")).toEqual({ kind: "colorant", name: "C" });
    expect(mapColorant(mappings, "D")).toEqual({ kind: "process" });
    expect(mapColorant(mappings, "E")).toEqual({ kind: "colorant", name: "E" });
  });
});

describe("applyEdits", () => {
  const item: NestItem = { id: "i", widthPt: 100, heightPt: 50, bleedPt: 4, quantity: 1, rotation: "any" };

  it("returns the item unchanged without edits", () => {
    expect(applyEdits(item, [])).toBe(item);
  });

  it("scales the existing bleed with the artwork, unless addBleed replaces it", () => {
    expect(applyEdits(item, [{ kind: "scale", percent: 50 }]).bleedPt).toBeCloseTo(2, 12);
    expect(applyEdits(item, [{ kind: "scale", percent: 50 }, { kind: "addBleed", mm: 3, mode: "edge" }]).bleedPt).toBeCloseTo(mmToPt(3), 12);
  });

  it("takes the footprint of a pageSize override with no bleed, and the copies count", () => {
    const result = applyEdits(item, [{ kind: "pageSize", widthMm: 100, heightMm: 100 }, { kind: "copies", count: 7 }]);
    expect(result.widthPt).toBeCloseTo(mmToPt(100), 9);
    expect(result.bleedPt).toBe(0);
    expect(result.quantity).toBe(7);
  });
});

describe("previewRenderTransform", () => {
  it("composed after a viewport transform gives toFootprint followed by the output canvas mapping", () => {
    const toFootprint: Matrix = [0, -1.5, 1.5, 0, 10, 400];
    const viewport: Matrix = [2, 0, 0, -2, -20, 600];
    const pixelsPerPt = 2;
    const footprintHeight = 300;
    const t = previewRenderTransform(toFootprint, footprintHeight, viewport, pixelsPerPt);
    const expected = multiply(toFootprint, [pixelsPerPt, 0, 0, -pixelsPerPt, 0, footprintHeight * pixelsPerPt]);
    // pdf.js applies `viewport.transform` to user space first, then `transform`.
    expect(matrixDistance(multiply(viewport, t), expected)).toBeLessThan(1e-9);
    expect(matrixDistance(multiply(invert(t), t), [1, 0, 0, 1, 0, 0])).toBeLessThan(1e-9);
  });
});
