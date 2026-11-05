import { describe, expect, it } from "vitest";
import { CutterDriverError, type CutterProfile } from "@bax-print/plugin-sdk";
import { mmToPt, panelBoundariesMm, panelLimitMm, ptToMm, segmentCutJob } from "../src/index.js";
import { jobOf, marksMm, rectMm } from "./helpers.js";

const ROLL: CutterProfile = {
  class: "roll",
  workArea: { widthMm: 1000 },
  roll: { supportsPanelAdvance: false, loadOrigin: "bottom-left", maxPanelLengthMm: 1500 },
  tools: [{ id: "knife", kind: "drag-knife", params: {} }],
  registration: { methods: ["none", "edge-mark-rows"] },
  delivery: ["file"],
  formats: ["hpgl"],
};

/** Mark rows every 500 mm down both long edges of a 1000 x 5000 mm roll job. */
function edgeRows(): [number, number][] {
  const centers: [number, number][] = [];
  for (let y = 0; y <= 5000; y += 500) centers.push([10, y], [990, y]);
  return centers;
}

/** 25 squares of 100 mm, one every 200 mm along the feed; two of them cross a 1500 mm boundary. */
function fiveMetreJob() {
  const contours = Array.from({ length: 25 }, (_, i) => rectMm(`c${i}`, "kiss", 100, 50 + i * 200, 200, 150 + i * 200));
  return jobOf({
    contours,
    toolMap: { kiss: { toolId: "knife" } },
    widthMm: 1000,
    heightMm: 5000,
    marks: marksMm(edgeRows(), 5, { method: "edge-mark-rows", shape: "square" }),
  });
}

describe("segmentCutJob", () => {
  it("splits a 5 m roll job into 4 panels of at most 1500 mm", () => {
    const { job, panelJobs, warnings } = segmentCutJob(fiveMetreJob(), ROLL);
    const panels = job.segmentation?.panels ?? [];
    expect(panels).toHaveLength(4);
    expect(panelJobs).toHaveLength(4);
    expect(panels.map((p) => [p.y0Mm, p.y1Mm].map((v) => Math.round(v * 1e6) / 1e6))).toEqual([
      [0, 1500],
      [1500, 3000],
      [3000, 4500],
      [4500, 5000],
    ]);
    for (const p of panels) expect(p.y1Mm - p.y0Mm).toBeLessThanOrEqual(1500 + 1e-6);
    // c7 (1450..1550) and c22 (4450..4550) cross a boundary and go whole to the panel holding their bbox max.
    expect(warnings.filter((w) => w.includes("crosses a panel boundary"))).toHaveLength(2);
    expect(panelJobs[1]?.contours.map((c) => c.id)).toContain("c7");
    expect(panelJobs[3]?.contours.map((c) => c.id)).toContain("c22");
  });

  it("puts every contour in exactly one panel", () => {
    const input = fiveMetreJob();
    const { panelJobs } = segmentCutJob(input, ROLL);
    const ids = panelJobs.flatMap((p) => p.contours.map((c) => c.id));
    expect([...ids].sort()).toEqual(input.contours.map((c) => c.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every panel its own registration marks", () => {
    const { job, panelJobs } = segmentCutJob(fiveMetreJob(), ROLL);
    const panels = job.segmentation?.panels ?? [];
    panels.forEach((panel, i) => {
      const marks = panelJobs[i]?.marks;
      expect(marks, `panel ${i + 1}`).toBeDefined();
      expect(marks?.marks.length).toBeGreaterThanOrEqual(3);
      expect(panel.marks).toEqual(marks?.marks.map((m) => m.id));
      expect(marks?.marks.some((m) => m.id === marks.originMarkId)).toBe(true);
      for (const m of marks?.marks ?? []) {
        const y = ptToMm(m.yPt);
        expect(y).toBeGreaterThanOrEqual(panel.y0Mm - 0.01);
        expect(y).toBeLessThanOrEqual(panel.y1Mm + 0.01);
      }
    });
    // Each panel job keeps the parent id as a prefix and carries no segmentation itself.
    expect(panelJobs.map((p) => p.jobId)).toEqual(["job-0001-p1", "job-0001-p2", "job-0001-p3", "job-0001-p4"]);
    expect(panelJobs.every((p) => p.segmentation === undefined)).toBe(true);
  });

  it("splits crossing contours into open pieces with allowSplit", () => {
    const job = jobOf({ contours: [rectMm("x", "kiss", 0, 1400, 100, 1600)], widthMm: 500, heightMm: 3000 });
    const { panelJobs, warnings } = segmentCutJob(job, ROLL, { allowSplit: true });
    const pieces = panelJobs.flatMap((p, panel) => p.contours.map((c) => ({ panel, c })));
    expect(pieces.map(({ panel, c }) => [panel, c.id, c.closed])).toEqual([
      [0, "x.1", false],
      [1, "x.2", false],
    ]);
    for (const { panel, c } of pieces) {
      const [y0, y1] = panel === 0 ? [0, 1500] : [1500, 3000];
      for (const [, y] of c.points) {
        expect(ptToMm(y)).toBeGreaterThanOrEqual(y0 - 1e-6);
        expect(ptToMm(y)).toBeLessThanOrEqual(y1 + 1e-6);
      }
    }
    expect(warnings).toEqual(["contour x: split into 2 open pieces at panel boundaries"]);
  });

  it("snaps panel boundaries to mark rows", () => {
    expect(panelBoundariesMm(4000, 1500, [0, 1200, 2400, 3600, 4000])).toEqual([0, 1200, 2400, 3600, 4000]);
    expect(panelBoundariesMm(1000, 1500)).toEqual([0, 1000]);
  });

  it("returns the job unchanged when it fits or no limit applies", () => {
    const short = jobOf({ contours: [rectMm("a", "kiss", 0, 0, 100, 100)], heightMm: 1000 });
    expect(segmentCutJob(short, ROLL).panelJobs).toEqual([short]);
    const open: CutterProfile = { ...ROLL, roll: { supportsPanelAdvance: false, loadOrigin: "bottom-left" } };
    expect(segmentCutJob(fiveMetreJob(), open).panelJobs).toHaveLength(1);
  });

  it("uses the bed length as step size for flatbeds with a conveyor only", () => {
    const flatbed: CutterProfile = {
      ...ROLL,
      class: "flatbed",
      workArea: { widthMm: 1000, lengthMm: 2000 },
      roll: undefined,
      flatbed: { bedOrigin: "bottom-left", conveyor: true },
    };
    expect(panelLimitMm(flatbed)).toBe(2000);
    expect(segmentCutJob(fiveMetreJob(), flatbed).panelJobs).toHaveLength(3);
    expect(panelLimitMm({ ...flatbed, flatbed: { bedOrigin: "bottom-left", conveyor: false } })).toBeUndefined();
  });

  it("rejects a non-positive panel length", () => {
    expect(() => segmentCutJob(fiveMetreJob(), ROLL, { maxPanelLengthMm: 0 })).toThrowError(CutterDriverError);
    expect(mmToPt(25.4)).toBeCloseTo(72, 9);
  });
});
