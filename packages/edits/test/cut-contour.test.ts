import { describe, expect, it } from "vitest";
import type { JobEdit } from "@bax-print/core";
import { EditError, mmToPt, ptToMm, resolveCutContour, resolveCutSource, type PageBoxes, type ResolvedCutContour } from "../src/index.js";

const DIGITS = 9;

/** A 200 × 100 pt TrimBox inside a 300 × 200 pt MediaBox. */
const trimmed: PageBoxes = { mediaBox: { x0: 0, y0: 0, x1: 300, y1: 200 }, trimBox: { x0: 10, y0: 10, x1: 210, y1: 110 } };
/** No TrimBox: the edits fold over the 300 × 200 pt MediaBox, the cut takes the left-hand 100 × 200 pt CropBox. */
const cropped: PageBoxes = { mediaBox: { x0: 0, y0: 0, x1: 300, y1: 200 }, cropBox: { x0: 0, y0: 0, x1: 100, y1: 200 } };

const trimCut = (offsetMm = 0): JobEdit => ({ kind: "cutContour", source: { kind: "trimBox", offsetMm } });
const spotCut = (...names: string[]): JobEdit => ({ kind: "cutContour", source: { kind: "spot", names } });
const cropPt = (x: number, y: number, width: number, height: number): JobEdit => ({
  kind: "crop",
  box: { xMm: ptToMm(x), yMm: ptToMm(y), widthMm: ptToMm(width), heightMm: ptToMm(height) },
});

function expectRect(actual: ResolvedCutContour | undefined, expected: { x: number; y: number; width: number; height: number }): void {
  if (actual?.kind !== "rect") throw new Error(`expected a rect cut contour, got ${JSON.stringify(actual)}`);
  expect(actual.x).toBeCloseTo(expected.x, DIGITS);
  expect(actual.y).toBeCloseTo(expected.y, DIGITS);
  expect(actual.width).toBeCloseTo(expected.width, DIGITS);
  expect(actual.height).toBeCloseTo(expected.height, DIGITS);
}

function editErrorOf(run: () => unknown): EditError {
  try {
    run();
  } catch (error) {
    if (error instanceof EditError) return error;
    throw error;
  }
  throw new Error("expected an EditError");
}

