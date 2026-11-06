import { describe, expect, it } from "vitest";
import {
  MAX_CREEP_PT,
  MAX_PAGES,
  NestInputError,
  planBooklet,
  type BookletBinding,
  type BookletOptions,
  type BookletPlan,
  type SignaturePages,
} from "../src/index.js";
import { createRng, type Rng } from "../src/rng.js";

const PT_PER_MM = 72 / 25.4;
const DIGITS = 9;
const PROPERTY_CASES = 600;
const SIGNATURES: readonly SignaturePages[] = [4, 8, 16, "single"];
const BINDINGS: readonly BookletBinding[] = ["left", "right"];

function base(extra: Partial<BookletOptions> = {}): BookletOptions {
  return { pageCount: 8, signaturePages: "single", binding: "left", ...extra };
}

function sides(plan: BookletPlan): unknown[] {
  return plan.sheets.map((sheet) => ({ front: sheet.front, back: sheet.back }));
}

function expectInputError(run: () => unknown, message: RegExp): void {
  expect(run).toThrow(NestInputError);
  expect(run).toThrow(message);
}

describe("planBooklet: saddle-stitch order", () => {
  it("lays out an 8-page saddle stitch", () => {
    const plan = planBooklet(base());
    expect(sides(plan)).toEqual([
      { front: [8, 1], back: [2, 7] },
      { front: [6, 3], back: [4, 5] },
    ]);
    expect(plan.sheets.map((s) => [s.index, s.signature, s.position])).toEqual([
      [0, 0, 0],
      [1, 0, 1],
    ]);
    expect(plan.paddedPageCount).toBe(8);
    expect(plan.blankCount).toBe(0);
    expect(plan.signatureCount).toBe(1);
    expect(plan.sheetsPerSignature).toBe(2);
  });

  it("matches the single layout with one 8-page signature", () => {
    expect(sides(planBooklet(base({ signaturePages: 8 })))).toEqual(sides(planBooklet(base())));
  });

  it("lays out a 4-page folder", () => {
    expect(sides(planBooklet(base({ pageCount: 4 })))).toEqual([{ front: [4, 1], back: [2, 3] }]);
  });

  it("lays out a 16-page single signature", () => {
    expect(sides(planBooklet(base({ pageCount: 16 })))).toEqual([
      { front: [16, 1], back: [2, 15] },
      { front: [14, 3], back: [4, 13] },
      { front: [12, 5], back: [6, 11] },
      { front: [10, 7], back: [8, 9] },
    ]);
  });

  it("gathers consecutive signatures", () => {
    const plan = planBooklet(base({ pageCount: 16, signaturePages: 8 }));
    expect(plan.signatureCount).toBe(2);
    expect(sides(plan)).toEqual([
      { front: [8, 1], back: [2, 7] },
      { front: [6, 3], back: [4, 5] },
      { front: [16, 9], back: [10, 15] },
      { front: [14, 11], back: [12, 13] },
    ]);
    expect(plan.sheets.map((s) => [s.signature, s.position])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
  });

  it("mirrors every side for right binding", () => {
    const plan = planBooklet(base({ binding: "right" }));
    expect(plan.binding).toBe("right");
    expect(sides(plan)).toEqual([
      { front: [1, 8], back: [7, 2] },
      { front: [3, 6], back: [5, 4] },
    ]);
  });

  it("is deterministic", () => {
    expect(planBooklet(base({ pageCount: 37, creep: 0.25 }))).toEqual(planBooklet(base({ pageCount: 37, creep: 0.25 })));
  });
});

describe("planBooklet: padding", () => {
  it("pads a single signature to a multiple of 4 with blanks at the end", () => {
    const plan = planBooklet(base({ pageCount: 5 }));
    expect(plan.paddedPageCount).toBe(8);
    expect(plan.blankCount).toBe(3);
    expect(sides(plan)).toEqual([
      { front: ["blank", 1], back: [2, "blank"] },
      { front: ["blank", 3], back: [4, 5] },
    ]);
  });

  it.each([
    [1, "single", 4, 3],
    [4, "single", 4, 0],
    [9, "single", 12, 3],
    [10, 16, 16, 6],
    [17, 4, 20, 3],
    [17, 8, 24, 7],
    [33, 16, 48, 15],
  ] as const)("pads %s pages with %s-page signatures to %s (%s blanks)", (pageCount, signaturePages, padded, blanks) => {
    const plan = planBooklet(base({ pageCount, signaturePages }));
    expect(plan.paddedPageCount).toBe(padded);
    expect(plan.blankCount).toBe(blanks);
    expect(plan.sheets).toHaveLength(padded / 4);
  });

  it("allows MAX_PAGES pages", () => {
    const plan = planBooklet(base({ pageCount: MAX_PAGES }));
    expect(plan.sheets).toHaveLength(MAX_PAGES / 4);
  });
});

describe("planBooklet: creep", () => {
  it("defaults to no creep", () => {
    expect(planBooklet(base({ pageCount: 16 })).sheets.map((s) => s.creep)).toEqual([0, 0, 0, 0]);
  });

  it("is 0 on the outermost sheet and grows inward", () => {
    const creeps = planBooklet(base({ pageCount: 16, creep: 0.5 })).sheets.map((s) => s.creep);
    expect(creeps).toEqual([0, 0.5, 1, 1.5]);
  });

  it("restarts in every signature", () => {
    const creeps = planBooklet(base({ pageCount: 16, signaturePages: 8, creep: 1 })).sheets.map((s) => s.creep);
    expect(creeps).toEqual([0, 1, 0, 1]);
  });

  it("accepts an innermost creep of exactly 10 mm", () => {
    const plan = planBooklet(base({ pageCount: 16, creep: MAX_CREEP_PT / 3 }));
    expect(plan.sheets[plan.sheets.length - 1]?.creep).toBeCloseTo(10 * PT_PER_MM, DIGITS);
  });

  it("rejects an innermost creep over 10 mm", () => {
    expectInputError(() => planBooklet(base({ pageCount: 16, creep: 10 })), /reaches 30 pt, more than the limit/);
  });

  it("rejects a per-sheet creep over 10 mm even on one sheet", () => {
    expectInputError(() => planBooklet(base({ pageCount: 4, creep: 30 })), /creep must be at most/);
  });

  it.each([-0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects creep %s", (creep) => {
    expectInputError(() => planBooklet(base({ creep })), /creep must/);
  });
});

describe("planBooklet: validation", () => {
  it.each([0, -4, 2.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects pageCount %s", (pageCount) => {
    expectInputError(() => planBooklet(base({ pageCount })), /pageCount must be/);
  });

  it("rejects more than MAX_PAGES pages", () => {
    expectInputError(() => planBooklet(base({ pageCount: MAX_PAGES + 1 })), /pageCount must be at most 10000/);
  });
});

function pick<T>(rng: Rng, values: readonly T[], fallback: T): T {
  return values[Math.floor(rng() * values.length)] ?? fallback;
}

function randomOptions(rng: Rng): BookletOptions {
  return {
    pageCount: 1 + Math.floor(rng() * 2000),
    signaturePages: pick(rng, SIGNATURES, "single"),
    binding: pick(rng, BINDINGS, "left"),
    creep: rng() < 0.3 ? 0 : rng() * 0.01,
  };
}

/** Problems found in one plan; empty when every invariant holds. */
function violations(opts: BookletOptions, plan: BookletPlan): string[] {
  const problems: string[] = [];
  const padTo = opts.signaturePages === "single" ? 4 : opts.signaturePages;
  const { paddedPageCount, pageCount } = plan;
  if (paddedPageCount % padTo !== 0) problems.push(`padded ${paddedPageCount} is not a multiple of ${padTo}`);
  if (paddedPageCount < pageCount || paddedPageCount - pageCount >= padTo) problems.push(`padded ${paddedPageCount}`);
  if (plan.sheets.length * 4 !== paddedPageCount) problems.push(`${plan.sheets.length} sheets`);

  const slots = plan.sheets.flatMap((s) => [...s.front, ...s.back]);
  const numbers = slots.filter((slot): slot is number => slot !== "blank").sort((a, b) => a - b);
  const expected = Array.from({ length: pageCount }, (_, i) => i + 1);
  if (numbers.join(",") !== expected.join(",")) problems.push("pages are not 1..pageCount exactly once");
  const blanks = slots.length - numbers.length;
  if (blanks !== paddedPageCount - pageCount || blanks !== plan.blankCount) problems.push(`${blanks} blanks`);

  plan.sheets.forEach((sheet, index) => {
    const previous = plan.sheets[index - 1];
    if (sheet.position === 0 && sheet.creep !== 0) problems.push(`sheet ${index} outermost creep ${sheet.creep}`);
    if (sheet.position > 0 && previous !== undefined && sheet.creep < previous.creep) {
      problems.push(`sheet ${index} creep decreases`);
    }
    if (sheet.creep > MAX_CREEP_PT + 1e-7) problems.push(`sheet ${index} creep ${sheet.creep}`);
  });
  return problems;
}

describe("planBooklet: properties", () => {
  it(`places every page once and pads with blanks over ${PROPERTY_CASES} inputs`, () => {
    const rng = createRng(0x036b);
    for (let i = 0; i < PROPERTY_CASES; i += 1) {
      const opts = randomOptions(rng);
      expect(violations(opts, planBooklet(opts)), JSON.stringify(opts)).toEqual([]);
    }
  });
});
