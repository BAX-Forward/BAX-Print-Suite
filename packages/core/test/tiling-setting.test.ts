import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../src/errors.js";
import type { Job } from "../src/job.js";
import {
  MAX_TILING_PANELS_PER_AXIS,
  MAX_TILING_SEAMS_PER_AXIS,
  normalizeJobTiling,
  parseTilingSetting,
  readJobTiling,
  TILING_MAX_GAP_MM,
  TILING_MAX_OVERLAP_MM,
  TILING_MIN_SEAM_MM,
  TILING_SEAM_KINDS,
  type TilingSetting,
} from "../src/index.js";

const AT = "2026-11-06T09:00:00.000Z";

const BASE_JOB: Job = {
  id: "job-1",
  name: "fixture",
  status: "received",
  priority: 50,
  sourceFiles: [],
  artifacts: [],
  ticket: { intent: { quantity: 1 }, process: {} },
  tags: [],
  metadata: {},
  createdAt: AT,
  updatedAt: AT,
  lifecycle: "active",
  legalHold: false,
};

const GRID = { columns: 3, rows: 2 };
const TILED: TilingSetting = { grid: GRID };

describe("parseTilingSetting (spec 050a)", () => {
  it("returns undefined when the setting is absent", () => {
    expect(parseTilingSetting(undefined)).toBeUndefined();
  });

  it("exports the bounds mirrored from tile", () => {
    expect(TILING_SEAM_KINDS).toEqual(["butt", "overlap", "gap"]);
    expect(MAX_TILING_PANELS_PER_AXIS).toBe(500);
    expect(TILING_MAX_OVERLAP_MM).toBe(1000);
    expect(TILING_MAX_GAP_MM).toBe(1000);
  });

  it.each<[string, unknown]>([
    ["a grid alone", { grid: GRID }],
    ["the smallest grid", { grid: { columns: 1, rows: 1 } }],
    ["the largest grid", { grid: { columns: 500, rows: 500 } }],
    ["a butt seam", { grid: GRID, seam: { kind: "butt" } }],
    ["an overlap seam without a width", { grid: GRID, seam: { kind: "overlap" } }],
    ["an overlap of 0", { grid: GRID, seam: { kind: "overlap", overlapMm: 0 } }],
    ["a fractional overlap", { grid: GRID, seam: { kind: "overlap", overlapMm: 12.5 } }],
    ["the largest overlap", { grid: GRID, seam: { kind: "overlap", overlapMm: 1000 } }],
    ["a small gap", { grid: GRID, seam: { kind: "gap", gapMm: 0.1 } }],
    ["the largest gap", { grid: GRID, seam: { kind: "gap", gapMm: 1000 } }],
  ])("accepts %s", (_label, value) => {
    expect(parseTilingSetting(value)).toEqual(value);
  });

  it("returns new objects", () => {
    const input = { grid: { ...GRID }, seam: { kind: "gap", gapMm: 5 } };
    const parsed = parseTilingSetting(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed?.grid).not.toBe(input.grid);
    expect(parsed?.seam).not.toBe(input.seam);
  });

  it("accepts an object without a prototype", () => {
    const grid: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    grid.columns = 2;
    grid.rows = 2;
    expect(parseTilingSetting({ grid })).toEqual({ grid: { columns: 2, rows: 2 } });
  });

  it.each([
    ["null", null],
    ["a string", "3x2"],
    ["a number", 3],
    ["a boolean", true],
    ["an array", [GRID]],
    ["a date", new Date(0)],
  ])("rejects %s", (_label, value) => {
    expect(() => parseTilingSetting(value)).toThrow(/^tiling: must be a plain object/);
  });

  it("rejects an empty object", () => {
    expect(() => parseTilingSetting({})).toThrow("tiling: must name a grid (got an empty object)");
    expect(() => parseTilingSetting({})).toThrow(InvalidArgumentError);
  });

  it.each<[string, unknown, string]>([
    ["an unknown top-level field", { ...TILED, bleedMm: 3 }, 'tiling: unknown field "bleedMm"'],
    ["tile's seamTreatmentsX", { ...TILED, seamTreatmentsX: [] }, 'tiling: unknown field "seamTreatmentsX"'],
    ["tile's naming", { ...TILED, naming: { rows: "letters" } }, 'tiling: unknown field "naming"'],
    ["tile's grid mode", { grid: { ...GRID, mode: "count" } }, 'unknown field "mode" in grid'],
    ["a size grid", { grid: { maxWidthMm: 1000 } }, 'unknown field "maxWidthMm" in grid'],
    ["an unknown seam field", { ...TILED, seam: { kind: "butt", width: 1 } }, 'unknown field "width" in seam'],
    ["overlapMm on a butt seam", { ...TILED, seam: { kind: "butt", overlapMm: 5 } }, 'unknown field "overlapMm" in seam'],
    ["gapMm on a butt seam", { ...TILED, seam: { kind: "butt", gapMm: 5 } }, 'unknown field "gapMm" in seam'],
    ["gapMm on an overlap seam", { ...TILED, seam: { kind: "overlap", gapMm: 5 } }, 'unknown field "gapMm" in seam'],
    ["overlapMm on a gap seam", { ...TILED, seam: { kind: "gap", gapMm: 5, overlapMm: 5 } }, 'unknown field "overlapMm" in seam'],
  ])("rejects %s", (_label, value, message) => {
    expect(() => parseTilingSetting(value)).toThrow(message);
    expect(() => parseTilingSetting(value)).toThrow(InvalidArgumentError);
  });

  it("truncates a long unknown key in the message", () => {
    const key = "x".repeat(100);
    expect(() => parseTilingSetting({ ...TILED, [key]: 1 })).toThrow(`unknown field "${"x".repeat(64)}"`);
  });

  it.each([
    ["missing", { seam: { kind: "butt" } }],
    ["undefined", { grid: undefined }],
    ["null", { grid: null }],
    ["an array", { grid: [3, 2] }],
    ["a string", { grid: "3x2" }],
  ])("rejects a grid that is %s", (_label, value) => {
    expect(() => parseTilingSetting(value)).toThrow(/^tiling: grid must be a plain object/);
  });

  it.each([
    ["missing", undefined],
    ["a string", "2"],
    ["null", null],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
    ["above the maximum", 501],
  ])("rejects a column or row count that is %s", (_label, count) => {
    expect(() => parseTilingSetting({ grid: { columns: count, rows: 1 } })).toThrow(
      "tiling: grid.columns must be an integer in 1..500",
    );
    expect(() => parseTilingSetting({ grid: { columns: 1, rows: count } })).toThrow(
      "tiling: grid.rows must be an integer in 1..500",
    );
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "butt"],
    ["an array", [{ kind: "butt" }]],
  ])("rejects a seam that is %s", (_label, seam) => {
    expect(() => parseTilingSetting({ ...TILED, seam })).toThrow(/^tiling: seam must be a plain object/);
  });

  it.each([
    ["missing", {}],
    ["unknown", { kind: "glue" }],
    ["differently cased", { kind: "Butt" }],
    ["null", { kind: null }],
    ["a number", { kind: 1 }],
  ])("rejects a seam kind that is %s", (_label, seam) => {
    expect(() => parseTilingSetting({ ...TILED, seam })).toThrow("tiling: seam.kind must be one of butt, overlap, gap");
  });

  it.each([
    ["undefined", undefined],
    ["a string", "25"],
    ["null", null],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["negative", -0.5],
    ["above the maximum", 1000.5],
  ])("rejects an overlapMm that is %s", (_label, overlapMm) => {
    expect(() => parseTilingSetting({ ...TILED, seam: { kind: "overlap", overlapMm } })).toThrow(
      "tiling: seam.overlapMm must be a finite number at least 0 and at most 1000",
    );
  });

  it.each([
    ["missing", { kind: "gap" }],
    ["undefined", { kind: "gap", gapMm: undefined }],
    ["a string", { kind: "gap", gapMm: "5" }],
    ["zero", { kind: "gap", gapMm: 0 }],
    ["negative", { kind: "gap", gapMm: -1 }],
    ["NaN", { kind: "gap", gapMm: Number.NaN }],
    ["above the maximum", { kind: "gap", gapMm: 1001 }],
  ])("rejects a gapMm that is %s", (_label, seam) => {
    expect(() => parseTilingSetting({ ...TILED, seam })).toThrow(
      "tiling: seam.gapMm must be a finite number greater than 0 and at most 1000",
    );
  });
});

