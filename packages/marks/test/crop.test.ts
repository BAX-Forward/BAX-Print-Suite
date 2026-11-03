import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planFinishing, ptToMm, type ItemInfo, type Rotation } from "../src/index.js";
import { rectsOverlap, strokeBounds, type Rect } from "../src/geometry.js";
import { cropSegments } from "../src/marks-local.js";
import { CropMarkSchema } from "../src/schema.js";
import { placeMm } from "./helpers.js";

describe("crop marks", () => {
  it("uses the documented defaults: 6 mm long, 3 mm from the trim, 0.25 pt", () => {
    const spec = CropMarkSchema.parse({ kind: "crop" });
    expect(spec).toMatchObject({ lengthMm: 6, offsetMm: 3, lineWidthPt: 0.25 });
    const { value, warnings } = cropSegments({ widthMm: 100, heightMm: 50, bleedMm: 0 }, spec);
    expect(warnings).toEqual([]);
    expect(value).toHaveLength(8);
    expect(value[0]).toEqual({ x1: -3, y1: 0, x2: -9, y2: 0 });
    expect(value[5]).toEqual({ x1: 100, y1: 53, x2: 100, y2: 59 });
  });

  it("starts at the bleed edge (with a warning) when the offset is inside the bleed", () => {
    const spec = CropMarkSchema.parse({ kind: "crop", offsetMm: 2 });
    const { value, warnings } = cropSegments({ widthMm: 100, heightMm: 50, bleedMm: 5 }, spec);
    expect(warnings).toHaveLength(1);
    expect(value[0]).toEqual({ x1: -5, y1: 0, x2: -11, y2: 0 });
  });

  it("property: crop marks never intersect the bleed box, for random boxes and rotations", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          w: fc.double({ min: 10, max: 5_000, noNaN: true }),
          h: fc.double({ min: 10, max: 5_000, noNaN: true }),
          bleed: fc.double({ min: 0, max: 20, noNaN: true }),
          offset: fc.double({ min: 0, max: 20, noNaN: true }),
          length: fc.double({ min: 0.5, max: 30, noNaN: true }),
          lineWidthPt: fc.double({ min: 0.05, max: 2, noNaN: true }),
          x: fc.double({ min: 0, max: 3_000, noNaN: true }),
          y: fc.double({ min: 0, max: 3_000, noNaN: true }),
          rotation: fc.constantFrom<Rotation>(0, 90, 180, 270),
        }),
        async (r) => {
          const item: ItemInfo = { itemId: "a", widthMm: r.w, heightMm: r.h, bleedMm: r.bleed };
          const placement = placeMm(item, r.x, r.y, r.rotation);
          const plan = await planFinishing({
            layout: { placements: [placement] },
            items: [item],
            job: { id: "J", date: "2026-01-01" },
            finishing: { marks: [{ kind: "crop", offsetMm: r.offset, lengthMm: r.length, lineWidthPt: r.lineWidthPt }] },
          });
          const bleedBox: Rect = {
            x: ptToMm(placement.xPt),
            y: ptToMm(placement.yPt),
            w: ptToMm(placement.footprint.w),
            h: ptToMm(placement.footprint.h),
          };
          const part = plan.elements[0]!.parts[0]!;
          expect(part.type).toBe("lines");
          if (part.type !== "lines") return;
          expect(part.segments).toHaveLength(8);
          for (const s of part.segments) {
            expect(rectsOverlap(strokeBounds(s, part.lineWidthMm), bleedBox)).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