describe("resolveCutContour", () => {
  it("is undefined without a cutContour edit, so the configured cut settings apply", () => {
    expect(resolveCutContour([], trimmed)).toBeUndefined();
    expect(resolveCutContour([{ kind: "rotate", degrees: 90 }, { kind: "copies", count: 2 }], trimmed)).toBeUndefined();
    expect(resolveCutSource([{ kind: "spotMap", from: "A", to: { kind: "process" } }])).toBeUndefined();
  });

  it("resolves none", () => {
    expect(resolveCutContour([{ kind: "cutContour", source: { kind: "none" } }], trimmed)).toEqual({ kind: "none" });
  });

  it("lets the last cutContour edit win", () => {
    const none: JobEdit = { kind: "cutContour", source: { kind: "none" } };
    expect(resolveCutContour([spotCut("CutContour"), none], trimmed)).toEqual({ kind: "none" });
    expect(resolveCutContour([none, trimCut(), spotCut("CutContour")], trimmed)).toEqual({ kind: "spot", names: ["CutContour"] });
    expectRect(resolveCutContour([spotCut("CutContour"), none, trimCut()], trimmed), { x: 0, y: 0, width: 200, height: 100 });
  });

  it("takes the TrimBox in the trim frame", () => {
    expectRect(resolveCutContour([trimCut()], trimmed), { x: 0, y: 0, width: 200, height: 100 });
  });

  it("follows scale and rotate edits", () => {
    expectRect(resolveCutContour([{ kind: "scale", percent: 50 }, trimCut()], trimmed), { x: 0, y: 0, width: 100, height: 50 });
    expectRect(resolveCutContour([{ kind: "rotate", degrees: 90 }, trimCut()], trimmed), { x: 0, y: 0, width: 100, height: 200 });
    expectRect(resolveCutContour([trimCut()], { ...trimmed, rotate: 270 }), { x: 0, y: 0, width: 100, height: 200 });
  });

  it("is page-independent of where the edit sits in the stack", () => {
    const edits: JobEdit[] = [trimCut(), { kind: "scale", percent: 50 }, { kind: "rotate", degrees: 90 }];
    expectRect(resolveCutContour(edits, trimmed), { x: 0, y: 0, width: 50, height: 100 });
  });

  it("falls back to the CropBox and carries it through a mirror", () => {
    expectRect(resolveCutContour([trimCut()], cropped), { x: 0, y: 0, width: 100, height: 200 });
    expectRect(resolveCutContour([{ kind: "mirror" }, trimCut()], cropped), { x: 200, y: 0, width: 100, height: 200 });
    expectRect(resolveCutContour([{ kind: "mirror", axis: "vertical" }, trimCut()], cropped), { x: 0, y: 0, width: 100, height: 200 });
  });

  it("falls back to the MediaBox without TrimBox or CropBox", () => {
    expectRect(resolveCutContour([trimCut()], { mediaBox: { x0: 5, y0: 5, x1: 105, y1: 55 } }), { x: 0, y: 0, width: 100, height: 50 });
  });

  it("combines scale, rotate and mirror", () => {
    // Scale 2: 600 × 400 frame, cut 0..200 × 0..400. Rotate 90: 400 × 600 frame, cut 0..400 × 400..600. Vertical flip: 0..200.
    const edits: JobEdit[] = [{ kind: "scale", percent: 200 }, { kind: "rotate", degrees: 90 }, { kind: "mirror", axis: "vertical" }, trimCut()];
    expectRect(resolveCutContour(edits, cropped), { x: 0, y: 0, width: 400, height: 200 });
  });

  it("clips the cut box to a crop", () => {
    expectRect(resolveCutContour([cropPt(50, 20, 100, 50), trimCut()], trimmed), { x: 0, y: 0, width: 100, height: 50 });
    expectRect(resolveCutContour([cropPt(50, 0, 100, 200), trimCut()], cropped), { x: 0, y: 0, width: 50, height: 200 });
  });

  it("rejects a cut box cropped away, naming the cutContour edit", () => {
    const error = editErrorOf(() => resolveCutContour([cropPt(150, 0, 100, 200), { ...trimCut(), id: "cut" }], cropped));
    expect(error.editIndex).toBe(1);
    expect(error.editId).toBe("cut");
    expect(error.message).toContain("outside");
  });

  it("offsets outward and inward at final size", () => {
    const out = mmToPt(3);
    expectRect(resolveCutContour([trimCut(3)], trimmed), { x: -out, y: -out, width: 200 + 2 * out, height: 100 + 2 * out });
    const inward = mmToPt(5);
    expectRect(resolveCutContour([trimCut(-5)], trimmed), { x: inward, y: inward, width: 200 - 2 * inward, height: 100 - 2 * inward });
    expectRect(resolveCutContour([{ kind: "scale", percent: 50 }, trimCut(-5)], trimmed), {
      x: inward,
      y: inward,
      width: 100 - 2 * inward,
      height: 50 - 2 * inward,
    });
  });

  it("rejects an inward offset that leaves no cut area", () => {
    // 100 pt is about 35.3 mm, so -18 mm on each side leaves nothing.
    const error = editErrorOf(() => resolveCutContour([{ kind: "copies", count: 1 }, trimCut(-18)], trimmed));
    expect(error.editIndex).toBe(1);
    expect(error.message).toContain("inward offset");
  });

  it("does not read the page for spot and none sources", () => {
    const empty: PageBoxes = { mediaBox: { x0: 0, y0: 0, x1: 0, y1: 0 } };
    expect(resolveCutContour([spotCut("CutContour")], empty)).toEqual({ kind: "spot", names: ["CutContour"] });
    expect(resolveCutContour([{ kind: "cutContour", source: { kind: "none" } }], empty)).toEqual({ kind: "none" });
  });
});

describe("resolveCutSource spot names", () => {
  it("renames spot names by later spotMap edits and drops names mapped to process", () => {
    const edits: JobEdit[] = [
      spotCut("A", "B", "D"),
      { kind: "spotMap", from: "A", to: { kind: "colorant", name: "C" } },
      { kind: "spotMap", from: "B", to: { kind: "process" } },
    ];
    expect(resolveCutSource(edits)).toEqual({ kind: "spot", names: ["C", "D"] });
    expect(resolveCutContour(edits, trimmed)).toEqual({ kind: "spot", names: ["C", "D"] });
  });

  it("follows chained renames and merges names that converge", () => {
    const edits: JobEdit[] = [
      spotCut("A", "B"),
      { kind: "spotMap", from: "A", to: { kind: "colorant", name: "B" } },
      { kind: "spotMap", from: "B", to: { kind: "colorant", name: "Kiss" } },
    ];
    expect(resolveCutSource(edits)).toEqual({ kind: "spot", names: ["Kiss"] });
  });

  it("leaves names alone for spotMap edits before the cutContour edit", () => {
    const edits: JobEdit[] = [{ kind: "spotMap", from: "A", to: { kind: "colorant", name: "C" } }, spotCut("A")];
    expect(resolveCutSource(edits)).toEqual({ kind: "spot", names: ["A"] });
  });

  it("can leave no names when every name maps to process", () => {
    const edits: JobEdit[] = [spotCut("A"), { kind: "spotMap", from: "A", to: { kind: "process" } }];
    expect(resolveCutSource(edits)).toEqual({ kind: "spot", names: [] });
  });
});
