import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFObject,
} from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  impose,
  imposeNestItems,
  nest,
  stepAndRepeatJob,
  type ImposeSource,
  type ImposeWarning,
  type NestItemsResult,
} from "../src/index.js";
import type { ClipBox, Layout, NestItem, NestOptions } from "../src/types.js";
import { artPdf } from "./fixtures.js";
import { item, roll } from "./helpers.js";
import { renderPage, type Rgb } from "./render.js";

/** 300 × 200 pt source cut into a 2 × 3 grid of 100 pt panels. */
const SRC_W = 300;
const SRC_H = 200;
const CELL = 100;
const ROWS = 2;
const COLS = 3;
const MARGIN = 10;
const COLOR_TOLERANCE = 3;
const OPTS: NestOptions = { gutterPt: 20, algorithm: "maxrects" };
const media = roll(400, MARGIN);

let source: Uint8Array;

beforeAll(async () => {
  source = await artPdf({ widthPt: SRC_W, heightPt: SRC_H });
});

function panelItems(extra: Partial<NestItem> = {}): NestItem[] {
  const items: NestItem[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const clipBox: ClipBox = { x: col * CELL, y: row * CELL, width: CELL, height: CELL };
      items.push(item(`panel/${row}-${col}`, CELL, CELL, { pageIndex: 0, clipBox, ...extra }));
    }
  }
  return items;
}

function clipped(clipBox: ClipBox, extra: Partial<NestItem> = {}): NestItem[] {
  return [item("p", clipBox.width, clipBox.height, { clipBox, ...extra })];
}

/** Blanks CreationDate/ModDate, the only parts of the output that depend on the clock. */
function withoutDates(pdf: Uint8Array): string {
  return new TextDecoder("latin1").decode(pdf).replace(/\(D:[0-9Z+\-']*\)/g, "(D:)");
}

function decodedText(stream: PDFObject | undefined): string {
  if (stream instanceof PDFRawStream) return new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode());
  return "";
}

/** The page content stream with the XObject name suffix (pdf-lib's seeded counter) normalized. */
function pageContent(doc: PDFDocument, index: number): string[] {
  const contents = doc.getPage(index).node.Contents();
  const parts = contents instanceof PDFArray ? contents.asArray() : [contents];
  return parts
    .map((part) => decodedText(part instanceof PDFRef ? doc.context.lookup(part) : part))
    .join("\n")
    .replace(/\/BpsArt-\d+/g, "/BpsArt")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function formXObjects(doc: PDFDocument, pageIndex: number): PDFStream[] {
  const xobjects = doc.getPage(pageIndex).node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!xobjects) return [];
  return xobjects.entries().flatMap(([, value]) => {
    const stream = value instanceof PDFRef ? doc.context.lookup(value) : value;
    return stream instanceof PDFStream ? [stream] : [];
  });
}

function bbox(form: PDFStream | undefined): number[] {
  const values = form?.dict.lookupMaybe(PDFName.of("BBox"), PDFArray)?.asArray() ?? [];
  return values.flatMap((value) => (value instanceof PDFNumber ? [value.asNumber()] : []));
}

function imageCount(doc: PDFDocument): number {
  return doc.context
    .enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFStream && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))
    .length;
}

function existingSources(items: readonly NestItem[], bytes: Uint8Array): Map<string, ImposeSource> {
  return new Map(items.map((i) => [i.id, { pdfBytes: bytes, pageIndex: i.pageIndex ?? 0, box: "trim" as const }]));
}

function expectOk(result: NestItemsResult): { layout: Layout; imposedPdf: Uint8Array; warnings: readonly ImposeWarning[] } {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  return result;
}

function issueCodes(result: NestItemsResult): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

function expectColor(actual: Rgb, expected: Rgb, label: string): void {
  for (let channel = 0; channel < 3; channel++) {
    expect(Math.abs((actual[channel] ?? 0) - (expected[channel] ?? 0)), label).toBeLessThanOrEqual(COLOR_TOLERANCE);
  }
}

