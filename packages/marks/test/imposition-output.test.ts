import { PDFArray, PDFDocument, PDFRawStream, PDFRef, decodePDFRawStream, type PDFPage } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SOURCE_PAGES,
  MAX_SOURCE_PDF_BYTES,
  MarkSpecError,
  renderImposedSheets,
  type ImposedSheetsErrorCode,
  type ImpositionProofBookletPlan,
  type ImpositionProofNUpPlan,
  type ImpositionProofPageSlot,
} from "../src/index.js";

const PT_PER_MM = 72 / 25.4;
const BORDER_PT = 15 * PT_PER_MM;
const SOURCE_W = 200;
const SOURCE_H = 300;

/** A 2 x 3 n-up of 100 x 150 pt cells (half the source page), as in the Spec 036c tests. */
function nUp2x3(pageCount = 8, rotation = 0): ImpositionProofNUpPlan {
  const placements = Array.from({ length: 6 }, (_, index) => {
    const col = index % 3;
    const row = (index - col) / 3;
    return { index, row, col, x: 20 + col * 110, y: 180 - row * 160, width: 100, height: 150, rotation };
  });
  const sheets = Array.from({ length: Math.ceil(pageCount / 6) }, (_, index) => ({
    index,
    pages: Array.from({ length: 6 }, (_unused, slot): ImpositionProofPageSlot => {
      const page = index * 6 + slot + 1;
      return page <= pageCount ? page : "blank";
    }),
  }));
  return { rows: 2, cols: 3, rotation, placements, sheets };
}

/** 8 pages in one signature, creep 0 on the outer sheet and 1 pt on the inner one. */
const BOOKLET_8: ImpositionProofBookletPlan = {
  signatureCount: 1,
  binding: "left",
  sheets: [
    { index: 0, signature: 0, position: 0, front: [8, 1], back: [2, 7], creep: 0 },
    { index: 1, signature: 0, position: 1, front: [6, 3], back: [4, 5], creep: 1 },
  ],
};

/** One booklet sheet showing page 1 only. */
const BOOKLET_PAGE_1: ImpositionProofBookletPlan = {
  signatureCount: 1,
  binding: "left",
  sheets: [{ index: 0, signature: 0, position: 0, front: ["blank", 1], back: ["blank", "blank"], creep: 0 }],
};

/** `pageCount` distinct 200 x 300 pt pages, generated with pdf-lib. */
async function makeSource(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([SOURCE_W, SOURCE_H]);
    page.drawRectangle({ x: 10, y: 10, width: 20 + i * 10, height: 280 });
  }
  return doc.save();
}

const SOURCE_8 = makeSource(8);

const STREAM = "0 0 100 100 re f";

