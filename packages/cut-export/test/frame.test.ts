import { describe, expect, it } from "vitest";
import { CutterDriverError, type Corner } from "@bax-print/plugin-sdk";
import { createFrameTransform, formatCompact, formatFixed, roundHalfAwayFromZero, writeHpgl } from "../src/index.js";
import { jobOf, marksMm, parseHpgl, polylineMm, rectMm } from "./helpers.js";

// 200 x 100 mm frame, rectangle from (10, 10) to (110, 60) mm.
const job = jobOf({ contours: [rectMm("r", "kiss", 10, 10, 110, 60)] });
const [rect] = job.contours;
if (!rect) throw new Error("job has no rectangle contour");
const [bl, br, tr, tl] = rect.points;
if (!bl || !br || !tr || !tl) throw new Error("rectangle contour needs four corners");
const corners = [bl, br, tr, tl];

type Pair = [number, number];

// Expected cutter-frame coordinates (mm) of the rectangle's corners:
// [bottom-left, bottom-right, top-right, top-left] of the source rectangle.
const TABLE: { origin: Corner; swapXY: boolean; expected: [Pair, Pair, Pair, Pair] }[] = [
  { origin: "bottom-left", swapXY: false, expected: [[10, 10], [110, 10], [110, 60], [10, 60]] },
  { origin: "top-left", swapXY: false, expected: [[10, 90], [110, 90], [110, 40], [10, 40]] },
  { origin: "bottom-right", swapXY: false, expected: [[190, 10], [90, 10], [90, 60], [190, 60]] },
  { origin: "top-right", swapXY: false, expected: [[190, 90], [90, 90], [90, 40], [190, 40]] },
  { origin: "bottom-left", swapXY: true, expected: [[10, 10], [10, 110], [60, 110], [60, 10]] },
  { origin: "top-left", swapXY: true, expected: [[90, 10], [90, 110], [40, 110], [40, 10]] },
  { origin: "bottom-right", swapXY: true, expected: [[10, 190], [10, 90], [60, 90], [60, 190]] },
  { origin: "top-right", swapXY: true, expected: [[90, 190], [90, 90], [40, 90], [40, 190]] },
];

describe("origins and axes", () => {
  it.each(TABLE)("origin $origin, swapXY $swapXY", ({ origin, swapXY, expected }) => {
    const toFrame = createFrameTransform(job, { origin, swapXY });
    for (const [i, [ex, ey]] of expected.entries()) {
      const corner = corners[i];
      if (!corner) throw new Error(`no corner ${i}`);
      const [x, y] = toFrame(corner);
      expect(x).toBeCloseTo(ex, 9);
      expect(y).toBeCloseTo(ey, 9);
    }
    // The same mapping reaches the HPGL output (40 units per mm).
    const { paths } = parseHpgl(writeHpgl(job, { origin, swapXY }).text);
    expect(paths[0]?.points.slice(0, 4)).toEqual(expected.map(([x, y]) => [x * 40, y * 40]));
  });

  it("applies scale, then offset", () => {
    const toFrame = createFrameTransform(job, { scale: [2, 0.5], offsetMm: [1, 2] });
    const [x, y] = toFrame(bl);
    expect(x).toBeCloseTo(21, 9);
    expect(y).toBeCloseTo(7, 9);
  });

  it("uses the origin mark center when marks are present", () => {
    const marked = { ...job, marks: marksMm([[5, 5], [195, 5], [5, 95]], 5) };
    const [x, y] = createFrameTransform(marked)(bl);
    expect(x).toBeCloseTo(5, 9);
    expect(y).toBeCloseTo(5, 9);
    // useMarkOrigin: false falls back to the frame corner.
    const [x2, y2] = createFrameTransform(marked, { useMarkOrigin: false })(bl);
    expect([x2, y2].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([10, 10]);
  });

  it("rejects a missing origin mark", () => {
    const marked = { ...job, marks: { ...marksMm([[5, 5]], 5), originMarkId: "nope" } };
    expect(() => createFrameTransform(marked)).toThrowError(CutterDriverError);
  });
});

describe("rounding (documented: half away from zero)", () => {
  it.each([
    [2.5, 3],
    [-2.5, -3],
    [0.5, 1],
    [-0.5, -1],
    [1.4999, 1],
    [-1.4999, -1],
    [-0.1, 0],
  ])("roundHalfAwayFromZero(%d) = %d", (value, expected) => {
    expect(Object.is(roundHalfAwayFromZero(value), expected)).toBe(true);
  });

  it("formats fixed and compact numbers without negative zero", () => {
    expect(formatFixed(0.125, 2)).toBe("0.13");
    expect(formatFixed(-0.125, 2)).toBe("-0.13");
    expect(formatFixed(-0.00001, 4)).toBe("0.0000");
    expect(formatCompact(12.5)).toBe("12.5");
    expect(formatCompact(10)).toBe("10");
    expect(formatCompact(-0.00001)).toBe("0");
  });

  it("rounds negative coordinates symmetrically in HPGL", () => {
    // Origin mark at the frame center: points below/left of it are negative.
    const centered = jobOf({
      contours: [polylineMm("s", "kiss", [[101.23, 54.56], [98.77, 45.44]])],
      marks: marksMm([[100, 50]], 5),
    });
    const { paths } = parseHpgl(writeHpgl(centered).text);
    expect(paths[0]?.points).toEqual([[49, 182], [-49, -182]]);
  });
});
