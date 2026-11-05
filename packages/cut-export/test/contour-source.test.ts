import { describe, expect, expectTypeOf, it } from "vitest";
import { CutterDriverError, type Contour } from "@bax-print/plugin-sdk";
// Type-only: erased at runtime, so cut-export takes no dependency on the edits package.
import type { ResolvedCutContour as EditsResolvedCutContour } from "../../edits/src/cut-contour.js";
import {
  RECT_CONTOUR_ID,
  buildCutJob,
  contoursForResolvedCut,
  createFrameTransform,
  mmToPt,
  type CutContourSelection,
  type CutJobInput,
  type ResolvedCutContour,
} from "../src/index.js";
import { rectMm } from "./helpers.js";

const CONFIGURED: CutContourSelection = { spotNames: ["CutContour"], layerNames: ["Cut"] };

/** A page 100 × 50 mm; `extract` records every selection it is asked for. */
function inputOf(cutContour?: ResolvedCutContour): { input: CutJobInput; selections: CutContourSelection[] } {
  const selections: CutContourSelection[] = [];
  const extracted: Contour[] = [rectMm("c1", "kiss", 10, 10, 90, 40)];
  const input: CutJobInput = {
    jobId: "job-0001",
    frame: { widthPt: mmToPt(100), heightPt: mmToPt(50) },
    toolMap: { kiss: { toolId: "knife" } },
    cut: CONFIGURED,
    extract: (selection) => {
      selections.push(selection);
      return extracted;
    },
    ...(cutContour ? { cutContour } : {}),
  };
  return { input, selections };
}

/** The rectangle `resolveCutContour` returns for a trim box of `widthMm` × `heightMm` at `offsetMm`. */
function rectOf(widthMm: number, heightMm: number, offsetMm: number): Extract<ResolvedCutContour, { kind: "rect" }> {
  return {
    kind: "rect",
    x: mmToPt(-offsetMm),
    y: mmToPt(-offsetMm),
    width: mmToPt(widthMm + 2 * offsetMm),
    height: mmToPt(heightMm + 2 * offsetMm),
  };
}

function expectPoints(actual: readonly [number, number][], expected: readonly [number, number][]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach(([x, y], i) => {
    const point = actual[i];
    expect(point?.[0]).toBeCloseTo(x, 9);
    expect(point?.[1]).toBeCloseTo(y, 9);
  });
}

describe("ResolvedCutContour", () => {
  it("is the same type as the one resolveCutContour in the edits package returns", () => {
    expectTypeOf<ResolvedCutContour>().toEqualTypeOf<EditsResolvedCutContour>();
  });
});

describe("contoursForResolvedCut", () => {
  it("keeps the configured selection without a cutContour edit", () => {
    expect(contoursForResolvedCut(undefined, CONFIGURED)).toEqual({ kind: "extract", selection: CONFIGURED, warnings: [] });
  });

  it("replaces the configured spot and layer names with exactly the edit's spot names", () => {
    const plan = contoursForResolvedCut({ kind: "spot", names: ["Die", "Crease"] }, CONFIGURED);
    expect(plan).toEqual({ kind: "extract", selection: { spotNames: ["Die", "Crease"], layerNames: [] }, warnings: [] });
  });

  it("does not share the names array with the resolved contour", () => {
    const names = ["Die"];
    const plan = contoursForResolvedCut({ kind: "spot", names }, CONFIGURED);
    names.push("Other");
    expect(plan.kind === "extract" ? plan.selection.spotNames : undefined).toEqual(["Die"]);
  });

  it("returns no contours and a no-cut-contours warning for an empty spot list", () => {
    const plan = contoursForResolvedCut({ kind: "spot", names: [] }, CONFIGURED);
    expect(plan).toEqual({
      kind: "contours",
      contours: [],
      warnings: [expect.objectContaining({ severity: "warning", code: "no-cut-contours", path: "edits.cutContour.source.names" })],
    });
  });

  it("returns the explicit none plan for a none source", () => {
    expect(contoursForResolvedCut({ kind: "none" }, CONFIGURED)).toEqual({ kind: "none" });
  });

  it("builds one closed counter-clockwise rectangle in pt in the trim frame", () => {
    const plan = contoursForResolvedCut(rectOf(100, 50, 0), CONFIGURED);
    if (plan.kind !== "contours") throw new Error(`expected contours, got ${plan.kind}`);
    expect(plan.warnings).toEqual([]);
    expect(plan.contours).toHaveLength(1);
    const [contour] = plan.contours;
    expect(contour).toMatchObject({ id: RECT_CONTOUR_ID, tool: "kiss", closed: true });
    expectPoints(contour?.points ?? [], [
      [0, 0],
      [mmToPt(100), 0],
      [mmToPt(100), mmToPt(50)],
      [0, mmToPt(50)],
    ]);
    expect(contour?.areaSigned).toBeCloseTo(mmToPt(100) * mmToPt(50), 6);
    expect(contour?.bbox.maxX).toBeCloseTo(mmToPt(100), 9);
  });

  it("uses the configured rect tool", () => {
    const plan = contoursForResolvedCut(rectOf(100, 50, 0), CONFIGURED, { rectTool: "thru" });
    expect(plan.kind === "contours" ? plan.contours[0]?.tool : undefined).toBe("thru");
  });

  it.each([
    ["zero width", { kind: "rect", x: 0, y: 0, width: 0, height: 10 }],
    ["negative height", { kind: "rect", x: 0, y: 0, width: 10, height: -1 }],
    ["non-finite x", { kind: "rect", x: Number.NaN, y: 0, width: 10, height: 10 }],
  ] satisfies [string, ResolvedCutContour][])("rejects a rectangle with %s", (_label, rect) => {
    expect(() => contoursForResolvedCut(rect, CONFIGURED)).toThrow(CutterDriverError);
  });
});

