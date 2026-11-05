import { describe, expect, it } from "vitest";
import {
  JOB_EDIT_KINDS,
  MAX_CUT_OFFSET_MM,
  MAX_CUT_SPOT_NAMES,
  MAX_PAGE_SELECTION_LENGTH,
  parseEdits,
  parsePageRanges,
} from "../src/index.js";

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
      { kind: "pages", selection: "1-3, 5, 8-" },
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
    [{ kind: "pages" }, "edits[0]"],
    [{ kind: "pages", selection: "" }, "edits[0]/selection"],
    [{ kind: "pages", selection: "1".repeat(MAX_PAGE_SELECTION_LENGTH + 1) }, "edits[0]/selection"],
    [{ kind: "pages", selection: "1-x" }, "invalid page range"],
    [{ kind: "pages", selection: "0" }, "numbered from 1"],
    [{ kind: "pages", selection: "5-3" }, "reversed"],
  ])("rejects %j", (edit, message) => {
    const result = parseEdits([edit]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain(message);
  });

  it("rejects a non-array", () => {
    expect(parseEdits({ kind: "rotate" }).ok).toBe(false);
  });
});

describe("parsePageRanges", () => {
  it.each([
    ["3", 5, [2]],
    ["1-3", 5, [0, 1, 2]],
    ["4-", 6, [3, 4, 5]],
    ["5-", 5, [4]],
    ["2-2", 3, [1]],
    [" 1 - 2 ,  4 ", 5, [0, 1, 3]],
    ["5,1-3,2", 5, [0, 1, 2, 4]],
    ["1-3,2-4,1-", 4, [0, 1, 2, 3]],
    ["1-3,5,8-", 9, [0, 1, 2, 4, 7, 8]],
  ])("resolves %j over %i pages", (selection, pageCount, expected) => {
    expect(parsePageRanges(selection, pageCount)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["", 3, "invalid page range"],
    ["1,,2", 3, "invalid page range"],
    ["1,", 3, "invalid page range"],
    ["-2", 3, "invalid page range"],
    ["1-2-3", 3, "invalid page range"],
    ["a", 3, "invalid page range"],
    ["1.5", 3, "invalid page range"],
    ["0", 3, "numbered from 1"],
    ["0-2", 3, "numbered from 1"],
    ["2-0", 3, "numbered from 1"],
    ["3-1", 3, "reversed"],
    ["4", 3, "beyond the last page (3)"],
    ["2-4", 3, "beyond the last page (3)"],
    ["4-", 3, "beyond the last page (3)"],
    ["9".repeat(30), 3, "too large"],
    ["1", 0, "page count"],
    ["1", 2.5, "page count"],
    [`1,${"2,".repeat(MAX_PAGE_SELECTION_LENGTH / 2)}`, 3, "longer than"],
  ])("rejects %j over %s pages", (selection, pageCount, message) => {
    const result = parsePageRanges(selection, pageCount);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain(message);
  });
});
