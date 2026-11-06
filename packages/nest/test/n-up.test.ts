import { describe, expect, it } from "vitest";
import {
  MAX_GRID,
  MAX_PAGES,
  MAX_SHEETS,
  NestInputError,
  planNUp,
  type NUpOptions,
  type NUpOrientation,
  type NUpPlacement,
  type NUpPlan,
} from "../src/index.js";
import { createRng, type Rng } from "../src/rng.js";

const DIGITS = 9;
const TOLERANCE = 1e-6;
const PROPERTY_CASES = 500;
const ORIENTATIONS: readonly NUpOrientation[] = ["upright", "turned", "auto"];

/** 300 x 200 sheet, 90 x 60 cells, gutter 10, margin 5: usable 290 x 190, a 2 x 3 grid. */
function base(extra: Partial<NUpOptions> = {}): NUpOptions {
  return { sheet: { width: 300, height: 200 }, cell: { width: 90, height: 60 }, gutter: 10, margin: 5, ...extra };
}

function positions(plan: NUpPlan): [number, number][] {
  return plan.placements.map((p) => [p.x, p.y]);
}

function expectPositions(plan: NUpPlan, expected: readonly (readonly [number, number])[]): void {
  const actual = positions(plan);
  expect(actual).toHaveLength(expected.length);
  expected.forEach(([x, y], index) => {
    expect(actual[index]?.[0], `x of slot ${index}`).toBeCloseTo(x, DIGITS);
    expect(actual[index]?.[1], `y of slot ${index}`).toBeCloseTo(y, DIGITS);
  });
}

function expectInputError(run: () => unknown, message: RegExp): void {
  expect(run).toThrow(NestInputError);
  expect(run).toThrow(message);
}

describe("planNUp: grid", () => {
  it("fits as many rows and columns as the usable area allows", () => {
    const plan = planNUp(base());
    expect(plan.rows).toBe(2);
    expect(plan.cols).toBe(3);
    expect(plan.cellsPerSheet).toBe(6);
    expect(plan.rotation).toBe(0);
    expectPositions(plan, [
      [5, 135],
      [105, 135],
      [205, 135],
      [5, 65],
      [105, 65],
      [205, 65],
    ]);
    expect(plan.placements.map((p) => [p.index, p.row, p.col])).toEqual([
      [0, 0, 0],
      [1, 0, 1],
      [2, 0, 2],
      [3, 1, 0],
      [4, 1, 1],
      [5, 1, 2],
    ]);
    expect(plan.placements.every((p) => p.width === 90 && p.height === 60)).toBe(true);
  });

  it("is deterministic", () => {
    expect(planNUp(base({ pageCount: 13 }))).toEqual(planNUp(base({ pageCount: 13 })));
  });

  it("uses explicit rows and columns", () => {
    const plan = planNUp(base({ rows: 1, cols: 2 }));
    expect([plan.rows, plan.cols]).toEqual([1, 2]);
    expectPositions(plan, [
      [5, 135],
      [105, 135],
    ]);
  });

  it("fills in the omitted axis automatically", () => {
    const plan = planNUp(base({ rows: 1 }));
    expect([plan.rows, plan.cols]).toEqual([1, 3]);
  });

  it("defaults gutter and margin to 0", () => {
    const plan = planNUp({ sheet: { width: 200, height: 100 }, cell: { width: 100, height: 50 } });
    expect([plan.rows, plan.cols]).toEqual([2, 2]);
    expectPositions(plan, [
      [0, 50],
      [100, 50],
      [0, 0],
      [100, 0],
    ]);
  });

  it("turns cells by 90 degrees and swaps the footprint", () => {
    const plan = planNUp(base({ orientation: "turned" }));
    expect(plan.rotation).toBe(90);
    expect([plan.rows, plan.cols]).toEqual([2, 4]);
    expect(plan.placements.every((p) => p.width === 60 && p.height === 90 && p.rotation === 90)).toBe(true);
  });

  it("auto keeps the rotation with more cells", () => {
    const plan = planNUp({ sheet: { width: 100, height: 70 }, cell: { width: 60, height: 30 }, orientation: "auto" });
    expect(plan.rotation).toBe(90);
    expect([plan.rows, plan.cols]).toEqual([1, 3]);
  });

  it("auto keeps upright on a tie", () => {
    const plan = planNUp({ sheet: { width: 100, height: 100 }, cell: { width: 60, height: 30 }, orientation: "auto" });
    expect(plan.rotation).toBe(0);
    expect([plan.rows, plan.cols]).toEqual([3, 1]);
  });

  it("auto falls back to the only rotation that fits", () => {
    const plan = planNUp({ sheet: { width: 100, height: 200 }, cell: { width: 150, height: 50 }, orientation: "auto" });
    expect(plan.rotation).toBe(90);
  });

  it("caps automatic rows and columns at MAX_GRID", () => {
    const plan = planNUp({ sheet: { width: 1000, height: 1000 }, cell: { width: 1, height: 1 } });
    expect([plan.rows, plan.cols]).toEqual([MAX_GRID, MAX_GRID]);
  });

  it("accepts a cell that exactly fills the usable area", () => {
    const plan = planNUp({ sheet: { width: 100, height: 50 }, cell: { width: 90, height: 40 }, margin: 5 });
    expect(plan.cellsPerSheet).toBe(1);
    expectPositions(plan, [[5, 5]]);
  });
});