describe("buildCutJob", () => {
  it("extracts with the configured selection when the job has no cutContour edit", async () => {
    const { input, selections } = inputOf();
    const result = await buildCutJob(input);
    expect(selections).toEqual([CONFIGURED]);
    if (result.kind !== "job") throw new Error("expected a job");
    expect(result.warnings).toEqual([]);
    expect(result.job).toEqual({
      jobId: "job-0001",
      contours: [rectMm("c1", "kiss", 10, 10, 90, 40)],
      toolMap: { kiss: { toolId: "knife" } },
      frame: { widthPt: mmToPt(100), heightPt: mmToPt(50) },
      options: {},
    });
  });

  it("extracts the spot names after an upstream spotMap rename, not the configured or original names", async () => {
    // A cutContour edit naming "CutContour", followed by a spotMap edit CutContour -> Thru-cut,
    // resolves (in the edits package) to the renamed name only.
    const { input, selections } = inputOf({ kind: "spot", names: ["Thru-cut"] });
    const result = await buildCutJob(input);
    expect(selections).toEqual([{ spotNames: ["Thru-cut"], layerNames: [] }]);
    expect(result.kind === "job" ? result.job.contours.map((c) => c.id) : []).toEqual(["c1"]);
  });

  it("builds a job without contours and a warning when every spot name was mapped to process", async () => {
    const { input, selections } = inputOf({ kind: "spot", names: [] });
    const result = await buildCutJob(input);
    expect(selections).toEqual([]);
    if (result.kind !== "job") throw new Error("expected a job");
    expect(result.job.contours).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(["no-cut-contours"]);
  });

  it("returns none without extracting for a none source", async () => {
    const { input, selections } = inputOf({ kind: "none" });
    expect(await buildCutJob(input)).toEqual({ kind: "none" });
    expect(selections).toEqual([]);
  });

  it("passes marks and options through", async () => {
    const { input } = inputOf({ kind: "rect", x: 0, y: 0, width: 10, height: 10 });
    const marks = { marks: [{ id: "m0", xPt: 5, yPt: 5, dPt: 10 }], originMarkId: "m0" };
    const result = await buildCutJob({ ...input, marks, options: { origin: "top-left" } });
    expect(result.kind === "job" ? [result.job.marks, result.job.options] : []).toEqual([marks, { origin: "top-left" }]);
  });

  it("places an outward-offset rect through the frame transform (top-left origin)", async () => {
    const { input, selections } = inputOf(rectOf(100, 50, 3));
    const result = await buildCutJob(input);
    expect(selections).toEqual([]);
    if (result.kind !== "job") throw new Error("expected a job");
    const toCutter = createFrameTransform(result.job, { origin: "top-left" });
    expectPoints(result.job.contours[0]?.points.map(toCutter) ?? [], [
      [-3, 53],
      [103, 53],
      [103, -3],
      [-3, -3],
    ]);
  });

  it("places an inward (negative) offset rect through the frame transform (swap, scale, offset)", async () => {
    const { input } = inputOf(rectOf(100, 50, -2));
    const result = await buildCutJob(input);
    if (result.kind !== "job") throw new Error("expected a job");
    const [contour] = result.job.contours;
    expect(contour?.bbox.minX).toBeCloseTo(mmToPt(2), 9);
    expect(contour?.bbox.maxY).toBeCloseTo(mmToPt(48), 9);
    const toCutter = createFrameTransform(result.job, { swapXY: true, scale: [2, 1], offsetMm: [10, 5] });
    // Frame (x, y) mm -> swapped (y, x), then x * 2 + 10, y + 5.
    expectPoints(contour?.points.map(toCutter) ?? [], [
      [14, 7],
      [14, 103],
      [106, 103],
      [106, 7],
    ]);
  });
});
