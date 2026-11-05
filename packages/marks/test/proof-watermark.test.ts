import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream, rgb } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { MarkSpecError, proofWatermark, type ProofWatermarkInput } from "../src/index.js";

const TRIM = { x: 20, y: 30, width: 200, height: 400 };

/** Page 1 has artwork, page 2 a trim box inside a larger media box, page 3 is empty. */
async function fixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const art = doc.addPage([600, 400]);
  art.drawRectangle({ x: 50, y: 50, width: 100, height: 100, color: rgb(1, 0, 0) });
  const trimmed = doc.addPage([300, 500]);
  trimmed.setTrimBox(TRIM.x, TRIM.y, TRIM.width, TRIM.height);
  trimmed.drawLine({ start: { x: 0, y: 0 }, end: { x: 300, y: 500 }, thickness: 2 });
  doc.addPage([200, 200]);
  return doc.save();
}

function streamCount(doc: PDFDocument, index: number): number {
  const contents = doc.getPage(index).node.Contents();
  if (contents instanceof PDFArray) return contents.size();
  return contents ? 1 : 0;
}

function lastStream(doc: PDFDocument, index: number): string {
  const contents = doc.getPage(index).node.Contents();
  const ref = contents instanceof PDFArray ? contents.get(contents.size() - 1) : undefined;
  const stream = ref ? doc.context.lookup(ref) : contents;
  return stream instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1") : "";
}

function opacityState(doc: PDFDocument, index: number): PDFDict | undefined {
  const states = doc.getPage(index).node.Resources()?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
  return states?.lookupMaybe(PDFName.of("BPSProof"), PDFDict);
}

/** The watermark's stroked ink box in page space (points transformed by `cm`, padded by half the stroke). */
function inkBox(content: string): { x0: number; y0: number; x1: number; y1: number } {
  const cm = /^(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm$/m.exec(content);
  const w = /^(\S+) w$/m.exec(content);
  expect(cm).not.toBeNull();
  expect(w).not.toBeNull();
  const [a, b, c, d, e, f] = (cm ?? []).slice(1).map(Number);
  const half = Number(w?.[1]) / 2;
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const m of content.matchAll(/^(\S+) (\S+) [ml]$/gm)) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    const px = (a ?? NaN) * x + (c ?? NaN) * y + (e ?? NaN);
    const py = (b ?? NaN) * x + (d ?? NaN) * y + (f ?? NaN);
    box.x0 = Math.min(box.x0, px - half);
    box.y0 = Math.min(box.y0, py - half);
    box.x1 = Math.max(box.x1, px + half);
    box.y1 = Math.max(box.y1, py + half);
  }
  return box;
}

async function stamped(options?: ProofWatermarkInput): Promise<PDFDocument> {
  return PDFDocument.load(await proofWatermark(await fixture(), options));
}

describe("proofWatermark", () => {
  let input: Uint8Array;
  let before: PDFDocument;
  let after: PDFDocument;

  beforeAll(async () => {
    input = await fixture();
    before = await PDFDocument.load(input);
    after = await PDFDocument.load(await proofWatermark(input));
  });

  it("keeps the page count and leaves the input bytes untouched", async () => {
    expect(after.getPageCount()).toBe(before.getPageCount());
    const copy = new Uint8Array(input);
    await proofWatermark(input);
    expect(input).toEqual(copy);
  });

  it("adds one watermark stream per page and wraps existing content in q/Q", () => {
    for (let i = 0; i < 3; i++) {
      const n = streamCount(before, i);
      expect(streamCount(after, i)).toBe(n > 0 ? n + 3 : 1);
      const content = lastStream(after, i);
      expect(content).toMatch(/^q\n\/BPSProof gs\n/);
      expect(content).toContain(" re W n\n");
      expect(content).toMatch(/S\nQ\n$/);
    }
  });

  it("paints through an ExtGState with the default 0.25 opacity", () => {
    for (let i = 0; i < 3; i++) {
      const state = opacityState(after, i);
      expect(state?.lookupMaybe(PDFName.of("CA"), PDFNumber)?.asNumber()).toBe(0.25);
      expect(state?.lookupMaybe(PDFName.of("ca"), PDFNumber)?.asNumber()).toBe(0.25);
    }
  });

  it("uses the caller's opacity, angle and font size", async () => {
    const doc = await stamped({ text: "Draft 2", opacity: 0.5, angleDeg: 90, fontSizePt: 40 });
    expect(opacityState(doc, 0)?.lookupMaybe(PDFName.of("ca"), PDFNumber)?.asNumber()).toBe(0.5);
    const content = lastStream(doc, 1);
    // Stroke width is 0.075 em; a 90° rotation is [0 1 -1 0 cx cy].
    expect(content).toContain("\n3 w\n");
    expect(content).toContain(`\n0 1 -1 0 ${TRIM.x + TRIM.width / 2} ${TRIM.y + TRIM.height / 2} cm\n`);
  });

  it("draws more strokes for longer text", async () => {
    const strokes = (content: string) => (content.match(/^S$/gm) ?? []).length;
    const doc = await stamped({ text: "PROOF PROOF" });
    expect(strokes(lastStream(after, 0))).toBeGreaterThan(0);
    expect(strokes(lastStream(doc, 0))).toBe(2 * strokes(lastStream(after, 0)));
  });

  it.each([0, 30, 45, 90, -60, 180])("auto-fit at %d° stays inside the trim box and fills it", async (angleDeg) => {
    for (const text of ["PROOF", "NOT FOR PRODUCTION - CUSTOMER PROOF 1/3"]) {
      const doc = await stamped({ text, angleDeg });
      for (let i = 0; i < 3; i++) {
        const trim = doc.getPage(i).getTrimBox();
        const box = inkBox(lastStream(doc, i));
        const eps = 0.01;
        expect(box.x0).toBeGreaterThanOrEqual(trim.x - eps);
        expect(box.y0).toBeGreaterThanOrEqual(trim.y - eps);
        expect(box.x1).toBeLessThanOrEqual(trim.x + trim.width + eps);
        expect(box.y1).toBeLessThanOrEqual(trim.y + trim.height + eps);
        const fill = Math.max((box.x1 - box.x0) / trim.width, (box.y1 - box.y0) / trim.height);
        expect(fill).toBeGreaterThan(0.8);
      }
    }
  });

  it("accepts the boundary values", async () => {
    await expect(proofWatermark(input, { text: "x".repeat(64), opacity: 0.05 })).resolves.toBeInstanceOf(Uint8Array);
    await expect(proofWatermark(input, { text: "~", opacity: 0.9, angleDeg: -360 })).resolves.toBeInstanceOf(Uint8Array);
  });

  it.each<ProofWatermarkInput>([
    { text: "" },
    { text: "x".repeat(65) },
    { text: "   " },
    { text: "PRO\nOF" },
    { text: "PRÜF" },
    { opacity: 0.01 },
    { opacity: 0.95 },
    { angleDeg: Number.NaN },
    { angleDeg: 720 },
    { fontSizePt: 0 },
  ])("rejects %j with MarkSpecError", async (options) => {
    const result = proofWatermark(input, options);
    await expect(result).rejects.toBeInstanceOf(MarkSpecError);
    await expect(result).rejects.toThrow(/^invalid proof watermark options: /);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(proofWatermark(new TextEncoder().encode("not a pdf"))).rejects.toBeInstanceOf(MarkSpecError);
  });
});
