import { describe, expect, it } from "vitest";
import { parseDxfOptions, ptToMm, sanitizeDxfLayerName, writeDxf } from "../src/index.js";
import { crlf, jobOf, marksMm, parseDxf, polylineMm, rectMm } from "./helpers.js";

const goldenJob = () =>
  jobOf({
    contours: [
      rectMm("c1", "kiss", 10, 10, 110, 60),
      polylineMm("c2", "pen", [
        [20, 90],
        [60, 90],
      ]),
    ],
    toolMap: { kiss: { toolId: "k" }, pen: { toolId: "p" } },
  });

const layer = (name: string): string[] => ["0", "LAYER", "2", name, "70", "0", "62", "7", "6", "CONTINUOUS"];
const vertex = (layerName: string, x: string, y: string): string[] => ["0", "VERTEX", "8", layerName, "10", x, "20", y, "30", "0.0000"];
const polyline = (layerName: string, closed: boolean): string[] => [
  "0", "POLYLINE", "8", layerName, "66", "1", "10", "0.0000", "20", "0.0000", "30", "0.0000", "70", closed ? "1" : "0",
];

const GOLDEN = crlf([
  "999", "BAX Print Suite cut export; units=mm",
  "0", "SECTION", "2", "HEADER",
  "9", "$ACADVER", "1", "AC1009",
  "9", "$EXTMIN", "10", "10.0000", "20", "10.0000", "30", "0.0000",
  "9", "$EXTMAX", "10", "110.0000", "20", "90.0000", "30", "0.0000",
  "0", "ENDSEC",
  "0", "SECTION", "2", "TABLES",
  "0", "TABLE", "2", "LTYPE", "70", "1",
  "0", "LTYPE", "2", "CONTINUOUS", "70", "0", "3", "Solid line", "72", "65", "73", "0", "40", "0.0000",
  "0", "ENDTAB",
  "0", "TABLE", "2", "LAYER", "70", "2",
  ...layer("CUT_KISS"),
  ...layer("PEN"),
  "0", "ENDTAB",
  "0", "ENDSEC",
  "0", "SECTION", "2", "ENTITIES",
  ...polyline("CUT_KISS", true),
  ...vertex("CUT_KISS", "10.0000", "10.0000"),
  ...vertex("CUT_KISS", "110.0000", "10.0000"),
  ...vertex("CUT_KISS", "110.0000", "60.0000"),
  ...vertex("CUT_KISS", "10.0000", "60.0000"),
  "0", "SEQEND", "8", "CUT_KISS",
  ...polyline("PEN", false),
  ...vertex("PEN", "20.0000", "90.0000"),
  ...vertex("PEN", "60.0000", "90.0000"),
  "0", "SEQEND", "8", "PEN",
  "0", "ENDSEC",
  "0", "EOF",
]);

describe("DXF R12 writer", () => {
  it("matches the golden output byte for byte (CRLF line endings)", () => {
    const { text, warnings } = writeDxf(goldenJob());
    expect(text).toBe(GOLDEN);
    expect(warnings).toEqual([]);
    expect(/(^|[^\r])\n/.test(text)).toBe(false);
  });

  it("parses with dxf-parser: layers, entity count, closed flags and vertices", () => {
    const circle = Array.from({ length: 24 }, (_, i): [number, number] => {
      const a = (2 * Math.PI * i) / 24;
      return [70 + 20.5 * Math.cos(a), 50 + 20.5 * Math.sin(a)];
    });
    const contours = [
      rectMm("outer", "thru", 5, 5, 150, 95),
      polylineMm("hole", "kiss", circle, true),
      polylineMm("fold", "crease", [
        [10, 50],
        [140, 50],
      ]),
    ];
    const job = jobOf({ contours });
    const dxf = parseDxf(writeDxf(job).text);

    expect(Object.keys(dxf.tables.layer.layers).sort()).toEqual(["CREASE", "CUT_KISS", "CUT_THRU"]);
    expect(dxf.entities).toHaveLength(3);
    expect(dxf.entities.map((e) => [e.type, e.layer, e.shape === true])).toEqual([
      ["POLYLINE", "CUT_THRU", true],
      ["POLYLINE", "CUT_KISS", true],
      ["POLYLINE", "CREASE", false],
    ]);
    contours.forEach((contour, i) => {
      const vertices = dxf.entities[i]?.vertices ?? [];
      expect(vertices).toHaveLength(contour.points.length);
      contour.points.forEach(([xPt, yPt], j) => {
        // vertices has contour.points.length entries (checked above).
        const vertex = vertices[j]!;
        expect(Math.abs(vertex.x - ptToMm(xPt))).toBeLessThanOrEqual(0.0001 + 1e-9);
        expect(Math.abs(vertex.y - ptToMm(yPt))).toBeLessThanOrEqual(0.0001 + 1e-9);
      });
    });
  });

  it("writes inches when units = in", () => {
    const job = jobOf({ contours: [rectMm("c1", "kiss", 25.4, 0, 50.8, 12.7)] });
    const { text } = writeDxf(job, parseDxfOptions({ units: "in" }));
    expect(text).toContain("999\r\nBAX Print Suite cut export; units=in\r\n");
    const vertices = parseDxf(text).entities[0]?.vertices ?? [];
    expect(vertices.map((v) => [v.x, v.y])).toEqual([
      [1, 0],
      [2, 0],
      [2, 0.5],
      [1, 0.5],
    ]);
  });

  it("uses user layer names (tool id first) and sanitizes them for R12", () => {
    const job = goldenJob();
    const { text } = writeDxf(job, { layerNames: { k: "Kiss cut 1", pen: "Draw" } });
    const dxf = parseDxf(text);
    expect(Object.keys(dxf.tables.layer.layers)).toEqual(["Kiss_cut_1", "Draw"]);
    expect(sanitizeDxfLayerName("a/b:c")).toBe("a_b_c");
    expect(sanitizeDxfLayerName("x".repeat(40))).toHaveLength(31);
  });

  it("uses '.' as decimal separator and exactly 4 decimals", () => {
    const job = jobOf({ contours: [polylineMm("c", "kiss", [[1 / 3, 2 / 3], [10.123456, 0.00004]])] });
    const lines = writeDxf(job).text.split("\r\n");
    const values = lines.filter((_, i) => i > 0 && ["10", "20"].includes(lines[i - 1]!));
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toMatch(/^-?\d+\.\d{4}$/);
    expect(values).toContain("0.3333");
    expect(values).toContain("10.1235");
    expect(values).toContain("0.0000");
  });

  it("adds TEXT labels and registration circles on request", () => {
    const job = jobOf({
      contours: [rectMm("c1", "kiss", 20, 20, 40, 40)],
      marks: marksMm([[10, 10], [90, 10], [10, 90]], 5),
      widthMm: 100,
      heightMm: 100,
    });
    const dxf = parseDxf(writeDxf(job, { labels: true, markLayer: "Marks", useMarkOrigin: false }).text);
    const circles = dxf.entities.filter((e) => e.type === "CIRCLE");
    expect(circles).toHaveLength(3);
    expect(circles.every((c) => c.layer === "Marks" && Math.abs((c.radius ?? 0) - 2.5) < 1e-9)).toBe(true);
    expect(dxf.entities.filter((e) => e.type === "TEXT").map((e) => e.text)).toEqual(["c1"]);
  });
});
