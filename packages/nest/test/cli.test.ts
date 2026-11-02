import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli, USAGE, type CliIo } from "../src/cli.js";
import { parseLength, parseMargins, pointsTo, POINTS_PER, readLayoutMetadata } from "../src/index.js";
import type { Layout } from "../src/types.js";
import { artPdf } from "./fixtures.js";

interface Captured {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function capture(cwd: string): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { cwd, stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, out, err };
}

describe("units", () => {
  it("parses mm, cm, in, pt and bare points", () => {
    expect(parseLength("1626mm")).toBeCloseTo((1626 * 72) / 25.4, 9);
    expect(parseLength("2.5cm")).toBeCloseTo((25 * 72) / 25.4, 9);
    expect(parseLength("64in")).toBe(4608);
    expect(parseLength("36pt")).toBe(36);
    expect(parseLength(" 12 ")).toBe(12);
    expect(parseLength("10", "mm")).toBeCloseTo(10 * POINTS_PER.mm, 9);
    expect(parseLength("5 MM")).toBeCloseTo(5 * POINTS_PER.mm, 9);
  });

  it("rejects malformed lengths", () => {
    for (const text of ["", "abc", "10furlongs", "1.2.3mm", "mm"]) expect(parseLength(text)).toBeUndefined();
  });

  it("parses one margin for all sides or four as left,right,lead,trail", () => {
    const ten = 10 * POINTS_PER.mm;
    const all = parseMargins("10mm");
    for (const side of [all?.left, all?.right, all?.lead, all?.trail]) expect(side).toBeCloseTo(ten, 9);
    expect(parseMargins("1,2,3,4")).toEqual({ left: 1, right: 2, lead: 3, trail: 4 });
    expect(parseMargins("1,2")).toBeUndefined();
    expect(parseMargins("-1mm")).toBeUndefined();
  });

  it("converts points back to units", () => {
    expect(pointsTo(72, "in")).toBe(1);
    expect(pointsTo(parseLength("1626mm") ?? 0, "mm")).toBeCloseTo(1626, 9);
  });
});

describe("bps nest CLI", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bps-nest-"));
    await writeFile(join(dir, "art.pdf"), await artPdf({ widthPt: 120, heightPt: 80 }));
    const items = [
      { id: "card", width: "120pt", height: "80pt", quantity: 3, pdf: "art.pdf" },
      { id: "huge", widthPt: 5000, heightPt: 5000 },
    ];
    await writeFile(join(dir, "items.json"), JSON.stringify(items));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("nests items.json and writes the PDF, SVG and layout JSON", async () => {
    const { io, out, err } = capture(dir);
    const args = [
      "nest", "--roll", "1626mm", "--margins", "10mm", "--gutter", "5mm", "--rotation", "any",
      "items.json", "-o", "out.pdf", "--svg", "out.svg", "--json", "layout.json",
    ];
    expect(await runCli(args, io)).toBe(0);

    const layout = JSON.parse(await readFile(join(dir, "layout.json"), "utf8")) as Layout;
    expect(layout.mediaWidthPt).toBeCloseTo(1626 * POINTS_PER.mm, 6);
    expect(layout.media.margins.left).toBeCloseTo(10 * POINTS_PER.mm, 6);
    expect(layout.placements).toHaveLength(3);
    expect(layout.unplaced).toEqual([{ itemId: "huge", reason: "too-wide", copies: 1 }]);

    const svg = await readFile(join(dir, "out.svg"), "utf8");
    expect(svg.match(/<rect class="item"/g)).toHaveLength(3);

    const metadata = await readLayoutMetadata(new Uint8Array(await readFile(join(dir, "out.pdf"))));
    expect(metadata?.layout.placements).toEqual(layout.placements);
    expect(metadata?.warnings).toEqual([]);

    expect(out.join("")).toMatch(/^3 placed, length [\d.]+ mm, utilization [\d.]+%, 1 panel\(s\), auto:/);
    expect(err.join("")).toContain("unplaced: huge ×1 (too-wide)");
  });

  it("prints usage with --help", async () => {
    const { io, out } = capture(dir);
    expect(await runCli(["nest", "--help"], io)).toBe(0);
    expect(out.join("")).toBe(USAGE);
  });

  it.each([
    [["items.json"], "--roll is required"],
    [["--roll", "wide", "items.json"], "--roll: invalid length"],
    [["--roll", "100in", "--rotation", "sideways", "items.json"], "--rotation"],
    [["--roll", "100in"], "expected exactly one items.json"],
    [["--roll", "100in", "missing.json"], "cannot read missing.json"],
    [["--roll", "100in", "--bogus", "items.json"], "bps nest:"],
  ])("exits 2 with a usage message for %j", async (args, message) => {
    const { io, err } = capture(dir);
    expect(await runCli(["nest", ...args], io)).toBe(2);
    expect(err.join("")).toContain(message);
  });
});
