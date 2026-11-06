import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream, type PDFPage } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  MAX_PROOF_SIDES,
  MarkSpecError,
  planImpositionProof,
  renderImpositionProof,
  type ImpositionProofBookletPlan,
  type ImpositionProofBookletSheet,
  type ImpositionProofNUpPlan,
  type ImpositionProofOptionsInput,
  type ImpositionProofPageSlot,
} from "../src/index.js";

const PT_PER_MM = 72 / 25.4;
const BORDER_PT = 15 * PT_PER_MM;
const CROP_OFFSET_PT = 2 * PT_PER_MM;
const CROP_LENGTH_PT = 5 * PT_PER_MM;

/**
 * A 2 x 3 n-up of 100 x 150 pt cells, gutter 10, margin 20, on a 360 x 350 pt
 * sheet, filled in reading order the way the Spec 036a planner does.
 */
function nUp2x3(pageCount = 8): ImpositionProofNUpPlan {
  const placements = Array.from({ length: 6 }, (_, index) => {
    const col = index % 3;
    const row = (index - col) / 3;
    return { index, row, col, x: 20 + col * 110, y: 180 - row * 160, width: 100, height: 150, rotation: 0 };
  });
  const sheets = Array.from({ length: Math.ceil(pageCount / 6) }, (_, index) => ({
    index,
    pages: Array.from({ length: 6 }, (_unused, slot): ImpositionProofPageSlot => {
      const page = index * 6 + slot + 1;
      return page <= pageCount ? page : "blank";
    }),
  }));
  return { rows: 2, cols: 3, rotation: 0, placements, sheets };
}

/** 8 pages in one 8-page signature, left binding, creep 1 pt (Spec 036a page order). */
const BOOKLET_8: ImpositionProofBookletPlan = {
  signatureCount: 1,
  binding: "left",
  sheets: [
    { index: 0, signature: 0, position: 0, front: [8, 1], back: [2, 7], creep: 0 },
    { index: 1, signature: 0, position: 1, front: [6, 3], back: [4, 5], creep: 1 },
  ],
};

/** `sheetCount` 4-page signatures, one sheet each. */
function booklet4(sheetCount: number): ImpositionProofBookletPlan {
  const sheets = Array.from({ length: sheetCount }, (_, index): ImpositionProofBookletSheet => {
    const b = index * 4;
    return { index, signature: index, position: 0, front: [b + 4, b + 1], back: [b + 2, b + 3], creep: 0 };
  });
  return { signatureCount: sheetCount, binding: "left", sheets };
}

function content(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  const ref = contents instanceof PDFArray ? contents.get(contents.size() - 1) : undefined;
  const stream = ref ? doc.context.lookup(ref) : contents;
  return stream instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1") : "";
}

/** ActualText of every label span, in drawing order. */
function labels(ops: string): string[] {
  return Array.from(ops.matchAll(/\/ActualText \(((?:\\.|[^\\)])*)\)/g), (m) => (m[1] ?? "").replace(/\\(.)/g, "$1"));
}

/** Body of the first `/<tag> BMC ... EMC` block. */
function markBlock(ops: string, tag: string): string {
  return new RegExp(`/${tag} BMC\\n([\\s\\S]*?)\\nEMC`).exec(ops)?.[1] ?? "";
}

function moveCount(ops: string): number {
  return ops.match(/ m$/gm)?.length ?? 0;
}

async function pageContents(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => content(doc, page));
}

function expectPdfEnvelope(bytes: Uint8Array): void {
  const text = Buffer.from(bytes).toString("latin1");
  expect(text.startsWith("%PDF-")).toBe(true);
  expect(text).toContain("startxref");
  expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
}