describe("planNUp: page slots", () => {
  it("assigns pages in reading order and pads the last sheet with blanks", () => {
    const plan = planNUp(base({ pageCount: 8 }));
    expect(plan.pageCount).toBe(8);
    expect(plan.blankCount).toBe(4);
    expect(plan.sheets).toEqual([
      { index: 0, pages: [1, 2, 3, 4, 5, 6] },
      { index: 1, pages: [7, 8, "blank", "blank", "blank", "blank"] },
    ]);
  });

  it("needs no blanks for a whole number of sheets", () => {
    const plan = planNUp(base({ pageCount: 12 }));
    expect(plan.sheets).toHaveLength(2);
    expect(plan.blankCount).toBe(0);
  });

  it("has no sheets without a page count", () => {
    const plan = planNUp(base());
    expect(plan.sheets).toEqual([]);
    expect(plan.pageCount).toBe(0);
    expect(plan.blankCount).toBe(0);
  });

  it("allows MAX_PAGES pages", () => {
    const plan = planNUp(base({ pageCount: MAX_PAGES }));
    expect(plan.sheets).toHaveLength(Math.ceil(MAX_PAGES / 6));
  });

  it("allows exactly MAX_SHEETS sheets and rejects one more", () => {
    const oneUp = base({ cell: { width: 290, height: 190 } });
    expect(planNUp({ ...oneUp, pageCount: MAX_SHEETS }).sheets).toHaveLength(MAX_SHEETS);
    expectInputError(() => planNUp({ ...oneUp, pageCount: MAX_SHEETS + 1 }), /limit of 5000/);
  });
});

describe("planNUp: validation", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects pageCount %s", (pageCount) => {
    expectInputError(() => planNUp(base({ pageCount })), /pageCount must be/);
  });

  it("rejects more than MAX_PAGES pages", () => {
    expectInputError(() => planNUp(base({ pageCount: MAX_PAGES + 1 })), /pageCount must be at most 10000/);
  });

  it.each([0, -2, 2.5, Number.NaN, MAX_GRID + 1])("rejects rows %s", (rows) => {
    expectInputError(() => planNUp(base({ rows })), /rows must be/);
  });

  it.each([0, -2, 2.5, Number.NaN, MAX_GRID + 1])("rejects cols %s", (cols) => {
    expectInputError(() => planNUp(base({ cols })), /cols must be/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects sheet and cell sizes of %s", (value) => {
    expectInputError(() => planNUp(base({ sheet: { width: value, height: 200 } })), /sheet width must be/);
    expectInputError(() => planNUp(base({ sheet: { width: 300, height: value } })), /sheet height must be/);
    expectInputError(() => planNUp(base({ cell: { width: value, height: 60 } })), /cell width must be/);
    expectInputError(() => planNUp(base({ cell: { width: 90, height: value } })), /cell height must be/);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects gutter %s", (gutter) => {
    expectInputError(() => planNUp(base({ gutter })), /gutter must/);
  });

  it("rejects a gutter larger than the smaller sheet side", () => {
    expectInputError(() => planNUp(base({ gutter: 201 })), /gutter must be at most the smaller sheet side 200/);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects margin %s", (margin) => {
    expectInputError(() => planNUp(base({ margin })), /margin must/);
  });

  it("rejects a margin that leaves no usable area", () => {
    expectInputError(() => planNUp(base({ margin: 100 })), /leaves no usable area/);
  });

  it("rejects a cell larger than the usable area", () => {
    expectInputError(() => planNUp(base({ cell: { width: 291, height: 60 } })), /do not fit/);
  });

  it("rejects an explicit grid that does not fit", () => {
    expectInputError(() => planNUp(base({ cols: 4 })), /auto rows x 4 cols .* do not fit/);
    expectInputError(() => planNUp(base({ rows: 3 })), /3 rows x auto cols .* do not fit/);
  });

  it("rejects a cell that fits in neither rotation", () => {
    const opts: NUpOptions = { sheet: { width: 100, height: 100 }, cell: { width: 150, height: 50 }, orientation: "auto" };
    expectInputError(() => planNUp(opts), /do not fit/);
  });
});

