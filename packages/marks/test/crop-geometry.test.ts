import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_MARK_DISTANCE_PT,
  MAX_MARK_LINE_WEIGHT_PT,
  MAX_MARK_SHEET_SIDE_PT,
  MarkSpecError,
  bleedMarkSegments,
  cropMarkSegments,
  type CornerMarkInput,
  type Segment,
} from "../src/index.js";
import { rectsOverlap, strokeBounds, type Rect } from "../src/geometry.js";

const LETTER: CornerMarkInput = { trim: { x: 0, y: 0, width: 612, height: 792 }, bleed: 9, offset: 9, length: 18 };

const TOLERANCE = 1e-6;

const near = (a: Segment, b: Segment): boolean =>
  Math.abs(a.x1 - b.x1) < TOLERANCE &&
  Math.abs(a.y1 - b.y1) < TOLERANCE &&
  Math.abs(a.x2 - b.x2) < TOLERANCE &&
  Math.abs(a.y2 - b.y2) < TOLERANCE;

/** True when mapping every segment through (fx, fy) gives the same set of segments. */
function isInvariant(segments: readonly Segment[], fx: (x: number) => number, fy: (y: number) => number): boolean {
  return segments.every((s) => {
    const image = { x1: fx(s.x1), y1: fy(s.y1), x2: fx(s.x2), y2: fy(s.y2) };
    return segments.some((t) => near(image, t));
  });
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

const inputArb = fc.record({
  x: fc.double({ min: 0, max: 2_000, noNaN: true }),
  y: fc.double({ min: 0, max: 2_000, noNaN: true }),
  width: fc.double({ min: 1, max: 5_000, noNaN: true }),
  height: fc.double({ min: 1, max: 5_000, noNaN: true }),
  bleed: fc.double({ min: 0, max: 72, noNaN: true }),
  offset: fc.double({ min: 0, max: 72, noNaN: true }),
  length: fc.double({ min: 0.5, max: 72, noNaN: true }),
  lineWeight: fc.double({ min: 0.05, max: 4, noNaN: true }),
});

type ArbValue = typeof inputArb extends fc.Arbitrary<infer T> ? T : never;

const toInput = (r: ArbValue): CornerMarkInput => ({
  trim: { x: r.x, y: r.y, width: r.width, height: r.height },
  bleed: r.bleed,
  offset: r.offset,
  length: r.length,
  lineWeight: r.lineWeight,
});

describe("cropMarkSegments", () => {
  it("golden: US Letter trim at the origin, 9 pt bleed, 9 pt offset, 18 pt length", () => {
    expect(cropMarkSegments(LETTER)).toEqual([
      { x1: -18, y1: 0, x2: -36, y2: 0 },
      { x1: 0, y1: -18, x2: 0, y2: -36 },
      { x1: 630, y1: 0, x2: 648, y2: 0 },
      { x1: 612, y1: -18, x2: 612, y2: -36 },
      { x1: 630, y1: 792, x2: 648, y2: 792 },
      { x1: 612, y1: 810, x2: 612, y2: 828 },
      { x1: -18, y1: 792, x2: -36, y2: 792 },
      { x1: 0, y1: 810, x2: 0, y2: 828 },
    ]);
  });

  it("with zero bleed starts `offset` from the trim", () => {
    const segments = cropMarkSegments({ trim: { x: 10, y: 20, width: 100, height: 50 }, bleed: 0, offset: 6, length: 12 });
    expect(segments).toEqual([
      { x1: 4, y1: 20, x2: -8, y2: 20 },
      { x1: 10, y1: 14, x2: 10, y2: 2 },
      { x1: 116, y1: 20, x2: 128, y2: 20 },
      { x1: 110, y1: 14, x2: 110, y2: 2 },
      { x1: 116, y1: 70, x2: 128, y2: 70 },
      { x1: 110, y1: 76, x2: 110, y2: 88 },
      { x1: 4, y1: 70, x2: -8, y2: 70 },
      { x1: 10, y1: 76, x2: 10, y2: 88 },
    ]);
  });

  it("with zero bleed and zero offset starts on the trim corners", () => {
    const segments = cropMarkSegments({ trim: { x: 0, y: 0, width: 100, height: 50 }, bleed: 0, offset: 0, length: 5 });
    expect(segments.slice(0, 2)).toEqual([
      { x1: 0, y1: 0, x2: -5, y2: 0 },
      { x1: 0, y1: 0, x2: 0, y2: -5 },
    ]);
  });

  it("is deterministic", () => {
    expect(cropMarkSegments(LETTER)).toEqual(cropMarkSegments(LETTER));
  });

  it("accepts values exactly at the caps", () => {
    const input: CornerMarkInput = {
      trim: { x: MAX_MARK_SHEET_SIDE_PT, y: MAX_MARK_SHEET_SIDE_PT, width: MAX_MARK_SHEET_SIDE_PT, height: MAX_MARK_SHEET_SIDE_PT },
      bleed: MAX_MARK_DISTANCE_PT,
      offset: MAX_MARK_DISTANCE_PT,
      length: MAX_MARK_DISTANCE_PT,
      lineWeight: MAX_MARK_LINE_WEIGHT_PT,
    };
    expect(cropMarkSegments(input)).toHaveLength(8);
    expect(bleedMarkSegments(input)).toHaveLength(8);
  });

  it("covers 100 m of roll (MAX_EDIT_LENGTH_MM in core edits.ts)", () => {
    expect(MAX_MARK_SHEET_SIDE_PT).toBe(283_465);
    expect(MAX_MARK_SHEET_SIDE_PT).toBeGreaterThanOrEqual((100_000 * 72) / 25.4);
  });

  it("accepts a trim side exactly at the cap", () => {
    const input: CornerMarkInput = { ...LETTER, trim: { x: 0, y: 0, width: 612, height: MAX_MARK_SHEET_SIDE_PT } };
    expect(cropMarkSegments(input)).toHaveLength(8);
    expect(bleedMarkSegments(input)).toHaveLength(8);
  });

  it("draws corner marks on a 30 m roll item", () => {
    const rollPt = (30_000 * 72) / 25.4;
    const input: CornerMarkInput = { trim: { x: 0, y: 0, width: 1_000, height: rollPt }, bleed: 9, offset: 9, length: 18 };
    const bleed = bleedMarkSegments(input);
    const crop = cropMarkSegments(input);
    expect(bleed).toHaveLength(8);
    expect(crop).toHaveLength(8);
    // Top-right vertical lines: 18 pt past the trim top, 18 pt long.
    expect(bleed.some((s) => near(s, { x1: 1_009, y1: rollPt + 18, x2: 1_009, y2: rollPt + 36 }))).toBe(true);
    expect(crop.some((s) => near(s, { x1: 1_000, y1: rollPt + 18, x2: 1_000, y2: rollPt + 36 }))).toBe(true);
  });
});

describe("bleedMarkSegments", () => {
  it("golden: US Letter trim at the origin, 9 pt bleed, 9 pt offset, 18 pt length", () => {
    expect(bleedMarkSegments(LETTER)).toEqual([
      { x1: -18, y1: -9, x2: -36, y2: -9 },
      { x1: -9, y1: -18, x2: -9, y2: -36 },
      { x1: 630, y1: -9, x2: 648, y2: -9 },
      { x1: 621, y1: -18, x2: 621, y2: -36 },
      { x1: 630, y1: 801, x2: 648, y2: 801 },
      { x1: 621, y1: 810, x2: 621, y2: 828 },
      { x1: -18, y1: 801, x2: -36, y2: 801 },
      { x1: -9, y1: 810, x2: -9, y2: 828 },
    ]);
  });

  it("coincides with the crop marks when the bleed is zero", () => {
    const input: CornerMarkInput = { trim: { x: 36, y: 48, width: 300, height: 200 }, bleed: 0, offset: 9, length: 18 };
    expect(bleedMarkSegments(input)).toEqual(cropMarkSegments(input));
  });
});

describe.each([
  { name: "cropMarkSegments", fn: cropMarkSegments },
  { name: "bleedMarkSegments", fn: bleedMarkSegments },
])("$name properties", ({ fn }) => {
  it("property: 4-fold symmetric about the trim centre", () => {
    fc.assert(
      fc.property(inputArb, (r) => {
        const segments = fn(toInput(r));
        expect(segments).toHaveLength(8);
        const sumX = 2 * r.x + r.width;
        const sumY = 2 * r.y + r.height;
        expect(isInvariant(segments, (x) => sumX - x, (y) => y)).toBe(true);
        expect(isInvariant(segments, (x) => x, (y) => sumY - y)).toBe(true);
        expect(isInvariant(segments, (x) => sumX - x, (y) => sumY - y)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("property: every stroked segment lies outside trim + bleed + offset", () => {
    fc.assert(
      fc.property(inputArb, (r) => {
        const input = toInput(r);
        const reach = r.bleed + r.offset;
        const box: Rect = { x: r.x - reach, y: r.y - reach, w: r.width + 2 * reach, h: r.height + 2 * reach };
        for (const s of fn(input)) {
          expect(rectsOverlap(strokeBounds(s, r.lineWeight), box)).toBe(false);
          expect(Math.hypot(s.x2 - s.x1, s.y2 - s.y1)).toBeCloseTo(r.length, 6);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("corner mark bounds", () => {
  const withTrim = (trim: Partial<CornerMarkInput["trim"]>): CornerMarkInput => ({ ...LETTER, trim: { ...LETTER.trim, ...trim } });

  const bad: readonly { name: string; input: CornerMarkInput; message: string }[] = [
    { name: "NaN trim x", input: withTrim({ x: Number.NaN }), message: "trim.x must be a finite number" },
    { name: "Infinity trim width", input: withTrim({ width: Number.POSITIVE_INFINITY }), message: "trim.width must be a finite number" },
    { name: "-Infinity bleed", input: { ...LETTER, bleed: Number.NEGATIVE_INFINITY }, message: "bleed must be a finite number" },
    { name: "NaN length", input: { ...LETTER, length: Number.NaN }, message: "length must be a finite number" },
    { name: "negative trim y", input: withTrim({ y: -1 }), message: "trim.y must be non-negative" },
    { name: "negative bleed", input: { ...LETTER, bleed: -0.5 }, message: "bleed must be non-negative" },
    { name: "negative offset", input: { ...LETTER, offset: -1 }, message: "offset must be non-negative" },
    { name: "zero trim width", input: withTrim({ width: 0 }), message: "trim.width must be positive" },
    { name: "zero trim height", input: withTrim({ height: 0 }), message: "trim.height must be positive" },
    { name: "zero length", input: { ...LETTER, length: 0 }, message: "length must be positive" },
    { name: "zero line weight", input: { ...LETTER, lineWeight: 0 }, message: "lineWeight must be positive" },
    {
      name: "trim width over cap",
      input: withTrim({ width: MAX_MARK_SHEET_SIDE_PT + 1 }),
      message: "trim.width 283466 is over the limit of 283465",
    },
    {
      name: "trim height just over cap",
      input: withTrim({ height: MAX_MARK_SHEET_SIDE_PT + 0.001 }),
      message: `trim.height ${String(MAX_MARK_SHEET_SIDE_PT + 0.001)} is over the limit of 283465`,
    },
    { name: "trim x over cap", input: withTrim({ x: MAX_MARK_SHEET_SIDE_PT + 1 }), message: "trim.x 283466 is over the limit of 283465" },
    { name: "bleed over cap", input: { ...LETTER, bleed: MAX_MARK_DISTANCE_PT + 1 }, message: "bleed 721 is over the limit of 720" },
    { name: "offset over cap", input: { ...LETTER, offset: MAX_MARK_DISTANCE_PT + 1 }, message: "offset 721 is over the limit of 720" },
    { name: "length over cap", input: { ...LETTER, length: MAX_MARK_DISTANCE_PT + 1 }, message: "length 721 is over the limit of 720" },
    {
      name: "line weight over cap",
      input: { ...LETTER, lineWeight: MAX_MARK_LINE_WEIGHT_PT + 1 },
      message: "lineWeight 37 is over the limit of 36",
    },
  ];

  it.each(bad)("rejects $name", ({ input, message }) => {
    expect(() => cropMarkSegments(input)).toThrow(MarkSpecError);
    expect(() => cropMarkSegments(input)).toThrow(message);
    expect(() => bleedMarkSegments(input)).toThrow(MarkSpecError);
    expect(() => bleedMarkSegments(input)).toThrow(message);
  });

  it("reports every issue at once", () => {
    const input: CornerMarkInput = { ...withTrim({ width: 0 }), bleed: Number.NaN, length: -1 };
    const err = thrown(() => cropMarkSegments(input));
    expect(err).toBeInstanceOf(MarkSpecError);
    expect(err instanceof MarkSpecError ? err.issues : []).toEqual([
      "trim.width must be positive, got 0",
      "bleed must be a finite number, got NaN",
      "length must be positive, got -1",
    ]);
  });
});