describe("planImpositionProof", () => {
  it("gives every slot eight crop marks pointing away from its corners", () => {
    const sides = planImpositionProof(nUp2x3());
    for (const side of sides) for (const slot of side.slots) expect(slot.cropMarks).toHaveLength(8);
    const slot = sides[0]?.slots[0];
    const x = 20 + BORDER_PT;
    const y = 180 + BORDER_PT;
    expect(slot?.frame.x).toBeCloseTo(x, 9);
    expect(slot?.frame.y).toBeCloseTo(y, 9);
    const [h, v] = slot?.cropMarks ?? [];
    expect(h?.y1).toBeCloseTo(y, 9);
    expect(h?.y2).toBeCloseTo(y, 9);
    expect(h?.x1).toBeCloseTo(x - CROP_OFFSET_PT, 9);
    expect(h?.x2).toBeCloseTo(x - CROP_OFFSET_PT - CROP_LENGTH_PT, 9);
    expect(v?.x1).toBeCloseTo(x, 9);
    expect(v?.y2).toBeCloseTo(y - CROP_OFFSET_PT - CROP_LENGTH_PT, 9);
  });

  it("derives the n-up sheet from the placements and shows gutter bands between rows and columns", () => {
    const [side] = planImpositionProof(nUp2x3());
    expect(side?.sheet.width).toBeCloseTo(360, 9);
    expect(side?.sheet.height).toBeCloseTo(350, 9);
    expect(side?.widthPt).toBeCloseTo(360 + 2 * BORDER_PT, 9);
    expect(side?.gutters).toHaveLength(3);
    const [col1, col2, row1] = side?.gutters ?? [];
    expect(col1?.x).toBeCloseTo(120 + BORDER_PT, 9);
    expect(col2?.x).toBeCloseTo(230 + BORDER_PT, 9);
    expect(col1?.width).toBeCloseTo(10, 9);
    expect(col1?.height).toBeCloseTo(310, 9);
    expect(row1?.y).toBeCloseTo(170 + BORDER_PT, 9);
    expect(row1?.height).toBeCloseTo(10, 9);
    expect(row1?.width).toBeCloseTo(320, 9);
    expect(side?.foldLines).toEqual([]);
    expect(side?.foldMarks).toEqual([]);
  });

  it("splits a booklet sheet into two pages with a spine fold line and ticks outside the sheet", () => {
    const sides = planImpositionProof(BOOKLET_8);
    expect(sides.map((s) => [s.sheetIndex, s.face])).toEqual([
      [0, "front"],
      [0, "back"],
      [1, "front"],
      [1, "back"],
    ]);
    const side = sides[0];
    const width = 297 * PT_PER_MM;
    const spine = BORDER_PT + width / 2;
    expect(side?.slots[0]?.frame.x).toBeCloseTo(BORDER_PT, 9);
    expect(side?.slots[1]?.frame.x).toBeCloseTo(spine, 9);
    expect(side?.slots.every((s) => Math.abs(s.frame.width - width / 2) < 1e-9)).toBe(true);
    expect(side?.foldLines).toHaveLength(1);
    expect(side?.foldLines[0]?.x1).toBeCloseTo(spine, 9);
    expect(side?.foldMarks).toHaveLength(2);
    const top = BORDER_PT + 210 * PT_PER_MM;
    expect(side?.foldMarks[0]?.y1).toBeCloseTo(top + CROP_OFFSET_PT, 9);
    expect(side?.foldMarks[1]?.y1).toBeCloseTo(BORDER_PT - CROP_OFFSET_PT, 9);
    expect(side?.gutters).toEqual([]);
  });

  it("returns a frozen plan", () => {
    const sides = planImpositionProof(BOOKLET_8);
    expect(Object.isFrozen(sides)).toBe(true);
    expect(Object.isFrozen(sides[0])).toBe(true);
    expect(Object.isFrozen(sides[0]?.slots)).toBe(true);
    expect(Object.isFrozen(sides[0]?.slots[0]?.cropMarks)).toBe(true);
    expect(Object.isFrozen(sides[0]?.headerLines)).toBe(true);
  });
});

