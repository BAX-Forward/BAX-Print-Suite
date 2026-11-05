import { XMLValidator } from "fast-xml-parser";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  MAX_STEP_REPEAT_COPIES,
  impose,
  readLayoutMetadata,
  stepAndRepeat,
  toSvg,
  type ImposeSource,
  type ImposeWarning,
  type StepRepeatOptions,
} from "../src/index.js";
import type { Layout } from "../src/types.js";
import { artPdf } from "./fixtures.js";
import { layoutViolations } from "./helpers.js";

const PT_PER_MM = 72 / 25.4;
const DIGITS = 6;
const PAGE_TOLERANCE_PT = 0.5;

function mm(value: number): number {
  return value * PT_PER_MM;
}

function margins(all: number): StepRepeatOptions["marginsMm"] {
  return { left: all, right: all, lead: all, trail: all };
}

/** 100 × 50 mm on a 340 mm roll with 10 mm margins: printable width 320 mm, gaps 10 × 5 mm. */
function base(extra: Partial<StepRepeatOptions> = {}): StepRepeatOptions {
  return {
    item: { id: "label", widthMm: 100, heightMm: 50 },
    copies: 7,
    rollWidthMm: 340,
    marginsMm: margins(10),
    gapXMm: 10,
    gapYMm: 5,
    ...extra,
  };
}

function positionsMm(layout: Layout): [number, number][] {
  return layout.placements.map((p) => [p.xPt / PT_PER_MM, p.yPt / PT_PER_MM]);
}

function expectPositionsMm(layout: Layout, expected: readonly (readonly [number, number])[]): void {
  const actual = positionsMm(layout);
  expect(actual).toHaveLength(expected.length);
  expected.forEach(([x, y], index) => {
    expect(actual[index]?.[0], `x of copy ${index}`).toBeCloseTo(x, DIGITS);
    expect(actual[index]?.[1], `y of copy ${index}`).toBeCloseTo(y, DIGITS);
  });
}

function rotationsOf(layout: Layout): number[] {
  return [...new Set(layout.placements.map((p) => p.rotation))];
}

describe("stepAndRepeat: grid", () => {
  it("places copies row by row with exact positions and a partial last row", () => {
    const layout = stepAndRepeat(base());
    // Three columns fit exactly: 3 × 100 + 2 × 10 = 320 mm.
    expectPositionsMm(layout, [
      [0, 0],
      [110, 0],
      [220, 0],
      [0, 55],
      [110, 55],
      [220, 55],
      [0, 110],
    ]);
    expect(layout.placements.map((p) => p.copy)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const p of layout.placements) {
      expect(p.itemId).toBe("label");
      expect(p.rotation).toBe(0);
      expect(p.panel).toBe(0);
      expect(p.footprint.w).toBeCloseTo(mm(100), DIGITS);
      expect(p.footprint.h).toBeCloseTo(mm(50), DIGITS);
    }
  });

  it("reports the total length and a single panel", () => {
    const layout = stepAndRepeat(base());
    // 3 rows × 50 mm + 2 gaps × 5 mm.
    expect(layout.lengthUsedPt).toBeCloseTo(mm(160), DIGITS);
    expect(layout.panels).toHaveLength(1);
    expect(layout.panels[0]?.offsetPt).toBe(0);
    expect(layout.panels[0]?.lengthPt).toBeCloseTo(mm(160), DIGITS);
    expect(layout.unplaced).toEqual([]);
    expect(layout.algorithm).toBe("step-repeat");
  });

  it("uses fewer columns than fit when there are fewer copies", () => {
    const layout = stepAndRepeat(base({ copies: 2 }));
    expectPositionsMm(layout, [
      [0, 0],
      [110, 0],
    ]);
    expect(layout.lengthUsedPt).toBeCloseTo(mm(50), DIGITS);
  });

  it("satisfies the shared layout invariants", () => {
    const layout = stepAndRepeat(base({ copies: 23 }));
    expect(layoutViolations(layout, layout.media, mm(5))).toEqual([]);
  });

  it("reports full utilization for a gapless grid that fills the width", () => {
    const layout = stepAndRepeat(base({ copies: 6, rollWidthMm: 300, marginsMm: margins(0), gapXMm: 0, gapYMm: 0 }));
    expect(layout.utilization).toBeCloseTo(1, DIGITS);
    expect(layout.lengthUsedPt).toBeCloseTo(mm(100), DIGITS);
  });
});

