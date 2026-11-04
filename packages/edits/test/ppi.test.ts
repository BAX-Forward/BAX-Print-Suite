import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { JobEdit } from "@bax-print/core";
import { computeGeometry, editedPpi, effectivePpi, mmToPt, type ImagePlacement, type PageSource } from "../src/index.js";

/** 300 × 300 px drawn one inch square at (10, 10): 300 ppi as placed. */
const image: ImagePlacement = { pixelWidth: 300, pixelHeight: 300, ctm: [72, 0, 0, 72, 10, 10] };
const page: PageSource = { box: { x0: 0, y0: 0, x1: mmToPt(210), y1: mmToPt(297) } };

const ppiAfter = (edits: JobEdit[], source: PageSource = page): number => editedPpi(image, computeGeometry(source, edits)).min;

describe("effective ppi after edits (Spec 007 acceptance 3)", () => {
  it("is the placed resolution without edits", () => {
    expect(effectivePpi(image)).toEqual({ x: 300, y: 300, min: 300 });
    expect(ppiAfter([])).toBeCloseTo(300, 9);
  });

  it("divides by the scale factor", () => {
    expect(ppiAfter([{ kind: "scale", percent: 200 }])).toBeCloseTo(150, 9);
    expect(ppiAfter([{ kind: "scale", percent: 50 }])).toBeCloseTo(600, 9);
    expect(ppiAfter([{ kind: "scale", percent: 200 }, { kind: "scale", percent: 150 }])).toBeCloseTo(100, 9);
    expect(ppiAfter([{ kind: "scale", fit: { dimension: "width", targetMm: 420 } }])).toBeCloseTo(150, 9);
  });

  it("is unchanged by rotation, mirroring, crop, bleed and pageSize", () => {
    const edits: JobEdit[] = [
      { kind: "rotate", degrees: 90 },
      { kind: "mirror", axis: "vertical" },
      { kind: "crop", box: { xMm: 0, yMm: 0, widthMm: 100, heightMm: 100 } },
      { kind: "addBleed", mm: 3, mode: "mirror" },
      { kind: "pageSize", widthMm: 120, heightMm: 120 },
    ];
    expect(ppiAfter(edits)).toBeCloseTo(300, 9);
  });

  it("accounts for UserUnit", () => {
    expect(ppiAfter([], { ...page, userUnit: 2 })).toBeCloseTo(150, 9);
  });

  it("reports each axis of a non-uniformly placed image, before and after a quarter turn", () => {
    const wide: ImagePlacement = { pixelWidth: 600, pixelHeight: 100, ctm: [144, 0, 0, 72, 0, 0] };
    const before = effectivePpi(wide);
    expect([before.x, before.y, before.min]).toEqual([300, 100, 100]);
    const after = editedPpi(wide, computeGeometry(page, [{ kind: "rotate", degrees: 90 }, { kind: "scale", percent: 50 }]));
    expect(after.x).toBeCloseTo(600, 9);
    expect(after.y).toBeCloseTo(200, 9);
  });

  it("is restored by scale then inverse scale, for any edit stack", () => {
    const editArb: fc.Arbitrary<JobEdit> = fc.oneof(
      fc.double({ min: 10, max: 400, noNaN: true }).map((percent): JobEdit => ({ kind: "scale", percent })),
      fc.constantFrom(0, 90, 180, 270).map((degrees): JobEdit => ({ kind: "rotate", degrees: degrees as 0 | 90 | 180 | 270 })),
      fc.constantFrom("horizontal", "vertical").map((axis): JobEdit => ({ kind: "mirror", axis: axis as "horizontal" | "vertical" })),
    );
    fc.assert(
      fc.property(fc.array(editArb, { maxLength: 4 }), fc.double({ min: 1, max: 1000, noNaN: true }), (prefix, percent) => {
        const base = computeGeometry(page, prefix);
        const basePpi = editedPpi(image, base).min;
        // ppi × scale is invariant under any stack of uniform edits.
        expect(Math.abs(basePpi * base.scaleFactor - 300) / 300).toBeLessThan(1e-9);
        const restored = ppiAfter([...prefix, { kind: "scale", percent }, { kind: "scale", percent: 10_000 / percent }]);
        expect(Math.abs(restored - basePpi) / basePpi).toBeLessThan(1e-9);
      }),
    );
  });

  it("rejects images with no pixels or no area", () => {
    expect(() => effectivePpi({ ...image, pixelWidth: 0 })).toThrow(RangeError);
    expect(() => effectivePpi({ ...image, ctm: [0, 0, 0, 72, 0, 0] })).toThrow(RangeError);
  });
});