function between(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

function integerBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: Rng, values: readonly T[], fallback: T): T {
  return values[Math.floor(rng() * values.length)] ?? fallback;
}

function randomOptions(rng: Rng): NUpOptions {
  const width = between(rng, 100, 800);
  const height = between(rng, 100, 800);
  return {
    sheet: { width, height },
    cell: { width: between(rng, 15, 200), height: between(rng, 15, 200) },
    gutter: rng() < 0.2 ? 0 : between(rng, 0, 20),
    margin: rng() < 0.2 ? 0 : between(rng, 0, 30),
    orientation: pick(rng, ORIENTATIONS, "upright"),
    ...(rng() < 0.2 ? { rows: integerBetween(rng, 1, 4) } : {}),
    ...(rng() < 0.2 ? { cols: integerBetween(rng, 1, 4) } : {}),
    pageCount: integerBetween(rng, 1, 600),
  };
}

function overlaps(a: NUpPlacement, b: NUpPlacement): boolean {
  return (
    a.x < b.x + b.width - TOLERANCE &&
    b.x < a.x + a.width - TOLERANCE &&
    a.y < b.y + b.height - TOLERANCE &&
    b.y < a.y + a.height - TOLERANCE
  );
}

/** Overlapping slot pairs, via a sweep along x. */
function overlapPairs(placements: readonly NUpPlacement[]): string[] {
  const byX = [...placements].sort((a, b) => a.x - b.x);
  const pairs: string[] = [];
  byX.forEach((a, i) => {
    for (let j = i + 1; j < byX.length; j += 1) {
      const b = byX[j];
      if (b === undefined || b.x >= a.x + a.width - TOLERANCE) break;
      if (overlaps(a, b)) pairs.push(`${a.index}/${b.index}`);
    }
  });
  return pairs;
}

/** Slots that leave the area inside the margins. */
function outside(opts: NUpOptions, plan: NUpPlan): number[] {
  const margin = opts.margin ?? 0;
  const { width, height } = opts.sheet;
  return plan.placements
    .filter(
      (p) =>
        p.x < margin - TOLERANCE ||
        p.y < margin - TOLERANCE ||
        p.x + p.width > width - margin + TOLERANCE ||
        p.y + p.height > height - margin + TOLERANCE,
    )
    .map((p) => p.index);
}

function checkPlan(opts: NUpOptions, plan: NUpPlan): void {
  const pageCount = opts.pageCount ?? 0;
  expect(plan.placements).toHaveLength(plan.cellsPerSheet);
  expect(plan.rows).toBeLessThanOrEqual(MAX_GRID);
  expect(plan.cols).toBeLessThanOrEqual(MAX_GRID);
  expect(outside(opts, plan), "slots outside the sheet").toEqual([]);
  expect(overlapPairs(plan.placements), "overlapping slots").toEqual([]);

  const pages = plan.sheets.flatMap((sheet) => sheet.pages);
  const numbers = pages.filter((page): page is number => page !== "blank");
  expect(numbers).toEqual(Array.from({ length: pageCount }, (_, i) => i + 1));
  expect(pages.length - numbers.length).toBe(plan.blankCount);
  expect(plan.blankCount).toBe(plan.sheets.length * plan.cellsPerSheet - pageCount);
  expect(plan.blankCount).toBeLessThan(plan.cellsPerSheet);
  expect(plan.sheets.every((sheet) => sheet.pages.length === plan.cellsPerSheet)).toBe(true);
}

describe("planNUp: properties", () => {
  it(`keeps every slot inside the sheet, without overlap, and every page once over ${PROPERTY_CASES} inputs`, () => {
    const rng = createRng(0x036a);
    let planned = 0;
    for (let i = 0; planned < PROPERTY_CASES; i += 1) {
      expect(i, "too many inputs rejected").toBeLessThan(PROPERTY_CASES * 4);
      const opts = randomOptions(rng);
      let plan: NUpPlan;
      try {
        plan = planNUp(opts);
      } catch (error) {
        expect(error).toBeInstanceOf(NestInputError);
        continue;
      }
      checkPlan(opts, plan);
      planned += 1;
    }
  });
});
