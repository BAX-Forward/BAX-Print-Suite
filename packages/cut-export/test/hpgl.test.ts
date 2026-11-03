import { describe, expect, it } from "vitest";
import { CutterDriverError } from "@bax-print/plugin-sdk";
import {
  HPGL_MAX_PAIRS_PER_PD,
  HPGL_OPTIONS_SCHEMA,
  HPGL_UNITS_PER_MM,
  parseHpglOptions,
  ptToMm,
  writeHpgl,
} from "../src/index.js";
import { jobOf, parseHpgl, polylineMm, rectMm } from "./helpers.js";

const goldenJob = () =>
  jobOf({
    contours: [
      rectMm("c1", "kiss", 10, 10, 110, 60),
      rectMm("c2", "thru", 5, 5, 150, 80),
      polylineMm("c3", "pen", [
        [20, 90],
        [60, 90],
      ]),
    ],
    toolMap: { kiss: { toolId: "k" }, thru: { toolId: "t" }, pen: { toolId: "p" } },
  });

describe("HPGL writer", () => {
  it("matches the golden output byte for byte (LF after each command)", () => {
    const { text, warnings } = writeHpgl(goldenJob());
    expect(text).toBe(
      [
        "IN;",
        "SP1;",
        "PU400,400;",
        "PD4400,400,4400,2400,400,2400,400,400;",
        "SP2;",
        "PU200,200;",
        "PD6000,200,6000,3200,200,3200,200,200;",
        "SP4;",
        "PU800,3600;",
        "PD2400,3600;",
        "PU;",
        "SP0;",
        "",
      ].join("\n"),
    );
    expect(warnings).toEqual([]);
  });

  it('writes no line breaks with lineEnding ""', () => {
    const { text } = writeHpgl(goldenJob(), { lineEnding: "" });
    expect(text).not.toContain("\n");
    expect(text.startsWith("IN;SP1;PU400,400;")).toBe(true);
    expect(text.endsWith("PU;SP0;")).toBe(true);
  });

  it("reproduces the contours within 1 plotter unit when parsed back", () => {
    const circle = Array.from({ length: 50 }, (_, i): [number, number] => {
      const a = (2 * Math.PI * i) / 50;
      return [50 + 30.123 * Math.cos(a), 50 + 30.123 * Math.sin(a)];
    });
    const contour = polylineMm("circle", "kiss", circle, true);
    const { text } = writeHpgl(jobOf({ contours: [contour] }));
    const { paths } = parseHpgl(text);
    expect(paths).toHaveLength(1);
    // Closed contours return to their start point.
    expect(paths[0].points).toHaveLength(51);
    expect(paths[0].points[50]).toEqual(paths[0].points[0]);
    contour.points.forEach(([xPt, yPt], i) => {
      const [x, y] = paths[0].points[i];
      expect(Math.abs(x - ptToMm(xPt) * HPGL_UNITS_PER_MM)).toBeLessThanOrEqual(1);
      expect(Math.abs(y - ptToMm(yPt) * HPGL_UNITS_PER_MM)).toBeLessThanOrEqual(1);
    });
  });

  it(`never puts more than ${HPGL_MAX_PAIRS_PER_PD} coordinate pairs in one PD`, () => {
    const points = Array.from({ length: 600 }, (_, i): [number, number] => [i, i % 2]);
    const { text } = writeHpgl(jobOf({ contours: [polylineMm("long", "kiss", points)], widthMm: 700 }));
    const { commands, paths } = parseHpgl(text);
    const pdPairs = commands.filter((c) => c.startsWith("PD")).map((c) => c.slice(2).split(",").length / 2);
    expect(pdPairs).toEqual([256, 256, 87]);
    expect(paths[0].points).toHaveLength(600);
  });

  it("honors a smaller maxPairsPerPD", () => {
    const { commands } = parseHpgl(writeHpgl(goldenJob(), { maxPairsPerPD: 2 }).text);
    const pd = commands.filter((c) => c.startsWith("PD"));
    expect(pd.every((c) => c.slice(2).split(",").length <= 4)).toBe(true);
    // 4 + 4 + 1 pairs -> 2 + 2 + 1 commands.
    expect(pd).toHaveLength(5);
  });

  it("selects pens from penMap: tool id first, then semantic tool, then defaults", () => {
    const job = goldenJob();
    const { paths } = parseHpgl(writeHpgl(job, { penMap: { kiss: 7, t: 9 } }).text);
    expect(paths.map((p) => p.pen)).toEqual([7, 9, 4]);
  });

  it("falls back to SP1 with a warning for tools without a pen number", () => {
    const { text, warnings } = writeHpgl(jobOf({ contours: [rectMm("c1", "foil", 0, 0, 10, 10)] }));
    expect(parseHpgl(text).paths[0].pen).toBe(1);
    expect(warnings).toEqual(['tool "foil": no pen number in penMap, using SP1']);
  });

  it("emits VS and FS only when opted in", () => {
    const job = goldenJob();
    job.toolMap.thru = { toolId: "t", speed: 20, force: 150 };
    const plain = writeHpgl(job, { velocity: 30, force: 80 }).text;
    expect(plain).not.toMatch(/VS|FS/);
    const opted = writeHpgl(job, { sendVelocity: true, sendForce: true, velocity: 30, force: 80 }).text;
    expect(parseHpgl(opted).commands.filter((c) => /^(VS|FS)/.test(c))).toEqual(["VS30", "FS80", "VS20", "FS150", "VS30", "FS80"]);
  });

  it("marks VS and FS options as device-dependent in the schema", () => {
    const props = HPGL_OPTIONS_SCHEMA.properties;
    for (const key of ["sendVelocity", "sendForce", "velocity", "force"] as const) {
      expect(props[key]["x-device-dependent"]).toBe(true);
    }
  });

  it("skips contours that collapse to a single plotter unit", () => {
    const tiny = polylineMm("tiny", "kiss", [
      [1, 1],
      [1.001, 1.001],
    ]);
    const { text, warnings } = writeHpgl(jobOf({ contours: [tiny] }));
    expect(text).toBe("IN;\nPU;\nSP0;\n");
    expect(warnings[0]).toContain("tiny");
  });

  it("rejects invalid options with invalid-options", () => {
    const bad: Record<string, unknown>[] = [
      { maxPairsPerPD: 0 },
      { maxPairsPerPD: 257 },
      { lineEnding: "\r\n" },
      { penMap: { kiss: -1 } },
      { penMap: [] },
      { sendForce: "yes" },
      { velocity: 0 },
      { origin: "middle" },
      { scale: [1, 0] },
      { offsetMm: [1] },
    ];
    for (const options of bad) {
      expect(() => parseHpglOptions(options), JSON.stringify(options)).toThrowError(CutterDriverError);
      try {
        parseHpglOptions(options);
      } catch (error) {
        expect((error as CutterDriverError).code).toBe("invalid-options");
      }
    }
    expect(parseHpglOptions({ penMap: { kiss: 3 }, lineEnding: "", unknownKey: 1 })).toEqual({ penMap: { kiss: 3 }, lineEnding: "" });
  });
});
