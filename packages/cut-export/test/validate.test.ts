import { describe, expect, it } from "vitest";
import { CutterDriverError, type CutJob, type CutterProfile } from "@bax-print/plugin-sdk";
import { assertValidCutJob, jobExtentMm, requestedRegistrationMethod, validateCutJob } from "../src/index.js";
import { jobOf, marksMm, rectMm } from "./helpers.js";

const ROLL: CutterProfile = {
  class: "roll",
  workArea: { widthMm: 1000 },
  roll: { supportsPanelAdvance: false, loadOrigin: "bottom-left", maxPanelLengthMm: 1500 },
  tools: [{ id: "knife", kind: "drag-knife", params: { force: { min: 10, max: 400, unit: "g" }, speed: { min: 1, max: 80, unit: "cm/s" } } }],
  registration: { methods: ["none", "edge-mark-rows"], markShapes: ["square"] },
  delivery: ["file"],
  formats: ["hpgl"],
};

const FLATBED: CutterProfile = {
  class: "flatbed",
  workArea: { widthMm: 1000, lengthMm: 500 },
  flatbed: { bedOrigin: "bottom-left", conveyor: false },
  tools: [{ id: "kiss-1", kind: "kiss", params: { depth: { min: 0, max: 2, unit: "mm" } } }],
  registration: { methods: ["camera-marks", "none"], markShapes: ["circle"], markSizeMm: { min: 5, max: 5, unit: "mm" } },
  delivery: ["folder-import"],
  formats: ["dxf"],
};

const rollJob = (patch: Partial<CutJob> = {}): CutJob => ({
  ...jobOf({ contours: [rectMm("c1", "kiss", 10, 10, 110, 60)], toolMap: { kiss: { toolId: "knife", force: 100 } }, widthMm: 900, heightMm: 3000 }),
  ...patch,
});

const flatJob = (patch: Partial<CutJob> = {}): CutJob => ({
  ...jobOf({
    contours: [rectMm("c1", "kiss", 20, 20, 120, 70)],
    toolMap: { kiss: { toolId: "kiss-1", depth: 0.5 } },
    marks: marksMm([[10, 10], [130, 10], [10, 80]], 5, { method: "camera-marks", shape: "circle" }),
    widthMm: 140,
    heightMm: 90,
  }),
  ...patch,
});

const wide = [rectMm("wide", "kiss", 0, 0, 1200, 50)];

const CASES: { name: string; profile: CutterProfile; job: CutJob; codes: string[] }[] = [
  { name: "roll: valid job", profile: ROLL, job: rollJob(), codes: [] },
  { name: "roll: wider than the work area", profile: ROLL, job: rollJob({ contours: wide }), codes: ["extent-width"] },
  { name: "roll: unknown tool", profile: ROLL, job: rollJob({ toolMap: { kiss: { toolId: "laser" } } }), codes: ["unknown-tool"] },
  { name: "roll: force out of range", profile: ROLL, job: rollJob({ toolMap: { kiss: { toolId: "knife", force: 900 } } }), codes: ["param-out-of-range"] },
  {
    name: "roll: unsupported registration method",
    profile: ROLL,
    job: rollJob({ marks: marksMm([[5, 5], [95, 5], [5, 95]], 5, { method: "camera-marks", shape: "square" }) }),
    codes: ["registration-unsupported"],
  },
  { name: "roll: long job is fine (open length)", profile: ROLL, job: rollJob({ contours: [rectMm("long", "kiss", 0, 0, 100, 5000)] }), codes: [] },
  { name: "flatbed: valid job", profile: FLATBED, job: flatJob(), codes: [] },
  { name: "flatbed: wider than the bed", profile: FLATBED, job: flatJob({ contours: wide }), codes: ["extent-width"] },
  { name: "flatbed: unknown tool", profile: FLATBED, job: flatJob({ toolMap: { kiss: { toolId: "router-9" } } }), codes: ["unknown-tool"] },
  { name: "flatbed: depth out of range", profile: FLATBED, job: flatJob({ toolMap: { kiss: { toolId: "kiss-1", depth: 3 } } }), codes: ["param-out-of-range"] },
  {
    name: "flatbed: unsupported registration method",
    profile: FLATBED,
    job: flatJob({ marks: marksMm([[10, 10], [130, 10], [10, 80]], 5, { method: "edge-mark-rows", shape: "circle" }) }),
    codes: ["registration-unsupported"],
  },
  {
    name: "flatbed: longer than the bed without conveyor",
    profile: FLATBED,
    job: flatJob({ contours: [rectMm("long", "kiss", 20, 20, 120, 900)] }),
    codes: ["extent-length"],
  },
  {
    name: "flatbed: longer than the bed with conveyor",
    profile: { ...FLATBED, flatbed: { bedOrigin: "bottom-left", conveyor: true } },
    job: flatJob({ contours: [rectMm("long", "kiss", 20, 20, 120, 900)] }),
    codes: [],
  },
  {
    name: "flatbed: wrong mark shape and size",
    profile: FLATBED,
    job: flatJob({ marks: marksMm([[10, 10], [130, 10], [10, 80]], 6, { method: "camera-marks", shape: "square" }) }),
    codes: ["mark-shape-unsupported", "mark-size-out-of-range", "mark-size-out-of-range", "mark-size-out-of-range"],
  },
  { name: "unmapped semantic tool", profile: FLATBED, job: flatJob({ toolMap: {} }), codes: ["unmapped-tool"] },
];

describe("validateCutJob", () => {
  it.each(CASES)("$name", ({ profile, job, codes }) => {
    const report = validateCutJob(job, profile);
    expect(report.errors.map((e) => e.code)).toEqual(codes);
    expect(report.ok).toBe(codes.length === 0);
  });

  it("reports every error before export, not just the first", () => {
    const job = rollJob({
      contours: wide,
      toolMap: { kiss: { toolId: "knife", force: 5 }, thru: { toolId: "missing" } },
      marks: marksMm([[5, 5]], 5, { method: "camera-contour", shape: "square" }),
    });
    const codes = validateCutJob(job, ROLL).errors.map((e) => e.code).sort();
    expect(codes).toEqual(["extent-width", "param-out-of-range", "registration-unsupported", "unknown-tool"]);
    try {
      assertValidCutJob(job, ROLL);
      expect.unreachable("assertValidCutJob should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CutterDriverError);
      expect((error as CutterDriverError).code).toBe("invalid-job");
      for (const code of codes) expect((error as Error).message).toContain(code);
    }
  });

  it("warns about parameters the tool declares no range for", () => {
    const report = validateCutJob(rollJob({ toolMap: { kiss: { toolId: "knife", depth: 1 } } }), ROLL);
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w) => [w.code, w.path])).toEqual([["param-unsupported", "toolMap.kiss.depth"]]);
  });

  it("flags non-finite geometry instead of throwing", () => {
    const job = rollJob();
    const [first] = job.contours;
    if (!first) throw new Error("rollJob has no contour");
    job.contours[0] = { ...first, points: [[0, 0], [Number.NaN, 1]] };
    expect(validateCutJob(job, ROLL).errors.map((e) => e.code)).toEqual(["invalid-geometry"]);
  });

  it("includes registration marks in the job extent", () => {
    const extent = jobExtentMm(flatJob());
    expect(extent?.minX).toBeCloseTo(7.5, 9);
    expect(extent?.maxX).toBeCloseTo(132.5, 9);
    expect(requestedRegistrationMethod(rollJob())).toBe("none");
    expect(requestedRegistrationMethod(rollJob({ marks: marksMm([[1, 1]], 5) }))).toBe("corner-marks");
  });
});