describe("stepAndRepeat: gaps and margins", () => {
  it("puts gaps only between copies, so the grid may touch the margins", () => {
    // 3 × 100 mm + 2 × 10 mm gaps = 320 mm: one row that ends exactly at the right margin.
    const layout = stepAndRepeat(base({ copies: 3 }));
    expect(layout.placements.every((p) => p.yPt === 0)).toBe(true);
    const last = layout.placements[2];
    expect((last?.xPt ?? 0) + (last?.footprint.w ?? 0)).toBeCloseTo(mm(320), DIGITS);
    expect(layout.lengthUsedPt).toBeCloseTo(mm(50), DIGITS);
  });

  it("drops a column when the gap no longer fits", () => {
    const layout = stepAndRepeat(base({ copies: 3, gapXMm: 10.5 }));
    expectPositionsMm(layout, [
      [0, 0],
      [110.5, 0],
      [0, 55],
    ]);
  });

  it("uses the row gap along the feed", () => {
    const layout = stepAndRepeat(base({ copies: 4, gapXMm: 0, gapYMm: 12, rollWidthMm: 200, marginsMm: margins(0) }));
    expectPositionsMm(layout, [
      [0, 0],
      [100, 0],
      [0, 62],
      [100, 62],
    ]);
    expect(layout.lengthUsedPt).toBeCloseTo(mm(112), DIGITS);
  });

  it("subtracts unequal side margins from the printable width and records margins in points", () => {
    const layout = stepAndRepeat(
      base({ copies: 3, rollWidthMm: 340, marginsMm: { left: 15, right: 10, lead: 20, trail: 30 } }),
    );
    // Printable width 315 mm: only two 100 mm columns with a 10 mm gap.
    expectPositionsMm(layout, [
      [0, 0],
      [110, 0],
      [0, 55],
    ]);
    expect(layout.mediaWidthPt).toBeCloseTo(mm(340), DIGITS);
    expect(layout.media.margins.left).toBeCloseTo(mm(15), DIGITS);
    expect(layout.media.margins.right).toBeCloseTo(mm(10), DIGITS);
    expect(layout.media.margins.lead).toBeCloseTo(mm(20), DIGITS);
    expect(layout.media.margins.trail).toBeCloseTo(mm(30), DIGITS);
  });
});

describe("stepAndRepeat: rotation", () => {
  // 30 × 100 mm on a 250 mm printable width, 10 copies, no gaps.
  const tall = (rotate: StepRepeatOptions["rotate"]): StepRepeatOptions =>
    base({
      item: { id: "tall", widthMm: 30, heightMm: 100 },
      copies: 10,
      rollWidthMm: 250,
      marginsMm: margins(0),
      gapXMm: 0,
      gapYMm: 0,
      ...(rotate === undefined ? {} : { rotate }),
    });

  it("does not rotate by default", () => {
    const layout = stepAndRepeat(tall(undefined));
    // 8 columns × 2 rows: 200 mm.
    expect(rotationsOf(layout)).toEqual([0]);
    expect(layout.lengthUsedPt).toBeCloseTo(mm(200), DIGITS);
  });

  it("auto picks 90 degrees when it gives the shorter length", () => {
    const layout = stepAndRepeat(tall("auto"));
    // Turned 100 × 30 mm: 2 columns × 5 rows = 150 mm, shorter than 200 mm upright.
    expect(rotationsOf(layout)).toEqual([90]);
    expect(layout.lengthUsedPt).toBeCloseTo(mm(150), DIGITS);
    const first = layout.placements[0];
    expect(first?.footprint.w).toBeCloseTo(mm(100), DIGITS);
    expect(first?.footprint.h).toBeCloseTo(mm(30), DIGITS);
    expectPositionsMm(layout, [
      [0, 0],
      [100, 0],
      [0, 30],
      [100, 30],
      [0, 60],
      [100, 60],
      [0, 90],
      [100, 90],
      [0, 120],
      [100, 120],
    ]);
  });

  it("auto keeps 0 degrees when it is shorter", () => {
    const layout = stepAndRepeat({ ...tall("auto"), item: { id: "wide", widthMm: 100, heightMm: 30 } });
    expect(rotationsOf(layout)).toEqual([0]);
    expect(layout.lengthUsedPt).toBeCloseTo(mm(150), DIGITS);
  });

  it("auto keeps 0 degrees on a tie", () => {
    // 50 × 100 mm on 200 mm, 4 copies: upright 4 × 1 = 100 mm, turned 2 × 2 = 100 mm.
    const layout = stepAndRepeat({
      ...tall("auto"),
      item: { id: "tie", widthMm: 50, heightMm: 100 },
      copies: 4,
      rollWidthMm: 200,
    });
    expect(rotationsOf(layout)).toEqual([0]);
    expect(layout.lengthUsedPt).toBeCloseTo(mm(100), DIGITS);
  });

  it("auto rotates an item that only fits turned", () => {
    const layout = stepAndRepeat({ ...tall("auto"), item: { id: "long", widthMm: 300, heightMm: 40 }, copies: 2 });
    expect(rotationsOf(layout)).toEqual([90]);
    expect(layout.lengthUsedPt).toBeCloseTo(mm(300), DIGITS);
  });
});

