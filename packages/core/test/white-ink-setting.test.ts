import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../src/errors.js";
import type { Job } from "../src/job.js";
import {
  WHITE_INK_CHOKE_PX_MAX,
  WHITE_INK_CHOKE_PX_MIN,
  WHITE_INK_DENSITY_MAX,
  WHITE_INK_DENSITY_MIN,
  WHITE_INK_SEPARATION_NAME_MAX_LENGTH,
  WHITE_INK_THRESHOLD_MAX,
  WHITE_INK_THRESHOLD_MIN,
  normalizeJobWhiteInk,
  parseWhiteInkSetting,
  readJobWhiteInk,
  type WhiteInkSetting,
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

const FULL: WhiteInkSetting = {
  mode: "choke",
  threshold: 128,
  chokePx: 3,
  shape: "diamond",
  density: 80,
  invert: true,
  separationName: "Opaque White",
};

describe("parseWhiteInkSetting (spec 038b)", () => {
  it("returns undefined when the setting is absent", () => {
    expect(parseWhiteInkSetting(undefined)).toBeUndefined();
  });

  it("accepts a minimal setting without adding defaults", () => {
    expect(parseWhiteInkSetting({ mode: "flood" })).toEqual({ mode: "flood" });
    expect(Object.keys(parseWhiteInkSetting({ mode: "spot" }) ?? {})).toEqual(["mode"]);
  });

  it("accepts every field and returns a new object", () => {
    const input = { ...FULL };
    const parsed = parseWhiteInkSetting(input);
    expect(parsed).toEqual(FULL);
    expect(parsed).not.toBe(input);
  });

  it("accepts each bound inclusively", () => {
    expect(parseWhiteInkSetting({ mode: "spot", threshold: WHITE_INK_THRESHOLD_MIN })?.threshold).toBe(0);
    expect(parseWhiteInkSetting({ mode: "spot", threshold: WHITE_INK_THRESHOLD_MAX })?.threshold).toBe(255);
    expect(parseWhiteInkSetting({ mode: "choke", chokePx: WHITE_INK_CHOKE_PX_MIN })?.chokePx).toBe(0);
    expect(parseWhiteInkSetting({ mode: "choke", chokePx: WHITE_INK_CHOKE_PX_MAX })?.chokePx).toBe(64);
    expect(parseWhiteInkSetting({ mode: "flood", density: WHITE_INK_DENSITY_MIN })?.density).toBe(0);
    expect(parseWhiteInkSetting({ mode: "flood", density: WHITE_INK_DENSITY_MAX })?.density).toBe(100);
    const longest = "W".repeat(WHITE_INK_SEPARATION_NAME_MAX_LENGTH);
    expect(parseWhiteInkSetting({ mode: "flood", separationName: longest })?.separationName).toBe(longest);
    expect(parseWhiteInkSetting({ mode: "flood", separationName: "W" })?.separationName).toBe("W");
  });

  it.each([
    ["null", null],
    ["a string", "yes"],
    ["a number", 1],
    ["a boolean", true],
    ["an array", [{ mode: "flood" }]],
    ["a date", new Date(0)],
  ])("rejects %s", (_label, value) => {
    expect(() => parseWhiteInkSetting(value)).toThrow(InvalidArgumentError);
  });

  it("rejects a missing or unknown mode", () => {
    expect(() => parseWhiteInkSetting({})).toThrow(/mode must be one of flood, spot, choke/);
    expect(() => parseWhiteInkSetting({ mode: "x" })).toThrow(/mode must be one of/);
    expect(() => parseWhiteInkSetting({ mode: "FLOOD" })).toThrow(InvalidArgumentError);
  });

  it("rejects unknown fields", () => {
    expect(() => parseWhiteInkSetting({ mode: "flood", extra: 1 })).toThrow(/unknown field "extra"/);
    expect(() => parseWhiteInkSetting({ mode: "flood", enabled: true })).toThrow(/unknown field "enabled"/);
  });

  it.each([
    ["threshold", "128"],
    ["threshold", 1.5],
    ["chokePx", null],
    ["chokePx", 2.5],
    ["density", "100"],
    ["density", Number.NaN],
    ["shape", "round"],
    ["shape", 1],
    ["invert", "true"],
    ["invert", 1],
    ["separationName", 7],
    ["mode", undefined],
    ["threshold", undefined],
  ])("rejects %s = %s (wrong type)", (field, value) => {
    expect(() => parseWhiteInkSetting({ mode: "spot", [field]: value })).toThrow(InvalidArgumentError);
  });

  it.each([
    ["threshold", WHITE_INK_THRESHOLD_MIN - 1],
    ["threshold", WHITE_INK_THRESHOLD_MAX + 1],
    ["chokePx", WHITE_INK_CHOKE_PX_MIN - 1],
    ["chokePx", WHITE_INK_CHOKE_PX_MAX + 1],
    ["density", WHITE_INK_DENSITY_MIN - 1],
    ["density", WHITE_INK_DENSITY_MAX + 1],
    ["density", Number.POSITIVE_INFINITY],
  ])("rejects %s = %s (out of range)", (field, value) => {
    expect(() => parseWhiteInkSetting({ mode: "choke", [field]: value })).toThrow(
      new RegExp(`${field} must be an integer in`),
    );
  });

  it.each([
    ["empty", ""],
    ["too long", "W".repeat(WHITE_INK_SEPARATION_NAME_MAX_LENGTH + 1)],
    ["blank", "   "],
    ["non-ASCII", "Weiß"],
    ["a control character", "White\n"],
  ])("rejects a separation name that is %s", (_label, separationName) => {
    expect(() => parseWhiteInkSetting({ mode: "flood", separationName })).toThrow(/separationName must be 1..63/);
  });
});

describe("job read path for whiteInk (spec 038b)", () => {
  it("adds no key when whiteInk is absent, and white ink stays off", () => {
    const read = normalizeJobWhiteInk(BASE_JOB);
    expect(read).not.toHaveProperty("whiteInk");
    expect(read).toEqual(BASE_JOB);
    expect(readJobWhiteInk(undefined)).toBeUndefined();
  });

  it.each([
    ["the string 'yes'", "yes"],
    ["the number 1", 1],
    ["an unknown mode", { mode: "x" }],
    ["an unknown field", { mode: "flood", extra: 1 }],
    ["null", null],
    ["true", true],
  ])("drops %s and keeps the job readable", (_label, whiteInk) => {
    const read = normalizeJobWhiteInk({ ...BASE_JOB, whiteInk });
    expect(read).not.toHaveProperty("whiteInk");
    expect(read).toEqual(BASE_JOB);
    expect(readJobWhiteInk(whiteInk)).toBeUndefined();
  });

  it("keeps a valid setting", () => {
    const read = normalizeJobWhiteInk({ ...BASE_JOB, whiteInk: { ...FULL } });
    expect(read).toEqual({ ...BASE_JOB, whiteInk: FULL });
    expect(readJobWhiteInk({ mode: "flood" })).toEqual({ mode: "flood" });
  });

  it("does not mutate the stored record", () => {
    const stored = { ...BASE_JOB, whiteInk: "yes" };
    normalizeJobWhiteInk(stored);
    expect(stored.whiteInk).toBe("yes");
  });

  it("survives a JSON round trip on a Job", () => {
    const job: Job = { ...BASE_JOB, whiteInk: FULL };
    const restored: unknown = JSON.parse(JSON.stringify(job));
    expect(restored).toEqual(job);
  });
});