describe("renderImpositionProof", () => {
  it("renders an 8-page booklet as one PDF page per side with every label", async () => {
    const bytes = await renderImpositionProof(BOOKLET_8);
    expectPdfEnvelope(bytes);
    const pages = await pageContents(bytes);
    expect(pages).toHaveLength(4);
    const sig = (n: number): string => `Signature 1 of 1, sheet ${n} from the outside, left binding`;
    expect(pages.map(labels)).toEqual([
      ["Page 8", "Page 1", "Sheet 1 of 2 - front", sig(1), "Creep 0 pt / 0 mm"],
      ["Page 2", "Page 7", "Sheet 1 of 2 - back", sig(1), "Creep 0 pt / 0 mm"],
      ["Page 6", "Page 3", "Sheet 2 of 2 - front", sig(2), "Creep 1 pt / 0.35 mm"],
      ["Page 4", "Page 5", "Sheet 2 of 2 - back", sig(2), "Creep 1 pt / 0.35 mm"],
    ]);
    for (const ops of pages) {
      expect(moveCount(markBlock(ops, "CropMarks"))).toBe(2 * 8);
      const fold = markBlock(ops, "FoldMarks");
      expect(fold).toContain("[3 2] 0 d");
      expect(moveCount(fold)).toBe(3);
    }
  });

  it("sizes each booklet page to the sheet plus the border", async () => {
    const doc = await PDFDocument.load(await renderImpositionProof(BOOKLET_8));
    expect(doc.getPage(0).getWidth()).toBeCloseTo((297 + 30) * PT_PER_MM, 2);
    expect(doc.getTitle()).toBe("Imposition proof");
  });

  it("renders a 2 x 3 n-up with BLANK slots, gutter bands and no fold marks", async () => {
    const bytes = await renderImpositionProof(nUp2x3(8));
    expectPdfEnvelope(bytes);
    const pages = await pageContents(bytes);
    expect(pages).toHaveLength(2);
    const summary = "2 x 3 n-up, gutter 3.53 x 3.53 mm, rotation 0";
    expect(pages.map(labels)).toEqual([
      ["Page 1", "Page 2", "Page 3", "Page 4", "Page 5", "Page 6", "Sheet 1 of 2 - front", summary],
      ["Page 7", "Page 8", "BLANK", "BLANK", "BLANK", "BLANK", "Sheet 2 of 2 - front", summary],
    ]);
    for (const ops of pages) {
      expect(moveCount(markBlock(ops, "CropMarks"))).toBe(6 * 8);
      expect(ops).not.toContain("/FoldMarks BMC");
      expect(ops).toMatch(/^0\.85 g\n(?:\S+ \S+ \S+ \S+ re\n){3}f$/m);
    }
    expect(pages[0]).not.toMatch(/^0\.93 g$/m);
    expect(pages[1]).toMatch(/^0\.93 g\n(?:\S+ \S+ \S+ \S+ re\n){4}f$/m);
  });

  it("draws no page content, images or fonts", async () => {
    const doc = await PDFDocument.load(await renderImpositionProof(nUp2x3()));
    const ops = content(doc, doc.getPage(0));
    expect(ops).not.toMatch(/ (Do|Tf|Tj|TJ|BI)$/m);
  });

  it("is deterministic: identical input gives identical bytes", async () => {
    for (const plan of [BOOKLET_8, nUp2x3(8)]) {
      const a = await renderImpositionProof(plan);
      const b = await renderImpositionProof(plan);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    }
  });

  it(`accepts ${MAX_PROOF_SIDES} sides and rejects more`, async () => {
    expect(MAX_PROOF_SIDES).toBe(200);
    expect(planImpositionProof(booklet4(100))).toHaveLength(200);
    expect(planImpositionProof(nUp2x3(200 * 6))).toHaveLength(200);
    await expect(renderImpositionProof(booklet4(101))).rejects.toThrow(/202 sheet sides, more than the limit of 200/);
    await expect(renderImpositionProof(nUp2x3(201 * 6))).rejects.toThrow(/201 sheet sides, more than the limit of 200/);
    await expect(renderImpositionProof(booklet4(101))).rejects.toBeInstanceOf(MarkSpecError);
  });

  const plan = nUp2x3();
  it.each<[string, ImpositionProofNUpPlan | ImpositionProofBookletPlan]>([
    ["an n-up plan with no sheets", { ...plan, sheets: [] }],
    ["an n-up plan with no placements", { ...plan, placements: [] }],
    ["placements that do not fill the grid", { ...plan, rows: 3 }],
    ["a sheet with fewer pages than slots", { ...plan, sheets: [{ index: 0, pages: [1, 2, 3, 4, 5] }] }],
    ["page number 0", { ...plan, sheets: [{ index: 0, pages: [0, 1, 2, 3, 4, 5] }] }],
    ["a zero-width placement", { ...plan, placements: plan.placements.map((p) => ({ ...p, width: 0 })) }],
    ["a negative placement x", { ...plan, placements: plan.placements.map((p) => ({ ...p, x: -1 })) }],
    ["a booklet with no sheets", { ...BOOKLET_8, sheets: [] }],
    ["a negative creep", { ...BOOKLET_8, sheets: BOOKLET_8.sheets.map((s) => ({ ...s, creep: -1 })) }],
    ["a signature past the count", { ...BOOKLET_8, sheets: BOOKLET_8.sheets.map((s) => ({ ...s, signature: 1 })) }],
  ])("rejects %s", async (_, bad) => {
    expect(() => planImpositionProof(bad)).toThrow(/^invalid imposition plan: /);
    await expect(renderImpositionProof(bad)).rejects.toBeInstanceOf(MarkSpecError);
  });

  it.each<ImpositionProofOptionsInput>([
    { borderMm: 3 },
    { cropOffsetMm: 10, cropLengthMm: 10 },
    { cropLengthMm: 0 },
    { sheet: { width: 0, height: 100 } },
    { sheet: { width: Number.NaN, height: 100 } },
  ])("rejects options %j", (options) => {
    expect(() => planImpositionProof(BOOKLET_8, options)).toThrow(/^invalid imposition proof options: /);
  });

  it("rejects an n-up sheet smaller than the placements", () => {
    const tooSmall = (): unknown => planImpositionProof(nUp2x3(), { sheet: { width: 300, height: 350 } });
    expect(tooSmall).toThrow(MarkSpecError);
    expect(tooSmall).toThrow(/slot 2 reaches past the 300 x 350 pt sheet/);
  });
});
