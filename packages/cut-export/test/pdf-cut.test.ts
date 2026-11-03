import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildCutContentStream, layerPropertyNames, MM_SCALE_OPERAND, mmToPt, writeLayeredCutPdf, type PdfCutInput } from "../src/index.js";
import { ptFromMm } from "./helpers.js";

const input = (): PdfCutInput => ({
  frame: { widthPt: mmToPt(100), heightPt: mmToPt(50) },
  layers: [
    {
      name: "Thru-cut",
      paths: [{ points: ptFromMm([[10, 10], [20, 10], [20, 20], [10, 20]]), closed: true }],
    },
  ],
  markLayer: { name: "Regmark", circles: [{ xPt: mmToPt(5), yPt: mmToPt(5), dPt: mmToPt(5) }] },
});

const CM = `${MM_SCALE_OPERAND} 0 0 ${MM_SCALE_OPERAND} 0 0 cm`;

const GOLDEN = [
  "/OC /L0 BDC",
  "q",
  CM,
  "0.1 w",
  "0 0 0 RG",
  "10 10 m",
  "20 10 l",
  "20 20 l",
  "10 20 l",
  "h",
  "S",
  "Q",
  "EMC",
  "/OC /L1 BDC",
  "q",
  CM,
  "0 0 0 1 k",
  "7.5 5 m",
  "7.5 6.3807 6.3807 7.5 5 7.5 c",
  "3.6193 7.5 2.5 6.3807 2.5 5 c",
  "2.5 3.6193 3.6193 2.5 5 2.5 c",
  "6.3807 2.5 7.5 3.6193 7.5 5 c",
  "h",
  "f",
  "Q",
  "EMC",
  "",
].join("\n");

async function inspect(bytes: Uint8Array): Promise<{ content: string; layerNames: Record<string, string>; ocgCount: number }> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const stream = doc.context.lookup(page.node.get(PDFName.of("Contents")));
  if (!(stream instanceof PDFRawStream)) throw new Error("expected a single raw content stream");
  const content = new TextDecoder().decode(stream.getContents());
  const properties = page.node.Resources()?.lookup(PDFName.of("Properties"), PDFDict);
  const layerNames: Record<string, string> = {};
  for (const [, id] of content.matchAll(/\/OC \/(\w+) BDC/g)) {
    const ocg = properties?.lookup(PDFName.of(id), PDFDict);
    const name = ocg?.lookup(PDFName.of("Name"));
    if (!(name instanceof PDFString || name instanceof PDFHexString)) throw new Error(`OCG ${id} has no name`);
    layerNames[id] = name.decodeText();
  }
  const ocProperties = doc.catalog.lookup(PDFName.of("OCProperties"), PDFDict);
  return { content, layerNames, ocgCount: ocProperties.lookup(PDFName.of("OCGs"), PDFArray).size() };
}

describe("layered PDF cut file", () => {
  it("draws in mm through a cm scale and matches the golden content stream", () => {
    expect(Number(MM_SCALE_OPERAND)).toBeCloseTo(72 / 25.4, 7);
    expect(buildCutContentStream(input())).toBe(GOLDEN);
  });

  it("writes one OCG per layer, the mark layer last, and stores the content uncompressed", async () => {
    const { content, layerNames, ocgCount } = await inspect(await writeLayeredCutPdf(input()));
    expect(content).toBe(GOLDEN);
    expect(layerNames).toEqual({ L0: "Thru-cut", L1: "Regmark" });
    expect(ocgCount).toBe(2);
    expect(layerPropertyNames(input())).toEqual(["Thru-cut", "Regmark"]);
  });

  it("omits an empty mark layer and skips degenerate paths", () => {
    const text = buildCutContentStream({
      ...input(),
      layers: [{ name: "Kiss-cut", paths: [{ points: ptFromMm([[1, 1]]), closed: false }] }],
      markLayer: { name: "Regmark", circles: [] },
    });
    expect(text).toBe(["/OC /L0 BDC", "q", CM, "0.1 w", "0 0 0 RG", "Q", "EMC", ""].join("\n"));
    expect(layerPropertyNames({ ...input(), markLayer: { name: "Regmark", circles: [] } })).toEqual(["Thru-cut"]);
  });

  it("is deterministic (no dates or ids)", async () => {
    const a = await writeLayeredCutPdf(input());
    const b = await writeLayeredCutPdf(input());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