describe("job read path for tiling (spec 050a)", () => {
  it("adds no key when tiling is absent", () => {
    const read = normalizeJobTiling(BASE_JOB);
    expect(read).not.toHaveProperty("tiling");
    expect(read).toEqual(BASE_JOB);
    expect(JSON.stringify(read)).toBe(JSON.stringify(BASE_JOB));
    expect(readJobTiling(undefined)).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ["the string 'yes'", "yes"],
    ["null", null],
    ["an empty object", {}],
    ["a zero column count", { grid: { columns: 0, rows: 1 } }],
    ["a gap seam without gapMm", { grid: GRID, seam: { kind: "gap" } }],
    ["an unknown seam kind", { grid: GRID, seam: { kind: "glue" } }],
    ["an unknown field", { grid: GRID, bleedMm: 2 }],
  ])("drops %s and keeps the job readable", (_label, tiling) => {
    const read = normalizeJobTiling({ ...BASE_JOB, tiling });
    expect(read).not.toHaveProperty("tiling");
    expect(read).toEqual(BASE_JOB);
    expect(readJobTiling(tiling)).toBeUndefined();
  });

  it("keeps a valid setting", () => {
    const setting: TilingSetting = { grid: GRID, seam: { kind: "overlap", overlapMm: 30 } };
    expect(normalizeJobTiling({ ...BASE_JOB, tiling: { ...setting } })).toEqual({ ...BASE_JOB, tiling: setting });
    expect(readJobTiling(TILED)).toEqual(TILED);
  });

  it("does not mutate the stored record", () => {
    const stored = { ...BASE_JOB, tiling: "yes" };
    normalizeJobTiling(stored);
    expect(stored.tiling).toBe("yes");
  });

  it("leaves the other job settings untouched", () => {
    const job: Job = {
      ...BASE_JOB,
      whiteInk: { mode: "flood" },
      screening: { kind: "bayer", size: 8 },
      inkLimit: { limitPercent: 280, method: "gcr" },
      planeCurves: { k: { points: [{ in: 0, out: 0 }, { in: 255, out: 255 }], method: "linear" } },
      tiling: { grid: GRID, seam: { kind: "butt" } },
    };
    expect(normalizeJobTiling(job)).toEqual(job);
  });

  it("survives a JSON round trip on a Job", () => {
    const job: Job = { ...BASE_JOB, tiling: { grid: GRID, seam: { kind: "gap", gapMm: 10 } } };
    const restored: unknown = JSON.parse(JSON.stringify(job));
    expect(restored).toEqual(job);
  });
});

