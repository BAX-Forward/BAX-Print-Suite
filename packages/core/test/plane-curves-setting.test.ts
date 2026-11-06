import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../src/errors.js";
import type { Job } from "../src/job.js";
import {
  normalizeJobPlaneCurves,
  parsePlaneCurvesSetting,
  PLANE_CURVE_CHANNELS,
  PLANE_CURVE_METHODS,
  PLANE_CURVES_MAX_POINTS,
  PLANE_CURVES_MAX_VALUE,
  PLANE_CURVES_MIN_POINTS,
  readJobPlaneCurves,
  type PlaneCurve,
  type PlaneCurvesSetting,
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

const IDENTITY: PlaneCurve = { points: [{ in: 0, out: 0 }, { in: 255, out: 255 }], method: "linear" };
const DOT_GAIN: PlaneCurve = {
  points: [{ in: 0, out: 0 }, { in: 128, out: 108 }, { in: 255, out: 255 }],
  method: "monotone",
};
const CYAN: PlaneCurvesSetting = { c: DOT_GAIN };

/** A sparse point list: index 1 is a hole, which must be rejected like a missing point. */
const HOLED: unknown[] = [{ in: 0, out: 0 }];
HOLED[2] = { in: 255, out: 255 };

/** A cyan curve with the given points. */
function cyanPoints(points: unknown): unknown {
  return { c: { points, method: "linear" } };
}

describe("parsePlaneCurvesSetting (spec 044b)", () => {
  it("returns undefined when the setting is absent", () => {
    expect(parsePlaneCurvesSetting(undefined)).toBeUndefined();
  });

  it("exports the bounds of the linearization LUT builder", () => {
    expect(PLANE_CURVE_CHANNELS).toEqual(["c", "m", "y", "k"]);
    expect(PLANE_CURVE_METHODS).toEqual(["monotone", "linear"]);
    expect(PLANE_CURVES_MIN_POINTS).toBe(2);
    expect(PLANE_CURVES_MAX_POINTS).toBe(256);
    expect(PLANE_CURVES_MAX_VALUE).toBe(255);
  });

  it.each(PLANE_CURVE_CHANNELS.map((channel) => [channel]))("accepts a curve on channel %s alone", (channel) => {
    expect(parsePlaneCurvesSetting({ [channel]: DOT_GAIN })).toEqual({ [channel]: DOT_GAIN });
  });

  it.each(PLANE_CURVE_METHODS.map((method) => [method]))("accepts method %s", (method) => {
    expect(parsePlaneCurvesSetting({ k: { ...IDENTITY, method } })).toEqual({ k: { ...IDENTITY, method } });
  });

  it("accepts all four channels and returns new objects", () => {
    const input = { c: { ...DOT_GAIN }, m: { ...IDENTITY }, y: { ...IDENTITY }, k: { ...DOT_GAIN } };
    const parsed = parsePlaneCurvesSetting(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed?.c).not.toBe(input.c);
    expect(parsed?.c?.points).not.toBe(input.c.points);
    expect(parsed?.c?.points[1]).not.toBe(input.c.points[1]);
  });

  it("accepts the minimum and maximum point counts", () => {
    expect(parsePlaneCurvesSetting(cyanPoints(IDENTITY.points))).toEqual({ c: IDENTITY });
    const full = Array.from({ length: PLANE_CURVES_MAX_POINTS }, (_, index) => ({ in: index, out: index }));
    expect(parsePlaneCurvesSetting(cyanPoints(full))).toEqual({ c: { points: full, method: "linear" } });
  });

  it("accepts flat runs, a flat curve, and the output bounds", () => {
    const flatRun = [{ in: 0, out: 0 }, { in: 100, out: 80 }, { in: 200, out: 80 }, { in: 255, out: 255 }];
    expect(parsePlaneCurvesSetting(cyanPoints(flatRun))).toEqual({ c: { points: flatRun, method: "linear" } });
    const flat = [{ in: 0, out: 255 }, { in: 255, out: 255 }];
    expect(parsePlaneCurvesSetting(cyanPoints(flat))).toEqual({ c: { points: flat, method: "linear" } });
    const zero = [{ in: 0, out: 0 }, { in: 255, out: 0 }];
    expect(parsePlaneCurvesSetting(cyanPoints(zero))).toEqual({ c: { points: zero, method: "linear" } });
  });

  it.each([
    ["null", null],
    ["a string", "c"],
    ["a number", 1],
    ["a boolean", true],
    ["an array", [DOT_GAIN]],
    ["a date", new Date(0)],
  ])("rejects %s", (_label, value) => {
    expect(() => parsePlaneCurvesSetting(value)).toThrow(/^planeCurves: must be a plain object/);
  });

  it("rejects an empty object", () => {
    expect(() => parsePlaneCurvesSetting({})).toThrow(
      "planeCurves: must name at least one channel of c, m, y, k (got an empty object)",
    );
    expect(() => parsePlaneCurvesSetting({})).toThrow(InvalidArgumentError);
  });

  it.each([
    ["an unknown channel", { ...CYAN, r: IDENTITY }, 'planeCurves: unknown field "r"'],
    ["an upper-case channel", { C: IDENTITY }, 'planeCurves: unknown field "C"'],
    ["an unknown curve field", { c: { ...IDENTITY, gamma: 1 } }, 'unknown field "gamma" in c'],
    [
      "an unknown point field",
      cyanPoints([{ in: 0, out: 0, x: 1 }, { in: 255, out: 255 }]),
      'unknown field "x" in c.points[0]',
    ],
  ])("rejects %s", (_label, value, message) => {
    expect(() => parsePlaneCurvesSetting(value)).toThrow(message);
    expect(() => parsePlaneCurvesSetting(value)).toThrow(InvalidArgumentError);
  });

  it.each([
    ["undefined", { c: undefined }],
    ["null", { m: null }],
    ["an array", { y: [IDENTITY] }],
    ["a string", { k: "linear" }],
  ])("rejects a channel that is %s", (_label, value) => {
    expect(() => parsePlaneCurvesSetting(value)).toThrow(/^planeCurves: [cmyk] must be a plain object/);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["an object", { 0: { in: 0, out: 0 } }],
    ["a string", "0,255"],
  ])("rejects points that are %s", (_label, points) => {
    expect(() => parsePlaneCurvesSetting(cyanPoints(points))).toThrow("planeCurves: c.points must be an array");
  });

  it.each([
    ["empty", []],
    ["a single point", [{ in: 0, out: 0 }]],
    ["above the maximum", Array.from({ length: PLANE_CURVES_MAX_POINTS + 1 }, (_, index) => ({ in: index, out: 0 }))],
  ])("rejects a point count that is %s", (_label, points) => {
    expect(() => parsePlaneCurvesSetting(cyanPoints(points))).toThrow("c.points must have 2..256 points");
  });

  it.each([
    ["null", [{ in: 0, out: 0 }, null]],
    ["a number", [{ in: 0, out: 0 }, 255]],
    ["an array", [{ in: 0, out: 0 }, [255, 255]]],
    ["a hole", HOLED],
  ])("rejects a point that is %s", (_label, points) => {
    expect(() => parsePlaneCurvesSetting(cyanPoints(points))).toThrow("c.points[1] must be a plain object");
  });

  it.each([
    ["missing", undefined],
    ["a string", "128"],
    ["null", null],
    ["fractional", 127.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["above the maximum", 256],
  ])("rejects an input or output level that is %s", (_label, level) => {
    expect(() => parsePlaneCurvesSetting(cyanPoints([{ in: 0, out: 0 }, { in: level, out: 9 }, { in: 255, out: 255 }]))).toThrow(
      "c.points[1].in must be an integer in 0..255",
    );
    expect(() => parsePlaneCurvesSetting(cyanPoints([{ in: 0, out: 0 }, { in: 9, out: level }, { in: 255, out: 255 }]))).toThrow(
      "c.points[1].out must be an integer in 0..255",
    );
  });

  it.each([
    ["the first input is not 0", [{ in: 1, out: 0 }, { in: 255, out: 255 }], "(got 1..255)"],
    ["the last input is not 255", [{ in: 0, out: 0 }, { in: 254, out: 255 }], "(got 0..254)"],
    ["both endpoints are missing", [{ in: 10, out: 0 }, { in: 20, out: 255 }], "(got 10..20)"],
    ["the inputs run backwards", [{ in: 255, out: 0 }, { in: 0, out: 255 }], "(got 255..0)"],
  ])("rejects points where %s", (_label, points, got) => {
    expect(() => parsePlaneCurvesSetting(cyanPoints(points))).toThrow(
      `planeCurves: c.points must start at in 0 and end at in 255 ${got}`,
    );
  });

  it.each([
    ["repeat", [{ in: 0, out: 0 }, { in: 128, out: 100 }, { in: 128, out: 120 }, { in: 255, out: 255 }], "c.points[2].in must be greater than 128 (got 128)"],
    ["decrease", [{ in: 0, out: 0 }, { in: 200, out: 0 }, { in: 100, out: 0 }, { in: 255, out: 255 }], "c.points[2].in must be greater than 200 (got 100)"],
  ])("rejects inputs that %s", (_label, points, message) => {
    expect(() => parsePlaneCurvesSetting(cyanPoints(points))).toThrow(message);
  });

  it.each([
    ["at the end", [{ in: 0, out: 10 }, { in: 255, out: 5 }], "c.points[1].out must be at least 10 (got 5)"],
    ["in the middle", [{ in: 0, out: 0 }, { in: 100, out: 90 }, { in: 200, out: 89 }, { in: 255, out: 255 }], "c.points[2].out must be at least 90 (got 89)"],
  ])("rejects outputs that decrease %s", (_label, points, message) => {
    expect(() => parsePlaneCurvesSetting(cyanPoints(points))).toThrow(message);
  });

  it.each([
    ["missing", undefined],
    ["unknown", "cubic"],
    ["differently cased", "Linear"],
    ["null", null],
    ["a number", 1],
  ])("rejects a method that is %s", (_label, method) => {
    expect(() => parsePlaneCurvesSetting({ m: { points: IDENTITY.points, method } })).toThrow(
      "planeCurves: m.method must be one of monotone, linear",
    );
  });

  it("rejects the whole setting when one channel is invalid", () => {
    expect(() => parsePlaneCurvesSetting({ c: IDENTITY, k: { ...IDENTITY, method: "cubic" } })).toThrow(
      "k.method must be one of monotone, linear",
    );
  });
});

describe("job read path for planeCurves (spec 044b)", () => {
  it("adds no key when planeCurves is absent", () => {
    const read = normalizeJobPlaneCurves(BASE_JOB);
    expect(read).not.toHaveProperty("planeCurves");
    expect(read).toEqual(BASE_JOB);
    expect(readJobPlaneCurves(undefined)).toBeUndefined();
  });

  it.each([
    ["the string 'yes'", "yes"],
    ["null", null],
    ["an empty object", {}],
    ["a single point", cyanPoints([{ in: 0, out: 0 }])],
    ["a missing endpoint", cyanPoints([{ in: 0, out: 0 }, { in: 254, out: 255 }])],
    ["a decreasing output", cyanPoints([{ in: 0, out: 9 }, { in: 255, out: 8 }])],
    ["an unknown method", { c: { ...IDENTITY, method: "cubic" } }],
    ["an unknown channel", { ...CYAN, w: IDENTITY }],
  ])("drops %s and keeps the job readable", (_label, planeCurves) => {
    const read = normalizeJobPlaneCurves({ ...BASE_JOB, planeCurves });
    expect(read).not.toHaveProperty("planeCurves");
    expect(read).toEqual(BASE_JOB);
    expect(readJobPlaneCurves(planeCurves)).toBeUndefined();
  });

  it("keeps a valid setting", () => {
    expect(normalizeJobPlaneCurves({ ...BASE_JOB, planeCurves: { ...CYAN } })).toEqual({ ...BASE_JOB, planeCurves: CYAN });
    expect(readJobPlaneCurves({ k: IDENTITY })).toEqual({ k: IDENTITY });
  });

  it("does not mutate the stored record", () => {
    const stored = { ...BASE_JOB, planeCurves: "yes" };
    normalizeJobPlaneCurves(stored);
    expect(stored.planeCurves).toBe("yes");
  });

  it("leaves whiteInk, screening and inkLimit untouched", () => {
    const job: Job = {
      ...BASE_JOB,
      whiteInk: { mode: "flood" },
      screening: { kind: "bayer", size: 8 },
      inkLimit: { limitPercent: 280, method: "gcr" },
      planeCurves: CYAN,
    };
    expect(normalizeJobPlaneCurves(job)).toEqual(job);
  });

  it("survives a JSON round trip on a Job", () => {
    const job: Job = { ...BASE_JOB, planeCurves: { c: DOT_GAIN, m: IDENTITY, y: IDENTITY, k: DOT_GAIN } };
    const restored: unknown = JSON.parse(JSON.stringify(job));
    expect(restored).toEqual(job);
  });
});