/** A hand-written PDF with a correct xref table; `extra` goes into the trailer. */
function handPdf(objects: readonly string[], extra: string): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  const size = objects.length + 1;
  body += `xref\n0 ${size}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${size} /Root 1 0 R ${extra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** A page tree listing one page object `kids` times; optionally an /Encrypt dictionary in the trailer. */
function handSource(kids: number, encrypted: boolean): Uint8Array {
  const zeros = "00".repeat(32);
  return handPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Kids [${Array.from({ length: kids }, () => "3 0 R").join(" ")}] /Count ${kids} >>`,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${SOURCE_W} ${SOURCE_H}] /Contents 4 0 R >>`,
      `<< /Length ${STREAM.length} >>\nstream\n${STREAM}\nendstream`,
      `<< /Filter /Standard /V 1 /R 2 /O <${zeros}> /U <${zeros}> /P -44 >>`,
    ],
    encrypted ? "/Encrypt 5 0 R " : "",
  );
}

function streams(doc: PDFDocument, page: PDFPage): string[] {
  const contents = page.node.Contents();
  const items = contents instanceof PDFArray ? contents.asArray() : [contents];
  return items.map((item) => {
    const stream = item instanceof PDFRef ? doc.context.lookup(item) : item;
    return stream instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1") : "";
  });
}

async function pageOps(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => streams(doc, page).join("\n"));
}

function doCount(ops: string): number {
  return ops.match(/^\/\S+ Do$/gm)?.length ?? 0;
}

function clipCount(ops: string): number {
  return ops.match(/ re\nW n\n/g)?.length ?? 0;
}

/** Every `cm` matrix, in drawing order. */
function matrices(ops: string): number[][] {
  return Array.from(ops.matchAll(/^(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm$/gm), (m) => m.slice(1).map(Number));
}

async function expectCode(promise: Promise<unknown>, code: ImposedSheetsErrorCode): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(MarkSpecError);
  await expect(promise).rejects.toMatchObject({ code });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderImposedSheets", () => {
  it("places an 8-page booklet: one clipped Do per slot, one PDF page per side", async () => {
    const bytes = await renderImposedSheets(BOOKLET_8, await SOURCE_8);
    const pages = await pageOps(bytes);
    expect(pages).toHaveLength(4);
    for (const ops of pages) {
      expect(doCount(ops)).toBe(2);
      expect(clipCount(ops)).toBe(2);
      expect(ops).not.toContain("/CropMarks BMC");
    }
    const doc = await PDFDocument.load(bytes);
    const media = doc.getPage(0).getMediaBox();
    expect(media.x).toBeCloseTo(BORDER_PT, 3);
    expect(media.width).toBeCloseTo(297 * PT_PER_MM, 3);
    expect(media.height).toBeCloseTo(210 * PT_PER_MM, 3);
  });

  it("keeps the source aspect and shifts booklet pages towards the spine by the creep", async () => {
    const pages = await pageOps(await renderImposedSheets(BOOKLET_8, await SOURCE_8));
    const outer = matrices(pages[0] ?? "");
    const inner = matrices(pages[2] ?? "");
    expect(outer).toHaveLength(2);
    expect(inner).toHaveLength(2);
    const [outerLeft, outerRight] = outer;
    const [innerLeft, innerRight] = inner;
    const scale = Math.min((148.5 * PT_PER_MM) / SOURCE_W, (210 * PT_PER_MM) / SOURCE_H);
    expect(outerLeft?.[0]).toBeCloseTo(scale, 5);
    expect(outerLeft?.[3]).toBeCloseTo(scale, 5);
    expect(outerLeft?.[1]).toBe(0);
    // Creep 1 pt on the inner sheet: left page moves right, right page moves left.
    expect((innerLeft?.[4] ?? 0) - (outerLeft?.[4] ?? 0)).toBeCloseTo(1, 5);
    expect((innerRight?.[4] ?? 0) - (outerRight?.[4] ?? 0)).toBeCloseTo(-1, 5);
    expect(innerLeft?.[5]).toBeCloseTo(outerLeft?.[5] ?? 0, 5);
  });

  it("places a 2 x 3 n-up: centred fit, clip per filled slot, nothing in BLANK slots", async () => {
    const pages = await pageOps(await renderImposedSheets(nUp2x3(8), await SOURCE_8));
    expect(pages).toHaveLength(2);
    expect(doCount(pages[0] ?? "")).toBe(6);
    expect(clipCount(pages[0] ?? "")).toBe(6);
    expect(doCount(pages[1] ?? "")).toBe(2);
    expect(clipCount(pages[1] ?? "")).toBe(2);
    // 200 x 300 into 100 x 150: half size, the source origin lands on the slot corner.
    const [first] = matrices(pages[0] ?? "");
    expect(first?.slice(0, 4)).toEqual([0.5, 0, 0, 0.5]);
    expect(first?.[4]).toBeCloseTo(20 + BORDER_PT, 5);
    expect(first?.[5]).toBeCloseTo(180 + BORDER_PT, 5);
    expect(pages[0]).toMatch(/re\nW n\n\S+ \S+ \S+ \S+ \S+ \S+ cm\n\/\S+ Do\nQ/);
  });

  it("rotates the page with an n-up placement's rotation", async () => {
    const plan = nUp2x3(6, 90);
    const turned = { ...plan, placements: plan.placements.map((p) => ({ ...p, width: 150, height: 100, x: 20 + p.col * 160 })) };
    const [ops] = await pageOps(await renderImposedSheets(turned, await SOURCE_8));
    const [first] = matrices(ops ?? "");
    expect(first?.slice(0, 4)).toEqual([0, 0.5, -0.5, 0]);
  });

  it("draws the Spec 036c proof marks on top with proofMarks", async () => {
    const source = await SOURCE_8;
    const bytes = await renderImposedSheets(nUp2x3(8), source, { proofMarks: true });
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    expect(page.getWidth()).toBeCloseTo(360 + 2 * BORDER_PT, 3);
    expect(page.getTrimBox().x).toBeCloseTo(BORDER_PT, 3);
    const ops = streams(doc, page).join("\n");
    expect(doCount(ops)).toBe(6);
    expect(clipCount(ops)).toBe(6);
    expect(ops).toContain("/ActualText (Page 1)");
    // Marks are drawn after (on top of) the last placed page.
    expect(ops.indexOf("/CropMarks BMC")).toBeGreaterThan(ops.lastIndexOf(" Do\n"));

    const plain = await pageOps(await renderImposedSheets(nUp2x3(8), source, { proofMarks: false }));
    expect(plain[0]).not.toContain("/CropMarks BMC");
    expect(plain[0]).not.toContain("ActualText");
  });

  it("is deterministic: identical input gives identical bytes", async () => {
    const source = await SOURCE_8;
    for (const [plan, proofMarks] of [
      [BOOKLET_8, false],
      [nUp2x3(8), false],
      [nUp2x3(8), true],
    ] as const) {
      const a = await renderImposedSheets(plan, source, { proofMarks });
      const b = await renderImposedSheets(plan, source, { proofMarks });
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    }
    const doc = await PDFDocument.load(await renderImposedSheets(BOOKLET_8, source), { updateMetadata: false });
    expect(doc.getProducer()).toBe("BAX Print Suite");
    expect(doc.getTitle()).toBe("Imposed sheets");
    expect(doc.getCreationDate()).toBeUndefined();
    expect(doc.getModificationDate()).toBeUndefined();
  });

  it("rejects an oversize source without parsing it", async () => {
    const load = vi.spyOn(PDFDocument, "load");
    const big = new Uint8Array(8);
    Object.defineProperty(big, "byteLength", { value: MAX_SOURCE_PDF_BYTES + 1 });
    expect(MAX_SOURCE_PDF_BYTES).toBe(256 * 1024 * 1024);
    await expectCode(renderImposedSheets(BOOKLET_8, big), "SOURCE_PDF_TOO_LARGE");
    expect(load).not.toHaveBeenCalled();
  });

  it("accepts a source of exactly the byte limit", async () => {
    const source = (await SOURCE_8).slice();
    Object.defineProperty(source, "byteLength", { value: MAX_SOURCE_PDF_BYTES });
    await expect(renderImposedSheets(BOOKLET_8, source)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("rejects an encrypted source; its unencrypted twin renders", async () => {
    await expectCode(renderImposedSheets(BOOKLET_PAGE_1, handSource(1, true)), "SOURCE_PDF_ENCRYPTED");
    const pages = await pageOps(await renderImposedSheets(BOOKLET_PAGE_1, handSource(1, false)));
    expect(pages.map(doCount)).toEqual([1, 0]);
  });

  it("loads the source without ignoreEncryption", async () => {
    const load = vi.spyOn(PDFDocument, "load");
    await expectCode(renderImposedSheets(BOOKLET_PAGE_1, handSource(1, true)), "SOURCE_PDF_ENCRYPTED");
    expect(load).toHaveBeenCalled();
    for (const call of load.mock.calls) {
      const options: unknown = call[1];
      expect(typeof options === "object" && options !== null && "ignoreEncryption" in options).toBe(false);
    }
  });

  it.each<[string, Uint8Array]>([
    ["garbage bytes", new TextEncoder().encode("this is not a PDF file at all")],
    ["no bytes", new Uint8Array(0)],
  ])("rejects %s as SOURCE_PDF_INVALID", async (_, bytes) => {
    await expectCode(renderImposedSheets(BOOKLET_8, bytes), "SOURCE_PDF_INVALID");
  });

  it(`rejects more than ${MAX_SOURCE_PAGES} source pages before embedding`, async () => {
    expect(MAX_SOURCE_PAGES).toBe(10_000);
    const embed = vi.spyOn(PDFDocument.prototype, "embedPage");
    await expectCode(renderImposedSheets(BOOKLET_PAGE_1, handSource(MAX_SOURCE_PAGES + 1, false)), "SOURCE_PDF_TOO_MANY_PAGES");
    expect(embed).not.toHaveBeenCalled();
    await expect(renderImposedSheets(BOOKLET_PAGE_1, handSource(MAX_SOURCE_PAGES, false))).resolves.toBeInstanceOf(Uint8Array);
  });

  it("rejects a plan page past the end of the source", async () => {
    await expectCode(renderImposedSheets(nUp2x3(9), await SOURCE_8), "PLAN_PAGE_OUT_OF_RANGE");
  });

  it("rejects more sheet sides than the proof limit", async () => {
    const sheet = BOOKLET_PAGE_1.sheets[0];
    if (sheet === undefined) throw new Error("fixture has no sheet");
    const sheets = Array.from({ length: 101 }, (_, index) => ({ ...sheet, index, signature: index }));
    const plan: ImpositionProofBookletPlan = { signatureCount: 101, binding: "left", sheets };
    await expectCode(renderImposedSheets(plan, await SOURCE_8), "PLAN_TOO_MANY_SIDES");
  });

  it("rejects a malformed plan or options as MarkSpecError", async () => {
    const source = await SOURCE_8;
    await expect(renderImposedSheets({ ...BOOKLET_8, sheets: [] }, source)).rejects.toThrow(/^invalid imposition plan: /);
    await expect(renderImposedSheets(BOOKLET_8, source, { borderMm: 3 })).rejects.toThrow(/^invalid imposition proof options: /);
  });
});
