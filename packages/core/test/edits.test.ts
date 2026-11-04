import { describe, expect, it } from "vitest";
import { parseEdits } from "../src/index.js";

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
      { kind: "metadata", values: { customer: "Example Ltd", orderNumber: "4711", costCentre: "CC-9" } },
    ]);
    expect(result.ok).toBe(true);
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
  ])("rejects %j", (edit, message) => {
    const result = parseEdits([edit]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain(message);
  });

  it("rejects a non-array", () => {
    expect(parseEdits({ kind: "rotate" }).ok).toBe(false);
  });
});
