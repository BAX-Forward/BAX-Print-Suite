import { describe, expect, it } from "vitest";
import { makeExportResult, type CutJob, type CutterDriver, type CutterProfile, CutterDriverError } from "../src/index.js";
import { checkCutterProfile, runCutterDriverConformance, sampleCutJob } from "../src/conformance/index.js";

const PROFILE: CutterProfile = {
  class: "roll",
  workArea: { widthMm: 600 },
  roll: { supportsPanelAdvance: false, loadOrigin: "bottom-left" },
  tools: [
    { id: "pen-1", kind: "pen", params: {} },
    { id: "knife-1", kind: "drag-knife", params: { force: { min: 0, max: 300, unit: "g" } } },
  ],
  registration: { methods: ["none"] },
  delivery: ["file"],
  formats: ["txt"],
};

/** A minimal, correct in-process driver writing one line per contour. */
function fakeDriver(overrides: Partial<CutterDriver> = {}): CutterDriver {
  return {
    describe: () => structuredClone(PROFILE),
    formats: () => [{ id: "txt", mime: "text/plain", ext: "txt", optionsSchema: { type: "object" } }],
    export: (job: CutJob, format: string) => {
      if (format !== "txt") throw new CutterDriverError("unsupported", format);
      const text = job.contours.map((c) => `${c.id} ${c.points.length}`).join("\n");
      return makeExportResult({ bytes: new TextEncoder().encode(text), fileName: `${job.jobId}.txt`, mime: "text/plain" });
    },
    getStatus: () => ({ state: "unknown" }),
    ...overrides,
  };
}

const failedChecks = (report: { checks: { name: string; ok: boolean }[] }): string[] => report.checks.filter((c) => !c.ok).map((c) => c.name);

describe("CutterDriver/2 conformance kit", () => {
  it("passes a correct driver", async () => {
    const report = await runCutterDriverConformance(fakeDriver());
    expect(failedChecks(report)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(6);
  });

  it("fails a driver whose sha256 does not match its bytes", async () => {
    const good = fakeDriver();
    const report = await runCutterDriverConformance(
      fakeDriver({
        export: async (job, format) => ({ ...(await good.export(job, format)), sha256: "0".repeat(64) }),
      }),
    );
    expect(report.passed).toBe(false);
    expect(failedChecks(report)).toContain('export "txt" returns a hashed artifact');
  });

  it("fails a driver that accepts unknown formats or lists formats it doesn't declare", async () => {
    const good = fakeDriver();
    const lenient = await runCutterDriverConformance(fakeDriver({ export: (job) => good.export(job, "txt") }));
    expect(failedChecks(lenient)).toEqual(['unknown format is rejected with code "unsupported"']);
    const mismatched = await runCutterDriverConformance(fakeDriver({ describe: () => ({ ...PROFILE, formats: ["txt", "dxf"] }) }));
    expect(failedChecks(mismatched)).toEqual(["formats() matches profile.formats"]);
  });

  it("fails non-deterministic exports", async () => {
    let n = 0;
    const report = await runCutterDriverConformance(
      fakeDriver({
        export: (job, format) => {
          if (format !== "txt") throw new CutterDriverError("unsupported", format);
          return makeExportResult({ bytes: new Uint8Array([n++]), fileName: `${job.jobId}.txt`, mime: "text/plain" });
        },
      }),
    );
    expect(failedChecks(report)).toEqual(['export "txt" is deterministic']);
  });

  it("reports profile problems from describe", async () => {
    const report = await runCutterDriverConformance(fakeDriver({ describe: () => ({ ...PROFILE, roll: undefined, tools: [] }) }));
    expect(report.passed).toBe(false);
    expect(report.checks[0]?.detail).toContain("roll machines must declare `roll`");
    expect(report.checks[0]?.detail).toContain("tools must be a non-empty array");
  });

  it("checks profiles structurally", () => {
    expect(checkCutterProfile(PROFILE)).toEqual([]);
    const flatbed: CutterProfile = { ...PROFILE, class: "flatbed", roll: undefined, flatbed: { bedOrigin: "top-left" } };
    expect(checkCutterProfile(flatbed)).toEqual(["flatbed machines must declare workArea.lengthMm"]);
    const badRange: CutterProfile = { ...PROFILE, tools: [{ id: "k", kind: "kiss", params: { depth: { min: 2, max: 1, unit: "mm" } } }] };
    expect(checkCutterProfile(badRange)).toEqual(["tool k.params.depth: min > max"]);
    expect(checkCutterProfile({ ...PROFILE, delivery: [], formats: [] })).toEqual([
      "delivery must be a non-empty string array",
      "formats must be a non-empty string array",
    ]);
  });

  it("builds a sample job on the first cutting tool, with marks only when registration is required", () => {
    const plain = sampleCutJob(PROFILE);
    expect(plain.toolMap).toEqual({ kiss: { toolId: "knife-1" } });
    expect(plain.marks).toBeUndefined();
    const marked = sampleCutJob({ ...PROFILE, registration: { methods: ["camera-marks"], markShapes: ["circle"], markSizeMm: { min: 5, max: 5, unit: "mm" } } });
    expect(marked.marks?.method).toBe("camera-marks");
    expect(marked.marks?.marks).toHaveLength(4);
    expect(marked.marks?.marks[0]?.dPt).toBeCloseTo((5 * 72) / 25.4, 9);
  });
});
