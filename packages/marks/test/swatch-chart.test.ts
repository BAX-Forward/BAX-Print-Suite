import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream, type PDFPage } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  MarkSpecError,
  parseSwatchChartOptions,
  planSwatchChart,
  renderSwatchChart,
  type SwatchChartOptionsInput,
  type SwatchColor,
  type SwatchLibrary,
} from "../src/index.js";
import { fontMetrics } from "../src/stroke-font.js";

const PT_PER_MM = 72 / 25.4;
/** Title line of the 10 pt stroke font plus the 3 mm gap above the first row. */
const TITLE_BAND_MM = fontMetrics(10).lineHeightMm + 3;

/** 100 × 100 mm, 3 columns of 20 mm swatches, 5 mm gap, 10 mm margin, no labels: 3 rows, 9 per page. */
const SMALL: SwatchChartOptionsInput = {
  pageWidthMm: 100,
  pageHeightMm: 100,
  columns: 3,
  swatchSizeMm: 20,
  gapMm: 5,
  marginMm: 10,
  showLabels: false,
};

function color(name: string, cmykFallback?: readonly [number, number, number, number]): SwatchColor {
  return cmykFallback ? { name, lab: { L: 50, a: 10, b: -20 }, cmykFallback } : { name, lab: { L: 50, a: 10, b: -20 } };
}

function library(count: number, name = "Test Lib"): SwatchLibrary {
  return { name, colors: Array.from({ length: count }, (_, i) => color(`Spot ${i + 1}`, [i, 0, 0, 0])) };
}

