import type { Job, JobEdit, JobTicket } from "@bax-print/core";
import type { CutContourSelection } from "@bax-print/cut-export";
import type { Contour } from "@bax-print/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { planCutJob, type CutPlanDeps } from "../src/cut-service.js";

const TICKET: JobTicket = { intent: { quantity: 1 }, process: {} };
const EXTRACTED: Contour = {
  id: "c1",
  tool: "thru",
  source: { kind: "spot", name: "Cut" },
  closed: true,
  points: [
    [0, 0],
    [10, 0],
    [10, 10],
  ],
  bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  areaSigned: 50,
};

function jobWith(edits?: JobEdit[]): Pick<Job, "id" | "ticket"> {
  return { id: "job-1", ticket: edits ? { ...TICKET, edits } : TICKET };
}

function depsWith(extract: (selection: CutContourSelection) => Contour[]): CutPlanDeps {
  return {
    pageBoxes: { mediaBox: { x0: 0, y0: 0, x1: 200, y1: 100 } },
    frame: { widthPt: 200, heightPt: 100 },
    toolMap: { thru: { toolId: "t1" } },
    cut: { spotNames: ["CutContour"], layerNames: ["Cut"] },
    extract,
  };
}

describe("planCutJob", () => {
  it("extracts with the configured selection when the job has no edits", async () => {
    const extract = vi.fn(() => [EXTRACTED]);

    const result = await planCutJob(jobWith(), depsWith(extract));

    expect(extract).toHaveBeenCalledWith({ spotNames: ["CutContour"], layerNames: ["Cut"] });
    expect(result).toEqual({
      kind: "job",
      job: { jobId: "job-1", contours: [EXTRACTED], toolMap: { thru: { toolId: "t1" } }, frame: { widthPt: 200, heightPt: 100 }, options: {} },
      warnings: [],
    });
  });

  it("extracts exactly the spot names of a cutContour edit", async () => {
    const extract = vi.fn(() => [EXTRACTED]);

    const result = await planCutJob(jobWith([{ id: "e1", kind: "cutContour", source: { kind: "spot", names: ["Kiss"] } }]), depsWith(extract));

    expect(extract).toHaveBeenCalledWith({ spotNames: ["Kiss"], layerNames: [] });
    expect(result.kind).toBe("job");
  });

  it("cuts the page trim box without extracting for a trimBox source", async () => {
    const extract = vi.fn(() => [EXTRACTED]);

    const result = await planCutJob(jobWith([{ id: "e1", kind: "cutContour", source: { kind: "trimBox", offsetMm: 0 } }]), depsWith(extract));

    expect(extract).not.toHaveBeenCalled();
    if (result.kind !== "job") throw new Error("expected a cut job");
    expect(result.job.contours).toHaveLength(1);
    const bbox = result.job.contours[0]?.bbox;
    expect(bbox?.minX).toBeCloseTo(0);
    expect(bbox?.minY).toBeCloseTo(0);
    expect(bbox?.maxX).toBeCloseTo(200);
    expect(bbox?.maxY).toBeCloseTo(100);
  });

  it("returns none without extracting when the edits say the job is not cut", async () => {
    const extract = vi.fn(() => [EXTRACTED]);

    const result = await planCutJob(jobWith([{ id: "e1", kind: "cutContour", source: { kind: "none" } }]), depsWith(extract));

    expect(result).toEqual({ kind: "none" });
    expect(extract).not.toHaveBeenCalled();
  });
});