describe("existing entry points: unchanged output", () => {
  const plain = [item("a", SRC_W, SRC_H)];

  it("pins the content stream and form box of impose() for an item without clipBox", async () => {
    const layout = nest(media, plain, OPTS);
    const doc = await PDFDocument.load(await impose(layout, existingSources(plain, source)));
    const p = layout.placements[0];
    expect(p).toMatchObject({ xPt: 0, yPt: 0, rotation: 0 });
    expect(pageContent(doc, 0)).toEqual(["q", `1 0 0 1 ${MARGIN} ${MARGIN} cm`, "/BpsArt Do", "Q"]);
    const forms = formXObjects(doc, 0);
    expect(forms).toHaveLength(1);
    expect(bbox(forms[0])).toEqual([0, 0, SRC_W, SRC_H]);
  });

  it("imposeNestItems without clip boxes is byte-identical to nest() + impose()", async () => {
    const items = [item("a", SRC_W, SRC_H, { quantity: 2 }), item("b", SRC_W, SRC_H, { rotation: "90" })];
    const reference = await impose(nest(media, items, OPTS), existingSources(items, source));
    const { imposedPdf } = expectOk(await imposeNestItems(media, items, OPTS, { sourcePdf: source, sourceBox: "trim" }));
    expect(withoutDates(imposedPdf)).toBe(withoutDates(reference));
  });

  it("is byte-identical for an unclipped item whether or not a clipped item shares the sheet", async () => {
    const plainOnly = [item("a", SRC_W, SRC_H)];
    const mixed = [...plainOnly, ...clipped({ x: 0, y: 0, width: CELL, height: CELL })];
    const reference = await PDFDocument.load(await impose(nest(media, plainOnly, OPTS), existingSources(plainOnly, source)));
    const { imposedPdf } = expectOk(await imposeNestItems(media, mixed, OPTS, { sourcePdf: source, sourceBox: "trim" }));
    const lines = pageContent(await PDFDocument.load(imposedPdf), 0);
    // The unclipped placement's operators come first and match the reference exactly.
    expect(lines.slice(0, 4)).toEqual(pageContent(reference, 0));
  });

  it("stepAndRepeatJob output is deterministic apart from dates", async () => {
    const opts = {
      sourcePdf: source,
      sourceBox: "trim" as const,
      copies: 3,
      rollWidthMm: 500,
      marginsMm: { left: 5, right: 5, lead: 5, trail: 5 },
      gapXMm: 2,
      gapYMm: 2,
    };
    const first = await stepAndRepeatJob(opts);
    const second = await stepAndRepeatJob(opts);
    expect(withoutDates(second.imposedPdf)).toBe(withoutDates(first.imposedPdf));
  });
});

