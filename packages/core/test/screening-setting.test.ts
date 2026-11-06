import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../src/errors.js";
import type { Job } from "../src/job.js";
import {
  SCREENING_BAYER_SIZES,
  SCREENING_BLUE_NOISE_SIZE_MAX,
  SCREENING_BLUE_NOISE_SIZE_MIN,
  SCREENING_ERROR_DIFFUSION_KERNELS,
  SCREENING_SEED_MAX,
  SCREENING_SEED_MIN,
  normalizeJobScreening,
  parseScreeningSetting,
  readJobScreening,
  type ScreeningSetting,
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

const BLUE: ScreeningSetting = { kind: "blue-noise", size: 64, seed: 42 };

describe("parseScreeningSetting (spec 039b)", () => {
  it("returns undefined when the setting is absent", () => {
    expect(parseScreeningSetting(undefined)).toBeUndefined();
  });

  it("exports the bounds of the screening library", () => {
    expect(SCREENING_BAYER_SIZES).toEqual([2, 4, 8, 16]);
    expect(SCREENING_BLUE_NOISE_SIZE_MIN).toBe(2);
    expect(SCREENING_BLUE_NOISE_SIZE_MAX).toBe(256);
    expect(SCREENING_SEED_MIN).toBe(0);
    expect(SCREENING_SEED_MAX).toBe(4294967295);
  });

  it.each(SCREENING_BAYER_SIZES.map((size) => [size]))("accepts bayer size %i", (size) => {
    expect(parseScreeningSetting({ kind: "bayer", size })).toEqual({ kind: "bayer", size });
  });

  it("accepts a blue-noise setting and returns a new object", () => {
    const input = { ...BLUE };
    const parsed = parseScreeningSetting(input);
    expect(parsed).toEqual(BLUE);
    expect(parsed).not.toBe(input);
  });

  it("accepts each blue-noise bound inclusively", () => {
    for (const size of [SCREENING_BLUE_NOISE_SIZE_MIN, SCREENING_BLUE_NOISE_SIZE_MAX]) {
      expect(parseScreeningSetting({ kind: "blue-noise", size, seed: 1 })).toEqual({ kind: "blue-noise", size, seed: 1 });
    }
    for (const seed of [SCREENING_SEED_MIN, SCREENING_SEED_MAX]) {
      expect(parseScreeningSetting({ kind: "blue-noise", size: 8, seed })).toEqual({ kind: "blue-noise", size: 8, seed });
    }
  });

  it.each([
    ["null", null],
    ["a string", "yes"],
    ["a number", 1],
    ["a boolean", true],
    ["an array", [{ kind: "bayer", size: 4 }]],
    ["a date", new Date(0)],
  ])("rejects %s", (_label, value) => {
    expect(() => parseScreeningSetting(value)).toThrow(/screening: must be a plain object/);
  });

  it("rejects a missing or unknown kind", () => {
    expect(() => parseScreeningSetting({})).toThrow(/kind must be one of bayer, blue-noise/);
    expect(() => parseScreeningSetting({ kind: "x" })).toThrow(/kind must be one of/);
    expect(() => parseScreeningSetting({ kind: "Bayer", size: 4 })).toThrow(InvalidArgumentError);
    expect(() => parseScreeningSetting({ kind: 1, size: 4 })).toThrow(InvalidArgumentError);
  });

  it("rejects unknown fields, including a seed on bayer", () => {
    expect(() => parseScreeningSetting({ kind: "bayer", size: 4, extra: 1 })).toThrow(/unknown field "extra" for bayer/);
    expect(() => parseScreeningSetting({ kind: "bayer", size: 4, seed: 1 })).toThrow(/unknown field "seed" for bayer/);
    expect(() => parseScreeningSetting({ ...BLUE, enabled: true })).toThrow(/unknown field "enabled" for blue-noise/);
  });

  it.each([
    ["missing", undefined],
    ["a string", "4"],
    ["null", null],
    ["fractional", 4.5],
    ["not a power of two", 3],
    ["too small", 1],
    ["too large", 32],
    ["zero", 0],
  ])("rejects a bayer size that is %s", (_label, size) => {
    expect(() => parseScreeningSetting({ kind: "bayer", size })).toThrow(/size must be one of 2, 4, 8, 16 for bayer/);
  });

  it.each([
    ["missing", undefined],
    ["a string", "64"],
    ["fractional", 2.5],
    ["NaN", Number.NaN],
    ["below the minimum", SCREENING_BLUE_NOISE_SIZE_MIN - 1],
    ["above the maximum", SCREENING_BLUE_NOISE_SIZE_MAX + 1],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("rejects a blue-noise size that is %s", (_label, size) => {
    expect(() => parseScreeningSetting({ kind: "blue-noise", size, seed: 1 })).toThrow(/size must be an integer in 2..256/);
  });

  it.each([
    ["missing", undefined],
    ["a string", "1"],
    ["a boolean", true],
    ["fractional", 1.5],
    ["negative", SCREENING_SEED_MIN - 1],
    ["above uint32", SCREENING_SEED_MAX + 1],
  ])("rejects a blue-noise seed that is %s", (_label, seed) => {
    expect(() => parseScreeningSetting({ kind: "blue-noise", size: 8, seed })).toThrow(
      /seed must be an integer in 0..4294967295/,
    );
  });
});

describe("parseScreeningSetting: error diffusion (spec 045c)", () => {
  it("exports the kernel list of the media library", () => {
    expect(SCREENING_ERROR_DIFFUSION_KERNELS).toEqual(["floyd-steinberg", "jarvis-judice-ninke"]);
  });

  it.each(SCREENING_ERROR_DIFFUSION_KERNELS.map((kernel) => [kernel]))("accepts kernel %s", (kernel) => {
    expect(parseScreeningSetting({ kind: "error-diffusion", kernel })).toStrictEqual({ kind: "error-diffusion", kernel });
  });

  it.each([true, false])("keeps serpentine %s", (serpentine) => {
    const input = { kind: "error-diffusion", kernel: "jarvis-judice-ninke", serpentine };
    const parsed = parseScreeningSetting(input);
    expect(parsed).toStrictEqual(input);
    expect(parsed).not.toBe(input);
  });

  it("does not default serpentine when it is absent", () => {
    expect(parseScreeningSetting({ kind: "error-diffusion", kernel: "floyd-steinberg" })).not.toHaveProperty("serpentine");
  });

  it.each([
    ["missing", undefined],
    ["unknown", "atkinson"],
    ["of the wrong case", "Floyd-Steinberg"],
    ["a number", 1],
    ["null", null],
  ])("rejects a kernel that is %s", (_label, kernel) => {
    expect(() => parseScreeningSetting({ kind: "error-diffusion", kernel })).toThrow(
      /kernel must be one of floyd-steinberg, jarvis-judice-ninke for error-diffusion/,
    );
  });

  it.each([
    ["a string", "true"],
    ["a number", 1],
    ["null", null],
    ["undefined", undefined],
  ])("rejects a serpentine that is %s", (_label, serpentine) => {
    expect(() => parseScreeningSetting({ kind: "error-diffusion", kernel: "floyd-steinberg", serpentine })).toThrow(
      /serpentine must be a boolean for error-diffusion/,
    );
  });

  it("rejects unknown fields, including a size or seed", () => {
    const base = { kind: "error-diffusion", kernel: "floyd-steinberg" };
    expect(() => parseScreeningSetting({ ...base, size: 4 })).toThrow(/unknown field "size" for error-diffusion/);
    expect(() => parseScreeningSetting({ ...base, seed: 1 })).toThrow(/unknown field "seed" for error-diffusion/);
    expect(() => parseScreeningSetting({ ...base, extra: 1 })).toThrow(/unknown field "extra" for error-diffusion/);
  });

  it("rejects error-diffusion fields on the threshold kinds", () => {
    expect(() => parseScreeningSetting({ kind: "bayer", size: 4, kernel: "floyd-steinberg" })).toThrow(
      /unknown field "kernel" for bayer/,
    );
    expect(() => parseScreeningSetting({ ...BLUE, serpentine: true })).toThrow(/unknown field "serpentine" for blue-noise/);
  });
});

describe("stored screening values round-trip unchanged (spec 045c)", () => {
  const STORED: readonly ScreeningSetting[] = [
    ...SCREENING_BAYER_SIZES.map((size): ScreeningSetting => ({ kind: "bayer", size })),
    { kind: "blue-noise", size: SCREENING_BLUE_NOISE_SIZE_MIN, seed: SCREENING_SEED_MIN },
    { kind: "blue-noise", size: 64, seed: 42 },
    { kind: "blue-noise", size: SCREENING_BLUE_NOISE_SIZE_MAX, seed: SCREENING_SEED_MAX },
    { kind: "error-diffusion", kernel: "floyd-steinberg" },
    { kind: "error-diffusion", kernel: "jarvis-judice-ninke", serpentine: false },
    { kind: "error-diffusion", kernel: "jarvis-judice-ninke", serpentine: true },
  ];

  it.each(STORED.map((setting): [string, ScreeningSetting] => [JSON.stringify(setting), setting]))("%s", (_label, setting) => {
    const stored: unknown = JSON.parse(JSON.stringify(setting));
    expect(parseScreeningSetting(stored)).toStrictEqual(setting);
    expect(JSON.stringify(parseScreeningSetting(stored))).toBe(JSON.stringify(setting));
    expect(normalizeJobScreening({ ...BASE_JOB, screening: stored })).toStrictEqual({ ...BASE_JOB, screening: setting });
  });
});

describe("job read path for screening (spec 039b)", () => {
  it("adds no key when screening is absent", () => {
    const read = normalizeJobScreening(BASE_JOB);
    expect(read).not.toHaveProperty("screening");
    expect(read).toEqual(BASE_JOB);
    expect(readJobScreening(undefined)).toBeUndefined();
  });

  it.each([
    ["the string 'yes'", "yes"],
    ["null", null],
    ["an unknown kind", { kind: "x" }],
    ["a bayer size of 3", { kind: "bayer", size: 3 }],
    ["a blue-noise size of 300", { kind: "blue-noise", size: 300, seed: 1 }],
    ["an unknown field", { kind: "bayer", size: 4, extra: 1 }],
  ])("drops %s and keeps the job readable", (_label, screening) => {
    const read = normalizeJobScreening({ ...BASE_JOB, screening });
    expect(read).not.toHaveProperty("screening");
    expect(read).toEqual(BASE_JOB);
    expect(readJobScreening(screening)).toBeUndefined();
  });

  it("keeps a valid setting", () => {
    expect(normalizeJobScreening({ ...BASE_JOB, screening: { ...BLUE } })).toEqual({ ...BASE_JOB, screening: BLUE });
    expect(readJobScreening({ kind: "bayer", size: 8 })).toEqual({ kind: "bayer", size: 8 });
  });

  it("does not mutate the stored record", () => {
    const stored = { ...BASE_JOB, screening: "yes" };
    normalizeJobScreening(stored);
    expect(stored.screening).toBe("yes");
  });

  it("leaves whiteInk untouched", () => {
    const job: Job = { ...BASE_JOB, whiteInk: { mode: "flood" }, screening: BLUE };
    expect(normalizeJobScreening(job)).toEqual(job);
  });

  it("survives a JSON round trip on a Job", () => {
    const job: Job = { ...BASE_JOB, screening: BLUE };
    const restored: unknown = JSON.parse(JSON.stringify(job));
    expect(restored).toEqual(job);
  });
});