/** Decodes a serialized PDF name (ISO 32000-2 §7.3.5) back to its UTF-8 text. */
function decodePdfName(name: PDFName): string {
  const encoded = name.toString();
  const bytes: number[] = [];
  for (let i = 1; i < encoded.length; ) {
    if (encoded[i] === "#") {
      bytes.push(Number.parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      bytes.push(encoded.charCodeAt(i));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

interface SeparationInfo {
  readonly resource: string;
  readonly name: string;
  readonly alternate: string;
  readonly c0: number[];
  readonly c1: number[];
}

function numbers(array: PDFArray | undefined): number[] {
  return (array?.asArray() ?? []).map((o) => (o instanceof PDFNumber ? o.asNumber() : Number.NaN));
}

function separations(doc: PDFDocument, page: PDFPage): SeparationInfo[] {
  const spaces = page.node.Resources()?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  if (spaces === undefined) return [];
  return spaces.keys().map((key) => {
    const cs = doc.context.lookup(spaces.get(key), PDFArray);
    const tint = cs.lookup(3, PDFDict);
    expect(cs.lookup(0, PDFName)).toBe(PDFName.of("Separation"));
    return {
      resource: decodePdfName(key),
      name: decodePdfName(cs.lookup(1, PDFName)),
      alternate: decodePdfName(cs.lookup(2, PDFName)),
      c0: numbers(tint.lookupMaybe(PDFName.of("C0"), PDFArray)),
      c1: numbers(tint.lookupMaybe(PDFName.of("C1"), PDFArray)),
    };
  });
}

function content(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  const ref = contents instanceof PDFArray ? contents.get(contents.size() - 1) : undefined;
  const stream = ref ? doc.context.lookup(ref) : contents;
  return stream instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1") : "";
}

async function rendered(lib: SwatchLibrary, options?: SwatchChartOptionsInput): Promise<PDFDocument> {
  return PDFDocument.load(await renderSwatchChart(lib, options));
}

describe("planSwatchChart", () => {
  it("places swatches on a column grid below the title, in input order", () => {
    const [page] = planSwatchChart(library(5), SMALL);
    const cells = page?.cells ?? [];
    expect(cells.map((c) => c.name)).toEqual(["Spot 1", "Spot 2", "Spot 3", "Spot 4", "Spot 5"]);
    expect(cells.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
    const top = 100 - 10 - TITLE_BAND_MM;
    const expected = [
      [10, top - 20],
      [35, top - 20],
      [60, top - 20],
      [10, top - 45],
      [35, top - 45],
    ];
    cells.forEach((cell, i) => {
      expect(cell.xMm).toBeCloseTo(expected[i]?.[0] ?? Number.NaN, 9);
      expect(cell.yMm).toBeCloseTo(expected[i]?.[1] ?? Number.NaN, 9);
      expect(cell.wMm).toBe(20);
      expect(cell.hMm).toBe(20);
      expect(cell.labelLines).toEqual([]);
    });
    expect(page?.title).toBe("Test Lib - page 1 of 1");
    expect(page?.titleXMm).toBe(10);
    expect(page?.titleYMm).toBeCloseTo(90 - fontMetrics(10).lineHeightMm, 9);
  });

  it("wraps overflow onto a new page with the same grid", () => {
    const pages = planSwatchChart(library(10), SMALL);
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.cells.length)).toEqual([9, 1]);
    expect(pages.map((p) => p.title)).toEqual(["Test Lib - page 1 of 2", "Test Lib - page 2 of 2"]);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    const first = pages[0]?.cells[0];
    const overflow = pages[1]?.cells[0];
    expect(overflow?.name).toBe("Spot 10");
    expect(overflow?.index).toBe(9);
    expect(overflow?.xMm).toBe(first?.xMm);
    expect(overflow?.yMm).toBe(first?.yMm);
    expect(pages.flatMap((p) => p.cells.map((c) => c.name))).toEqual(library(10).colors.map((c) => c.name));
  });

  it("reserves the label band below each row when labels are on", () => {
    // Labels add 1 mm + 3 lines of 6 pt: two rows fit instead of three.
    const pages = planSwatchChart(library(7), { ...SMALL, showLabels: true });
    expect(pages.map((p) => p.cells.length)).toEqual([6, 1]);
    const [a, , , b] = pages[0]?.cells ?? [];
    expect((a?.yMm ?? 0) - (b?.yMm ?? 0)).toBeCloseTo(20 + 5 + 1 + 3 * fontMetrics(6).lineHeightMm, 9);
  });

  it("labels each swatch with its name, Lab to 1 decimal and CMYK fallback", () => {
    const lib: SwatchLibrary = {
      name: "Labels",
      colors: [
        { name: "Cyan Spot", lab: { L: 55, a: -37.04, b: -50.06 }, cmykFallback: [100, 0, 12.5, 0] },
        { name: "No Fallback", lab: { L: 99.96, a: -0.04, b: 0 } },
      ],
    };
    const [page] = planSwatchChart(lib);
    expect(page?.cells.map((c) => c.labelLines)).toEqual([
      ["Cyan Spot", "Lab 55.0 -37.0 -50.1", "CMYK 100 0 12.5 0"],
      ["No Fallback", "Lab 100.0 0.0 0.0", "CMYK none"],
    ]);
  });

  it("uses A4 defaults and returns one title-only page for an empty library", () => {
    const pages = planSwatchChart({ name: "Empty", colors: [] });
    expect(pages).toHaveLength(1);
    expect(pages[0]?.cells).toEqual([]);
    expect(pages[0]?.widthMm).toBe(210);
    expect(pages[0]?.heightMm).toBe(297);
    expect(pages[0]?.title).toBe("Empty - page 1 of 1");
  });

  it("returns a frozen plan", () => {
    const pages = planSwatchChart(library(2));
    expect(Object.isFrozen(pages)).toBe(true);
    expect(Object.isFrozen(pages[0])).toBe(true);
    expect(Object.isFrozen(pages[0]?.cells)).toBe(true);
    expect(Object.isFrozen(pages[0]?.cells[0])).toBe(true);
    expect(Object.isFrozen(pages[0]?.cells[0]?.labelLines)).toBe(true);
  });

  it("accepts a row that exactly fills the width between the margins", () => {
    // 4 × 16.25 + 3 × 5 = 80 and 2 × 37.5 + 5 = 80.
    expect(planSwatchChart(library(1), { ...SMALL, columns: 4, swatchSizeMm: 16.25 })[0]?.cells).toHaveLength(1);
    expect(planSwatchChart(library(1), { ...SMALL, columns: 2, swatchSizeMm: 37.5 })[0]?.cells).toHaveLength(1);
  });

  it.each<SwatchChartOptionsInput>([
    { columns: 0 },
    { columns: 1.5 },
    { columns: 20 },
    { swatchSizeMm: 2 },
    { gapMm: -1 },
    { marginMm: -1 },
    { pageWidthMm: Number.NaN },
    { pageHeightMm: 30 },
    { ...SMALL, columns: 4 },
    { ...SMALL, pageHeightMm: 40 },
  ])("rejects options %j with MarkSpecError", (options) => {
    expect(() => planSwatchChart(library(1), options)).toThrow(MarkSpecError);
    expect(() => planSwatchChart(library(1), options)).toThrow(/^invalid swatch chart options: /);
  });

  it("rejects a non-boolean showLabels", () => {
    expect(() => parseSwatchChartOptions({ showLabels: "yes" })).toThrow(/^invalid swatch chart options: showLabels: /);
  });

  it.each<[string, SwatchLibrary]>([
    ["blank library name", { name: " ", colors: [] }],
    ["blank spot name", { name: "L", colors: [color("  ")] }],
    ["control character", { name: "L", colors: [color("Bad\nName")] }],
    ["name over 127 UTF-8 bytes", { name: "L", colors: [color("é".repeat(64))] }],
    ["CMYK over 100", { name: "L", colors: [color("X", [101, 0, 0, 0])] }],
    ["L* over 100", { name: "L", colors: [{ name: "X", lab: { L: 120, a: 0, b: 0 } }] }],
  ])("rejects a library with %s", (_, lib) => {
    expect(() => planSwatchChart(lib)).toThrow(/^invalid swatch library: /);
  });
});

describe("renderSwatchChart", () => {
  it("produces a PDF that pdf-lib loads, one page per planned page at the requested size", async () => {
    const doc = await rendered(library(10), SMALL);
    expect(doc.getPageCount()).toBe(2);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(100 * PT_PER_MM, 3);
    expect(height).toBeCloseTo(100 * PT_PER_MM, 3);
    expect(doc.getTitle()).toBe("Test Lib");
  });

  it("fills each swatch through a Separation named after its spot with the CMYK fallback as alternate", async () => {
    const lib: SwatchLibrary = {
      name: "Spots",
      colors: [color("Warm Red", [0, 75, 90, 0]), color("Reflex Blue", [100, 73, 0, 2.5]), color("Gold", [5, 20, 60, 15])],
    };
    const doc = await rendered(lib);
    const page = doc.getPage(0);
    const seps = separations(doc, page);
    expect(seps.map((s) => s.name)).toEqual(["Warm Red", "Reflex Blue", "Gold"]);
    for (const s of seps) {
      expect(s.alternate).toBe("DeviceCMYK");
      expect(s.c0).toEqual([0, 0, 0, 0]);
    }
    expect(seps[0]?.c1).toEqual([0, 0.75, 0.9, 0]);
    expect(seps[1]?.c1).toEqual([1, 0.73, 0, 0.025]);
    expect(seps[2]?.c1).toEqual([0.05, 0.2, 0.6, 0.15]);

    const ops = content(doc, page);
    for (const s of seps) expect(ops).toMatch(new RegExp(`\\n/${s.resource} cs\\n1 scn\\n\\S+ \\S+ \\S+ \\S+ re\\nf\\n`));
    expect(ops.match(/ scn$/gm)).toHaveLength(3);
  });

  it("draws labels and title only in DeviceGray, after the spot fills", async () => {
    const doc = await rendered(library(2));
    const ops = content(doc, doc.getPage(0));
    const lastFill = ops.lastIndexOf("\nf\n");
    const labels = ops.slice(ops.indexOf("\n0 G\n"));
    expect(lastFill).toBeGreaterThan(0);
    expect(ops.indexOf("\n0 G\n")).toBeGreaterThan(lastFill);
    expect(labels).not.toMatch(/ (cs|scn|sc|k|K|rg|RG)$/m);
    expect(labels.match(/^S$/gm)?.length ?? 0).toBeGreaterThan(0);
  });

  it("uses zero CMYK as the alternate when a spot has no fallback", async () => {
    const doc = await rendered({ name: "Bare", colors: [color("Unknown Spot")] });
    const [sep] = separations(doc, doc.getPage(0));
    expect(sep?.name).toBe("Unknown Spot");
    expect(sep?.alternate).toBe("DeviceCMYK");
    expect(sep?.c1).toEqual([0, 0, 0, 0]);
  });

  it("renders an empty library as one page with only the title", async () => {
    const doc = await rendered({ name: "Empty", colors: [] });
    expect(doc.getPageCount()).toBe(1);
    const page = doc.getPage(0);
    expect(separations(doc, page)).toEqual([]);
    const ops = content(doc, page);
    expect(ops).not.toMatch(/ (re|cs|scn)$/m);
    expect(ops.match(/^S$/gm)?.length ?? 0).toBeGreaterThan(0);
  });

  it("puts each page's spots on that page only", async () => {
    const doc = await rendered(library(10), SMALL);
    expect(separations(doc, doc.getPage(0)).map((s) => s.name)).toEqual(library(9).colors.map((c) => c.name));
    expect(separations(doc, doc.getPage(1)).map((s) => s.name)).toEqual(["Spot 10"]);
  });

  it("keeps spot names with spaces, delimiters and non-ASCII characters exact", async () => {
    const names = ["Grün 485 C", "藍 Indigo", "Spot #1/A (B)", "Ré#20d", "Emoji 🎨"];
    const doc = await rendered({ name: "Unicode Lib Ü", colors: names.map((n) => color(n, [10, 20, 30, 40])) });
    const seps = separations(doc, doc.getPage(0));
    expect(seps.map((s) => s.name)).toEqual(names);
    expect(seps.every((s) => s.c1.join(" ") === "0.1 0.2 0.3 0.4")).toBe(true);
    expect(doc.getTitle()).toBe("Unicode Lib Ü");
  });

  it("rejects bad input with MarkSpecError", async () => {
    await expect(renderSwatchChart(library(1), { columns: 0 })).rejects.toBeInstanceOf(MarkSpecError);
    await expect(renderSwatchChart({ name: "L", colors: [color("")] })).rejects.toBeInstanceOf(MarkSpecError);
  });
});
