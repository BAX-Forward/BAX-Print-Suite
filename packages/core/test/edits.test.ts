import { describe, expect, it } from "vitest";
import { JOB_EDIT_KINDS, MAX_CUT_OFFSET_MM, MAX_CUT_SPOT_NAMES, parseEdits } from "../src/index.js";

describe("parseEdits", () => {
  it("accepts every edit kind", () => {
    const result = parseEdits([
      { id: "a", kind: "scale", percent: 150 },
      { kind: "scale", fit: { dimension: "width", targetMm: 1000 } },
      { kind: "rotate", degrees: 90 },
      { kind: "mirror" },
      { kind: "crop", box: { xMm: 0, yMm: 0, widthMm: 10, heightMm: 10 } },
      { kind: "addBleed", mm: 5, mode: "mirror" },
      { kind: "pageSize", widthMm: 210, heightMm: 297 },
      { kind: "copies", count: 3 },
      { kind: "spotMap", from: "Spot A", to: { kind: "process" } },
      { kind: "spotMap", from: "Spot B", to: { kind: "colorant", name: "Spot C" } },
      { kind: "cutContour", source: { kind: "spot", names: ["CutContour", "Thru-cut"] } },
      { kind: "cutContour", source: { kind: "trimBox", offsetMm: -2.5 } },
      { kind: "cutContour", source: { kind: "none" } },
      { kind: "metadata", values: { customer: "Example Ltd", orderNumber: "4711", costCentre: "CC-9" } },
    ]);
    expect(result.ok).toBe(true);
  });

  it("accepts cutContour at the limits of names and offset", () => {
    const names = Array.from({ length: MAX_CUT_SPOT_NAMES }, (_, i) => `Cut ${i}`);
    expect(JOB_EDIT_KINDS).toContain("cutContour");
    expect(
      parseEdits([
        { kind: "cutContour", source: { kind: "spot", names } },
        { kind: "cutContour", source: { kind: "trimBox", offsetMm: MAX_CUT_OFFSET_MM } },
        { kind: "cutContour", source: { kind: "trimBox", offsetMm: -MAX_CUT_OFFSET_MM } },
      ]).ok,
    ).toBe(true);
  });

  it.each([
    [{ kind: "explode" }, "unknown edit kind"],
    [{ kind: "rotate", degrees: 45 }, "edits[0]"],
    [{ kind: "scale" }, "exactly one"],
    [{ kind: "scale", percent: 50, fit: { dimension: "width", targetMm: 10 } }, "exactly one"],
    [{ kind: "scale", percent: 0 }, "edits[0]"],
    [{ kind: "copies", count: 1.5 }, "edits[0]"],
    [{ kind: "addBleed", mm: 500, mode: "edge" }, "edits[0]"],
    [{ kind: "metadata", values: { "bad key": "x" } }, "invalid metadata key"],
    [{ kind: "spotMap", from: "A", to: { kind: "colorant", name: "A" } }, "to itself"],
    [{ kind: "cutContour" }, "edits[0]"],
    [{ kind: "cutContour", source: { kind: "spot", names: [] } }, "edits[0]/source"],
    [{ kind: "cutContour", source: { kind: "spot", names: [""] } }, "edits[0]/source"],
    [{ kind: "cutContour", source: { kind: "spot", names: Array.from({ length: 9 }, (_, i) => `Cut ${i}`) } }, "edits[0]/source"],
    [{ kind: "cutContour", source: { kind: "spot", names: ["Cut", "Cut"] } }, "more than once"],
    [{ kind: "cutContour", source: { kind: "trimBox", offsetMm: 50.5 } }, "edits[0]/source"],
    [{ kind: "cutContour", source: { kind: "trimBox", offsetMm: -51 } }, "edits[0]/source"],
    [{ kind: "cutContour", source: { kind: "trimBox" } }, "edits[0]/source"],
    [{ kind: "cutContour", source: { kind: "alpha" } }, "edits[0]/source"],
  ])("rejects %j", (edit, message) => {
    const result = parseEdits([edit]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain(message);
  });

  it("rejects a non-array", () => {
    expect(parseEdits({ kind: "rotate" }).ok).toBe(false);
  });
});
