import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../src/errors.js";
import type { Job } from "../src/job.js";
import {
  INK_LIMIT_METHODS,
  INK_LIMIT_PERCENT_MAX,
  INK_LIMIT_PERCENT_MIN,
  normalizeJobInkLimit,
  parseInkLimitSetting,
  readJobInkLimit,
  type InkLimitSetting,
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

const GCR: InkLimitSetting = { limitPercent: 280, method: "gcr" };

describe("parseInkLimitSetting (spec 040b)", () => {
  it("returns undefined when the setting is absent", () => {
    expect(parseInkLimitSetting(undefined)).toBeUndefined();
  });

  it("exports the bounds of the ink-limit planner", () => {
    expect(INK_LIMIT_METHODS).toEqual(["proportional", "gcr"]);
    expect(INK_LIMIT_PERCENT_MIN).toBe(100);
    expect(INK_LIMIT_PERCENT_MAX).toBe(400);
  });

  it.each(INK_LIMIT_METHODS.map((method) => [method]))("accepts method %s", (method) => {
    expect(parseInkLimitSetting({ limitPercent: 300, method })).toEqual({ limitPercent: 300, method });
  });

  it("accepts a setting and returns a new object", () => {
    const input = { ...GCR };
    const parsed = parseInkLimitSetting(input);
    expect(parsed).toEqual(GCR);
    expect(parsed).not.toBe(input);
  });

  it("accepts each limitPercent bound inclusively", () => {
    for (const limitPercent of [INK_LIMIT_PERCENT_MIN, INK_LIMIT_PERCENT_MAX]) {
      expect(parseInkLimitSetting({ limitPercent, method: "proportional" })).toEqual({
        limitPercent,
        method: "proportional",
      });
    }
  });

  it.each([
    ["null", null],
    ["a string", "gcr"],
    ["a number", 300],
    ["a boolean", true],
    ["an array", [GCR]],
    ["a date", new Date(0)],
  ])("rejects %s", (_label, value) => {
    expect(() => parseInkLimitSetting(value)).toThrow(/inkLimit: must be a plain object/);
  });

  it("rejects unknown fields", () => {
    expect(() => parseInkLimitSetting({ ...GCR, extra: 1 })).toThrow(/inkLimit: unknown field "extra"/);
    expect(() => parseInkLimitSetting({ ...GCR, enabled: true })).toThrow(/unknown field "enabled"/);
    expect(() => parseInkLimitSetting({ ...GCR, extra: 1 })).toThrow(InvalidArgumentError);
  });

  it.each([
    ["missing", undefined],
    ["a string", "300"],
    ["null", null],
    ["a boolean", true],
    ["fractional", 250.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["below the minimum", 99],
    ["above the maximum", 401],
    ["zero", 0],
  ])("rejects a limitPercent that is %s", (_label, limitPercent) => {
    expect(() => parseInkLimitSetting({ limitPercent, method: "gcr" })).toThrow(
      /limitPercent must be an integer in 100..400/,
    );
  });

  it.each([
    ["missing", undefined],
    ["unknown", "gcr2"],
    ["differently cased", "GCR"],
    ["null", null],
    ["a number", 1],
  ])("rejects a method that is %s", (_label, method) => {
    expect(() => parseInkLimitSetting({ limitPercent: 300, method })).toThrow(
      /method must be one of proportional, gcr/,
    );
  });
});

describe("job read path for inkLimit (spec 040b)", () => {
  it("adds no key when inkLimit is absent", () => {
    const read = normalizeJobInkLimit(BASE_JOB);
    expect(read).not.toHaveProperty("inkLimit");
    expect(read).toEqual(BASE_JOB);
    expect(readJobInkLimit(undefined)).toBeUndefined();
  });

  it.each([
    ["the string 'yes'", "yes"],
    ["null", null],
    ["a limitPercent of 99", { limitPercent: 99, method: "gcr" }],
    ["a limitPercent of 401", { limitPercent: 401, method: "gcr" }],
    ["a limitPercent of 250.5", { limitPercent: 250.5, method: "gcr" }],
    ["an unknown method", { limitPercent: 300, method: "gcr2" }],
    ["an unknown field", { limitPercent: 300, method: "gcr", extra: 1 }],
  ])("drops %s and keeps the job readable", (_label, inkLimit) => {
    const read = normalizeJobInkLimit({ ...BASE_JOB, inkLimit });
    expect(read).not.toHaveProperty("inkLimit");
    expect(read).toEqual(BASE_JOB);
    expect(readJobInkLimit(inkLimit)).toBeUndefined();
  });

  it("keeps a valid setting", () => {
    expect(normalizeJobInkLimit({ ...BASE_JOB, inkLimit: { ...GCR } })).toEqual({ ...BASE_JOB, inkLimit: GCR });
    expect(readJobInkLimit({ limitPercent: 100, method: "proportional" })).toEqual({
      limitPercent: 100,
      method: "proportional",
    });
  });

  it("does not mutate the stored record", () => {
    const stored = { ...BASE_JOB, inkLimit: "yes" };
    normalizeJobInkLimit(stored);
    expect(stored.inkLimit).toBe("yes");
  });

  it("leaves whiteInk and screening untouched", () => {
    const job: Job = {
      ...BASE_JOB,
      whiteInk: { mode: "flood" },
      screening: { kind: "bayer", size: 8 },
      inkLimit: GCR,
    };
    expect(normalizeJobInkLimit(job)).toEqual(job);
  });

  it("survives a JSON round trip on a Job", () => {
    const job: Job = { ...BASE_JOB, inkLimit: GCR };
    const restored: unknown = JSON.parse(JSON.stringify(job));
    expect(restored).toEqual(job);
  });
});