describe("imposeNestItems: clipped panels", () => {
  let result: { layout: Layout; imposedPdf: Uint8Array; warnings: readonly ImposeWarning[] };
  let doc: PDFDocument;
  const items = panelItems();

  beforeAll(async () => {
    result = expectOk(await imposeNestItems(media, items, OPTS, { sourcePdf: source, sourceBox: "trim" }));
    doc = await PDFDocument.load(result.imposedPdf);
  });

  it("places 2 × 3 panels from one source as 6 placements without warnings", () => {
    expect(result.layout.placements).toHaveLength(ROWS * COLS);
    expect(result.layout.unplaced).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("embeds each panel as a Form XObject whose BBox is its clip box", () => {
    const boxes = formXObjects(doc, 0).map((form) => bbox(form).join(" "));
    const expected = items.map((i) => {
      const c = i.clipBox;
      return c ? [c.x, c.y, c.x + c.width, c.y + c.height].join(" ") : "";
    });
    expect([...boxes].sort()).toEqual([...expected].sort());
    for (const form of formXObjects(doc, 0)) {
      expect(form.dict.get(PDFName.of("Subtype"))).toBe(PDFName.of("Form"));
    }
  });

  it("draws every placement with an XObject reference and adds no images", () => {
    const lines = pageContent(doc, 0);
    expect(lines.filter((line) => line === "/BpsArt Do")).toHaveLength(ROWS * COLS);
    expect(lines.filter((line) => line.endsWith(" cm"))).toHaveLength(ROWS * COLS);
    expect(imageCount(doc)).toBe(0);
  });

  it("puts each clip region in its placement (rendered colors match the source)", async () => {
    const scale = 2;
    const output = await renderPage(result.imposedPdf, 0, scale);
    const art = await renderPage(source, 0, scale);
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const p of result.layout.placements) {
      const clip = byId.get(p.itemId)?.clipBox;
      expect(clip).toBeDefined();
      if (!clip) continue;
      for (const [u, v] of [
        [10, 10],
        [90, 10],
        [10, 90],
        [90, 90],
      ] as const) {
        const actual = output.colorAt(MARGIN + p.xPt + u, MARGIN + p.yPt + v);
        expectColor(actual, art.colorAt(clip.x + u, clip.y + v), `${p.itemId} at (${u}, ${v})`);
      }
    }
  });

  it("is deterministic apart from dates", async () => {
    const again = expectOk(await imposeNestItems(media, items, OPTS, { sourcePdf: source, sourceBox: "trim" }));
    expect(withoutDates(again.imposedPdf)).toBe(withoutDates(result.imposedPdf));
  });

  it("centers the clip in a footprint with bleed by an extra translation", async () => {
    const bled = clipped({ x: 0, y: 0, width: CELL, height: CELL }, { bleedPt: 5 });
    const { imposedPdf, warnings } = expectOk(
      await imposeNestItems(media, bled, OPTS, { sourcePdf: source, sourceBox: "trim" }),
    );
    expect(warnings).toEqual([]);
    const lines = pageContent(await PDFDocument.load(imposedPdf), 0);
    expect(lines).toEqual(["q", `1 0 0 1 ${MARGIN} ${MARGIN} cm`, "1 0 0 1 5 5 cm", "/BpsArt Do", "Q"]);
  });
});

describe("imposeNestItems: validation issues", () => {
  const run = (items: readonly NestItem[], bytes?: Uint8Array): Promise<NestItemsResult> =>
    imposeNestItems(media, items, OPTS, { sourcePdf: bytes ?? source, sourceBox: "trim" });

  const invalid: { label: string; clipBox: ClipBox }[] = [
    { label: "NaN x", clipBox: { x: Number.NaN, y: 0, width: CELL, height: CELL } },
    { label: "infinite height", clipBox: { x: 0, y: 0, width: CELL, height: Number.POSITIVE_INFINITY } },
    { label: "zero width", clipBox: { x: 0, y: 0, width: 0, height: CELL } },
    { label: "negative height", clipBox: { x: 0, y: 0, width: CELL, height: -1 } },
  ];
  it.each(invalid)("rejects $label as invalid-clip-box", async ({ clipBox }) => {
    const result = await run([item("p", CELL, CELL, { clipBox })]);
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toEqual(["invalid-clip-box"]);
  });

  const outside: { label: string; clipBox: ClipBox }[] = [
    { label: "past the right edge", clipBox: { x: 250, y: 0, width: CELL, height: CELL } },
    { label: "past the top edge", clipBox: { x: 0, y: 150, width: CELL, height: CELL } },
    { label: "left of the origin", clipBox: { x: -1, y: 0, width: CELL, height: CELL } },
    { label: "below the origin", clipBox: { x: 0, y: -1, width: CELL, height: CELL } },
  ];
  it.each(outside)("rejects a clip box $label as clip-outside-source", async ({ clipBox }) => {
    expect(issueCodes(await run([item("p", CELL, CELL, { clipBox })]))).toEqual(["clip-outside-source"]);
  });

  it("accepts a clip box on the source edge within the tolerance", async () => {
    const result = await run(clipped({ x: 200 + 1e-9, y: 100, width: CELL, height: CELL }));
    expect(result.ok).toBe(true);
  });

  it.each([3, -1, 0.5])("rejects page index %s as page-out-of-range", async (pageIndex) => {
    const result = await run(clipped({ x: 0, y: 0, width: CELL, height: CELL }, { pageIndex }));
    expect(issueCodes(result)).toEqual(["page-out-of-range"]);
  });

  it("reports an unreadable source and duplicate ids without throwing", async () => {
    expect(issueCodes(await run(panelItems(), new TextEncoder().encode("not a pdf")))).toEqual(["unreadable-source"]);
    const twice = [...clipped({ x: 0, y: 0, width: CELL, height: CELL }), ...clipped({ x: 0, y: 0, width: CELL, height: CELL })];
    expect(issueCodes(await run(twice))).toEqual(["duplicate-item-id"]);
  });

  it("collects one issue per bad item with its id", async () => {
    const items = [
      item("nan", CELL, CELL, { clipBox: { x: Number.NaN, y: 0, width: CELL, height: CELL } }),
      item("good", CELL, CELL, { clipBox: { x: 0, y: 0, width: CELL, height: CELL } }),
      item("page", CELL, CELL, { pageIndex: 9 }),
    ];
    const result = await run(items);
    expect(result.ok ? [] : result.issues.map((issue) => [issue.itemId, issue.code])).toEqual([
      ["nan", "invalid-clip-box"],
      ["page", "page-out-of-range"],
    ]);
  });
});

describe("impose: clipBox on a source", () => {
  it("leaves the placement blank and warns for an invalid clip box", async () => {
    const items = [item("p", CELL, CELL)];
    const warnings: ImposeWarning[] = [];
    const sources = new Map<string, ImposeSource>([
      ["p", { pdfBytes: source, pageIndex: 0, box: "trim", clipBox: { x: 250, y: 0, width: CELL, height: CELL } }],
    ]);
    const pdf = await impose(nest(media, items, OPTS), sources, { onWarning: (w) => warnings.push(w) });
    expect(warnings.map((w) => [w.code, w.itemId])).toEqual([["invalid-clip-box", "p"]]);
    expect(formXObjects(await PDFDocument.load(pdf), 0)).toEqual([]);
  });
});