describe("stepAndRepeat: errors", () => {
  it("rejects an item wider than the printable width in every allowed rotation", () => {
    const long = { id: "long", widthMm: 300, heightMm: 40 };
    expect(() => stepAndRepeat(base({ item: long, rollWidthMm: 270 }))).toThrow(RangeError);
    expect(() => stepAndRepeat(base({ item: long, rollWidthMm: 270 }))).toThrow(/wider than the printable width/);
    const huge = { id: "huge", widthMm: 400, heightMm: 400 };
    expect(() => stepAndRepeat(base({ item: huge, rotate: "auto" }))).toThrow(/in either rotation/);
  });

  it("rejects margins that leave no printable width", () => {
    expect(() => stepAndRepeat(base({ marginsMm: margins(200) }))).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects copies = %s", (copies) => {
    expect(() => stepAndRepeat(base({ copies }))).toThrow(/copies must be a positive integer/);
  });

  it("rejects negative gaps", () => {
    expect(() => stepAndRepeat(base({ gapXMm: -1 }))).toThrow(/gapXMm must not be negative/);
    expect(() => stepAndRepeat(base({ gapYMm: -0.1 }))).toThrow(/gapYMm must not be negative/);
  });

  it.each(["left", "right", "lead", "trail"] as const)("rejects a negative %s margin", (side) => {
    const marginsMm = { ...margins(10), [side]: -1 };
    expect(() => stepAndRepeat(base({ marginsMm }))).toThrow(new RegExp(`${side} margin must not be negative`));
  });

  it("rejects non-finite and non-positive sizes", () => {
    expect(() => stepAndRepeat(base({ item: { id: "x", widthMm: 0, heightMm: 10 } }))).toThrow(RangeError);
    expect(() => stepAndRepeat(base({ item: { id: "x", widthMm: 10, heightMm: Infinity } }))).toThrow(RangeError);
    expect(() => stepAndRepeat(base({ rollWidthMm: Number.NaN }))).toThrow(RangeError);
    expect(() => stepAndRepeat(base({ gapXMm: Number.NaN }))).toThrow(RangeError);
  });
});

describe("stepAndRepeat: preview and imposition", () => {
  it("renders as SVG with one rect.item per copy", () => {
    const layout = stepAndRepeat(base({ rotate: "auto" }));
    const svg = toSvg(layout);
    expect(XMLValidator.validate(svg)).toBe(true);
    expect(svg.match(/<rect class="item"/g)?.length).toBe(layout.placements.length);
  });

  it.each([
    ["upright", { widthMm: 100, heightMm: 50 }],
    ["rotated", { widthMm: 30, heightMm: 100 }],
  ] as const)("imposes an %s grid without warnings", async (_label, size) => {
    const layout = stepAndRepeat(
      base({ item: { id: "art", ...size }, copies: 10, rollWidthMm: 250, marginsMm: margins(5), rotate: "auto" }),
    );
    const art = await artPdf({ widthPt: mm(size.widthMm), heightPt: mm(size.heightMm) });
    const sources = new Map<string, ImposeSource>([["art", { pdfBytes: art, pageIndex: 0, box: "trim" }]]);
    const warnings: ImposeWarning[] = [];
    const pdf = await impose(layout, sources, { onWarning: (warning) => warnings.push(warning) });
    expect(warnings).toEqual([]);

    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    const { lead, trail } = layout.media.margins;
    expect(Math.abs(width - layout.mediaWidthPt)).toBeLessThanOrEqual(PAGE_TOLERANCE_PT);
    expect(Math.abs(height - (lead + layout.lengthUsedPt + trail))).toBeLessThanOrEqual(PAGE_TOLERANCE_PT);

    const metadata = await readLayoutMetadata(pdf);
    expect(metadata?.layout.placements).toHaveLength(10);
    expect(metadata?.layout.algorithm).toBe("step-repeat");
  });
});

describe("stepAndRepeat limits", () => {
  const small = (copies: number, maxPlacements?: number): StepRepeatOptions => ({
    item: { id: "dot", widthMm: 1, heightMm: 1 },
    copies,
    rollWidthMm: 30,
    marginsMm: margins(0),
    gapXMm: 0,
    gapYMm: 0,
    rotate: "none",
    ...(maxPlacements === undefined ? {} : { maxPlacements }),
  });

  it("accepts exactly MAX_STEP_REPEAT_COPIES copies and rejects one more", () => {
    expect(MAX_STEP_REPEAT_COPIES).toBe(10_000);
    expect(stepAndRepeat(small(MAX_STEP_REPEAT_COPIES)).placements).toHaveLength(MAX_STEP_REPEAT_COPIES);
    expect(() => stepAndRepeat(small(MAX_STEP_REPEAT_COPIES + 1))).toThrow(/at most 10000/);
  });

  it("caps grid cells: 30 x 2 = 60 fits a cap of 60, 30 x 3 = 90 does not", () => {
    expect(stepAndRepeat(small(60, 60)).placements).toHaveLength(60);
    expect(() => stepAndRepeat(small(61, 60))).toThrow(/placements exceed the limit of 60/);
  });
});