/** GRID is 3 × 2: two vertical seams, one horizontal. */
const SEAMS_X = [800, 2100.5];
const SEAMS_Y = [950];

describe("explicit seam positions (spec 050c)", () => {
  it("exports the seam bounds", () => {
    expect(MAX_TILING_SEAMS_PER_AXIS).toBe(499);
    expect(TILING_MIN_SEAM_MM).toBe(0);
  });

  it.each<[string, unknown]>([
    ["seamsX alone", { grid: GRID, seamsX: SEAMS_X }],
    ["seamsY alone", { grid: GRID, seamsY: SEAMS_Y }],
    ["both axes with a seam", { grid: GRID, seam: { kind: "butt" }, seamsX: SEAMS_X, seamsY: SEAMS_Y }],
    ["a tiny first seam", { grid: GRID, seamsX: [Number.MIN_VALUE, 1] }],
    ["empty lists on a 1 × 1 grid", { grid: { columns: 1, rows: 1 }, seamsX: [], seamsY: [] }],
    [
      "the most seams",
      { grid: { columns: 500, rows: 1 }, seamsX: Array.from({ length: 499 }, (_, i) => (i + 1) * 10) },
    ],
  ])("accepts %s", (_label, value) => {
    expect(parseTilingSetting(value)).toEqual(value);
  });

  it("returns new seam arrays", () => {
    const input = { grid: GRID, seamsX: [...SEAMS_X], seamsY: [...SEAMS_Y] };
    const parsed = parseTilingSetting(input);
    expect(parsed?.seamsX).toEqual(SEAMS_X);
    expect(parsed?.seamsX).not.toBe(input.seamsX);
    expect(parsed?.seamsY).not.toBe(input.seamsY);
  });

  it("orders the keys grid, seam, seamsX, seamsY", () => {
    const parsed = parseTilingSetting({ seamsY: SEAMS_Y, seamsX: SEAMS_X, seam: { kind: "butt" }, grid: GRID });
    expect(Object.keys(parsed ?? {})).toEqual(["grid", "seam", "seamsX", "seamsY"]);
  });

  it.each<[string, unknown, string]>([
    ["too few x seams", { grid: GRID, seamsX: [800] }, "tiling: seamsX must hold grid.columns - 1 = 2 seams (got 1)"],
    ["too many x seams", { grid: GRID, seamsX: [1, 2, 3] }, "tiling: seamsX must hold grid.columns - 1 = 2 seams (got 3)"],
    ["too many y seams", { grid: GRID, seamsY: [1, 2] }, "tiling: seamsY must hold grid.rows - 1 = 1 seams (got 2)"],
    ["no y seams", { grid: GRID, seamsY: [] }, "tiling: seamsY must hold grid.rows - 1 = 1 seams (got 0)"],
    ["a seam on a 1-column grid", { grid: { columns: 1, rows: 1 }, seamsX: [5] }, "seamsX must hold grid.columns - 1 = 0 seams"],
    ["equal seams", { grid: GRID, seamsX: [800, 800] }, "tiling: seamsX[1] must be a finite number greater than seamsX[0] (800)"],
    ["decreasing seams", { grid: GRID, seamsX: [900, 800] }, "seamsX[1] must be a finite number greater than seamsX[0] (900) (got 800)"],
    ["a zero seam", { grid: GRID, seamsY: [0] }, "tiling: seamsY[0] must be a finite number greater than 0 (got 0)"],
    ["a negative zero seam", { grid: GRID, seamsY: [-0] }, "tiling: seamsY[0] must be a finite number greater than 0"],
    ["a negative seam", { grid: GRID, seamsX: [-5, 10] }, "tiling: seamsX[0] must be a finite number greater than 0 (got -5)"],
    ["a NaN seam", { grid: GRID, seamsX: [800, Number.NaN] }, "tiling: seamsX[1] must be a finite number"],
    ["an infinite seam", { grid: GRID, seamsX: [800, Number.POSITIVE_INFINITY] }, "seamsX[1] must be a finite number"],
    ["a string seam", { grid: GRID, seamsY: ["950"] }, "tiling: seamsY[0] must be a finite number greater than 0 (got string)"],
    ["a null seam", { grid: GRID, seamsY: [null] }, "seamsY[0] must be a finite number greater than 0 (got null)"],
    ["a hole", { grid: GRID, seamsY: new Array<number>(1) }, "seamsY[0] must be a finite number greater than 0 (got undefined)"],
    ["a string list", { grid: GRID, seamsX: "800,2100" }, "tiling: seamsX must be an array of numbers (got string)"],
    ["an object list", { grid: GRID, seamsX: { 0: 800, 1: 2100 } }, "tiling: seamsX must be an array of numbers (got object)"],
    ["a null list", { grid: GRID, seamsY: null }, "tiling: seamsY must be an array of numbers (got null)"],
    ["an undefined list", { grid: GRID, seamsY: undefined }, "tiling: seamsY must be an array of numbers (got undefined)"],
    ["a number list", { grid: GRID, seamsY: 950 }, "tiling: seamsY must be an array of numbers (got 950)"],
    ["a differently cased field", { grid: GRID, SeamsX: SEAMS_X }, 'tiling: unknown field "SeamsX"'],
    ["seams inside the grid", { grid: { ...GRID, seamsX: SEAMS_X } }, 'unknown field "seamsX" in grid'],
  ])("rejects %s", (_label, value, message) => {
    expect(() => parseTilingSetting(value)).toThrow(message);
    expect(() => parseTilingSetting(value)).toThrow(InvalidArgumentError);
  });

  it("keeps valid seams on the job read path", () => {
    const setting: TilingSetting = { grid: GRID, seam: { kind: "overlap", overlapMm: 20 }, seamsX: SEAMS_X, seamsY: SEAMS_Y };
    expect(normalizeJobTiling({ ...BASE_JOB, tiling: { ...setting } })).toEqual({ ...BASE_JOB, tiling: setting });
    expect(readJobTiling(setting)).toEqual(setting);
  });

  it.each<[string, unknown]>([
    ["a count mismatch", { grid: GRID, seamsX: [800] }],
    ["non-increasing seams", { grid: GRID, seamsX: [800, 800] }],
    ["a NaN seam", { grid: GRID, seamsY: [Number.NaN] }],
    ["a negative seam", { grid: GRID, seamsY: [-1] }],
    ["a string list", { grid: GRID, seamsY: "950" }],
  ])("drops a tiling with %s exactly as other invalid tilings", (_label, tiling) => {
    const read = normalizeJobTiling({ ...BASE_JOB, tiling });
    expect(read).not.toHaveProperty("tiling");
    expect(read).toEqual(BASE_JOB);
    expect(JSON.stringify(read)).toBe(JSON.stringify(BASE_JOB));
  });

  it("survives a JSON round trip on a Job", () => {
    const job: Job = { ...BASE_JOB, tiling: { grid: GRID, seam: { kind: "gap", gapMm: 10 }, seamsX: SEAMS_X, seamsY: SEAMS_Y } };
    const restored: unknown = JSON.parse(JSON.stringify(job));
    expect(restored).toEqual(job);
    expect(normalizeJobTiling(job)).toEqual(job);
    expect(JSON.stringify(normalizeJobTiling(job))).toBe(JSON.stringify(job));
  });

  it.each<[string, TilingSetting]>([
    ["a grid alone", { grid: GRID }],
    ["a grid and a seam", { grid: GRID, seam: { kind: "overlap", overlapMm: 30 } }],
  ])("leaves %s without seams byte-identical", (_label, tiling) => {
    const job: Job = { ...BASE_JOB, tiling };
    const read = normalizeJobTiling(job);
    expect(JSON.stringify(read)).toBe(JSON.stringify(job));
    expect(read).toStrictEqual(job);
    const parsed = parseTilingSetting(tiling);
    expect(parsed).not.toHaveProperty("seamsX");
    expect(parsed).not.toHaveProperty("seamsY");
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(tiling));
  });
});
