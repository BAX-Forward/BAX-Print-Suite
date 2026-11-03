import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MARKS_OCG_NAME,
  MARKS_SEPARATION_NAME,
  PT_PER_MM,
  draw,
  readLayoutMetadata,
  type Colorant,
  type FinishingMetadata,
  type FinishingSpecInput,
  type ItemInfo,
} from "../src/index.js";
import { decodePdfText } from "../src/pdf-writer.js";
import { placeMm } from "./helpers.js";
import {
  hookContext,
  imposeFixture,
  maxDiff,
  pageContent,
  placementTrimPx,
  renderPage,
  type Imposition,
} from "./pdf-helpers.js";

const BANNER: ItemInfo = { itemId: "banner", widthMm: 300, heightMm: 150, bleedMm: 3 };
const SIGN: ItemInfo = { itemId: "sign", widthMm: 120, heightMm: 80, bleedMm: 2 };
const ITEMS = [BANNER, SIGN];
const PLACEMENTS = [placeMm(BANNER, 15, 30), placeMm(SIGN, 340, 30, 90)];
const FRAME = { originX: 10 * PT_PER_MM, originY: 5 * PT_PER_MM, scale: 1 };
const PAGE = { w: 500 * PT_PER_MM, h: 220 * PT_PER_MM };
const JOB = { id: "J-PDF", name: "Spring", customer: "Bakery", date: "2026-01-01" };

/** Every mark kind except custom, with hem lines and grommets inside the trim so hiding the OCG matters. */
const FINISHING: FinishingSpecInput = {
  marks: [
    { kind: "crop" },
    { kind: "trim-line" },
    { kind: "grommet" },
    { kind: "hem-line", edges: ["top", "bottom"], offsetMm: 20 },
    { kind: "sew-line", edges: ["left"], offsetMm: 12 },
    { kind: "fold-line", positionMm: 60 },
  ],
  label: { edge: "bottom" },
};

async function marked(imp: Imposition, colorant?: Colorant): Promise<Uint8Array> {
  const { doc, ctx } = await hookContext(imp, PLACEMENTS);
  await draw(ctx, { items: ITEMS, job: JOB, finishing: { ...FINISHING, ...(colorant ? { colorant } : {}) } });
  return doc.save();
}

function ocgs(doc: PDFDocument): { ref: PDFRef; name: string | undefined }[] {
  const props = doc.catalog.lookupMaybe(PDFName.of("OCProperties"), PDFDict);
  const list = props?.lookupMaybe(PDFName.of("OCGs"), PDFArray);
  return (list?.asArray() ?? []).map((ref) => ({
    ref: ref as PDFRef,
    name: decodePdfText(doc.context.lookup(ref, PDFDict).get(PDFName.of("Name"))),
  }));
}

function defaultOn(doc: PDFDocument): PDFRef[] {
  const props = doc.catalog.lookup(PDFName.of("OCProperties"), PDFDict);
  const d = props.lookup(PDFName.of("D"), PDFDict);
  return d.lookup(PDFName.of("ON"), PDFArray).asArray() as PDFRef[];
}

interface SeparationSpace {
  readonly name: string;
  readonly alternate: string;
  readonly c1: number[];
}

function separations(doc: PDFDocument): SeparationSpace[] {
  const cs = doc.getPage(0).node.Resources()?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  if (!cs) return [];
  return cs.entries().flatMap(([, value]) => {
    const arr = doc.context.lookup(value);
    if (!(arr instanceof PDFArray) || arr.get(0) !== PDFName.of("Separation")) return [];
    const tint = arr.lookup(3, PDFDict);
    const c1 = tint
      .lookup(PDFName.of("C1"), PDFArray)
      .asArray()
      .map((n) => (n as PDFNumber).asNumber());
    return [{ name: arr.get(1).toString(), alternate: arr.get(2).toString(), c1 }];
  });
}

