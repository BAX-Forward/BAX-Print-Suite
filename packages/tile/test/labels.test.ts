import { describe, expect, it } from "vitest";
import { letters, panelLabel, tile } from "../src/index.js";

describe("FR5 panel identity and labels", () => {
  it("acceptance: a 3 × 4 grid (3 rows, 4 columns) yields A1..C4 in row-major order", () => {
    const result = tile({ widthMm: 4000, heightMm: 3000 }, { grid: { mode: "count", columns: 4, rows: 3 } });

    expect(result.panels.map((p) => p.label)).toEqual([
      "A1", "A2", "A3", "A4",
      "B1", "B2", "B3", "B4",
      "C1", "C2", "C3", "C4",
    ]);
    expect(result.panels.map((p) => p.index)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("gives every panel its row, column and label parts", () => {
    const b3 = tile({ widthMm: 4000, heightMm: 3000 }, { grid: { mode: "count", columns: 4, rows: 3 } }).panels.find(
      (p) => p.label === "B3",
    );
    expect(b3).toMatchObject({ id: "2-3", row: 2, col: 3, index: 7, labelParts: { row: "B", col: "3" } });
  });

  it("continues rows past Z spreadsheet-style", () => {
    expect([1, 26, 27, 52, 53, 702, 703].map(letters)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
    expect(() => letters(0)).toThrow(RangeError);
  });

  it("supports other naming styles and separates parts of the same style", () => {
    expect(panelLabel(2, 11, { rows: "numbers", cols: "numbers" })).toBe("2-11");
    expect(panelLabel(2, 3, { rows: "numbers", cols: "letters" })).toBe("2C");
    expect(panelLabel(2, 3, { separator: "." })).toBe("B.3");
  });
});