describe("PDF structure (FR2)", () => {
  let imp: Imposition;
  beforeAll(async () => {
    imp = await imposeFixture(PLACEMENTS, PAGE.w, PAGE.h, FRAME);
  });

  it("puts the marks in one `BPS Marks` OCG, visible by default, referenced from the page", async () => {
    const doc = await PDFDocument.load(await marked(imp));
    const groups = ocgs(doc);
    expect(groups.map((g) => g.name)).toEqual([MARKS_OCG_NAME]);
    expect(defaultOn(doc)).toContain(groups[0]!.ref);

    const props = doc.getPage(0).node.Resources()!.lookup(PDFName.of("Properties"), PDFDict);
    expect(props.entries().map(([, v]) => v)).toContain(groups[0]!.ref);
    const content = pageContent(doc);
    expect(content).toMatch(/\/OC \/BPSMarks BDC/);
  });

  it("paints in the `BPS-Marks` Separation with a 100 % K alternate by default", async () => {
    const doc = await PDFDocument.load(await marked(imp));
    expect(separations(doc)).toEqual([{ name: `/${MARKS_SEPARATION_NAME}`, alternate: "/DeviceCMYK", c1: [0, 0, 0, 1] }]);
    expect(pageContent(doc)).toContain("/BPSMarksCS cs /BPSMarksCS CS 1 scn 1 SCN");
    const meta = readLayoutMetadata(doc)!.finishing as FinishingMetadata;
    expect(meta).toMatchObject({ ocg: MARKS_OCG_NAME, colorant: "separation", colorantName: MARKS_SEPARATION_NAME });
  });

  it("can use the Registration colorant (/All) instead", async () => {
    const doc = await PDFDocument.load(await marked(imp, "registration"));
    expect(separations(doc)).toEqual([{ name: "/All", alternate: "/DeviceCMYK", c1: [1, 1, 1, 1] }]);
    expect((readLayoutMetadata(doc)!.finishing as FinishingMetadata).colorantName).toBe("All");
  });

  it("can use process K instead, without a Separation colour space", async () => {
    const doc = await PDFDocument.load(await marked(imp, "process-k"));
    expect(separations(doc)).toEqual([]);
    expect(pageContent(doc)).toContain("0 0 0 1 k 0 0 0 1 K");
    expect(ocgs(doc).map((g) => g.name)).toEqual([MARKS_OCG_NAME]);
    expect((readLayoutMetadata(doc)!.finishing as FinishingMetadata).colorantName).toBeNull();
  });

  it("creates the OCG once per document and records the page of each element", async () => {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage([PAGE.w, PAGE.h]), doc.addPage([PAGE.w, PAGE.h])];
    for (const [i, page] of pages.entries()) {
      await draw({ page, layout: { placements: [PLACEMENTS[i]!] }, frame: FRAME }, { items: ITEMS, job: JOB, finishing: FINISHING });
    }
    const loaded = await PDFDocument.load(await doc.save());
    expect(ocgs(loaded)).toHaveLength(1);
    const meta = readLayoutMetadata(loaded)!.finishing as FinishingMetadata;
    expect(new Set(meta.elements.filter((e) => e.itemId === "banner").map((e) => e.page))).toEqual(new Set([0]));
    expect(new Set(meta.elements.filter((e) => e.itemId === "sign").map((e) => e.page))).toEqual(new Set([1]));
  });

  it("hiding the OCG renders identically (±1/255) to the unmarked imposition inside every trim box", async () => {
    const scale = 2;
    const bytes = await marked(imp);
    const unmarked = await renderPage(imp.bytes, { scale });
    const hidden = await renderPage(bytes, { scale, hide: [MARKS_OCG_NAME] });
    const shown = await renderPage(bytes, { scale });
    expect(hidden.groups).toContain(MARKS_OCG_NAME);
    expect(hidden.image.width).toBe(unmarked.image.width);
    expect(hidden.image.height).toBe(unmarked.image.height);

    PLACEMENTS.forEach((p, i) => {
      const trim = placementTrimPx(ITEMS[i]!, p, imp, scale);
      expect(trim.x1).toBeGreaterThan(trim.x0);
      expect(trim.y1).toBeGreaterThan(trim.y0);
      expect(maxDiff(unmarked.image, hidden.image, trim)).toBeLessThanOrEqual(1);
      // Control: with the OCG visible, the hem lines and grommets inside the trim do change pixels.
      expect(maxDiff(unmarked.image, shown.image, trim)).toBeGreaterThan(1);
    });
  });
});
