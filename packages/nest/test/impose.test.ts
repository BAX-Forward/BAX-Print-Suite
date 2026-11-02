import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
  rgb,
  type PDFObject,
} from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  impose,
  layoutToJson,
  LAYOUT_METADATA_VERSION,
  nest,
  readLayoutMetadata,
  type ImposeSource,
  type ImposeWarning,
} from "../src/index.js";
import type { Layout, NestItem, NestOptions, Rotation } from "../src/types.js";
import { artPdf, LAYER_NAME, SPOT_NAME } from "./fixtures.js";
import { item, roll } from "./helpers.js";
import { openWithPdfJs, renderPage, type Raster, type Rgb } from "./render.js";

const ART_W = 120;
const ART_H = 80;
const BLEED = 9;
const COLOR_TOLERANCE = 3;
const PAGE_TOLERANCE_PT = 0.5;
const OPTS: NestOptions = { gutterPt: 20, algorithm: "maxrects" };

let plainArt: Uint8Array;
let bledArt: Uint8Array;

beforeAll(async () => {
  plainArt = await artPdf({ widthPt: ART_W, heightPt: ART_H });
  bledArt = await artPdf({ widthPt: ART_W, heightPt: ART_H, bleedPt: BLEED });
});

function sourcesFor(items: readonly NestItem[], pick: (item: NestItem) => Uint8Array): Map<string, ImposeSource> {
  return new Map(items.map((i) => [i.id, { pdfBytes: pick(i), pageIndex: 0, box: "trim" as const }]));
}

function expectColor(actual: Rgb, expected: Rgb, label: string): void {
  for (let channel = 0; channel < 3; channel++) {
    expect(Math.abs((actual[channel] ?? 0) - (expected[channel] ?? 0)), label).toBeLessThanOrEqual(COLOR_TOLERANCE);
  }
}

/** Where art point (u, v) of a w × h art box lands in the rotated footprint (counter-clockwise turns). */
function artToFootprint(rotation: Rotation, w: number, h: number, u: number, v: number): [number, number] {
  switch (rotation) {
    case 90:
      return [h - v, u];
    case 180:
      return [w - u, h - v];
    case 270:
      return [v, w - u];
    default:
      return [u, v];
  }
}

function pdfText(value: PDFObject | undefined): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}

function formXObjects(doc: PDFDocument, pageIndex: number): PDFStream[] {
  const xobjects = doc.getPage(pageIndex).node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!xobjects) return [];
  return xobjects.entries().flatMap(([, value]) => {
    const stream = value instanceof PDFRef ? doc.context.lookup(value) : value;
    return stream instanceof PDFStream ? [stream] : [];
  });
}

describe("impose: page geometry", () => {
  const media = roll(400, 10, 200);
  const items = [item("a", 180, 150, { quantity: 4 })];
  let layout: Layout;
  let pdf: Uint8Array;

  beforeAll(async () => {
    layout = nest(media, items, OPTS);
    pdf = await impose(layout, sourcesFor(items, () => plainArt));
  });

  it("splits into one page per panel past maxLengthPt", () => {
    expect(layout.placements).toHaveLength(4);
    expect(layout.panels).toHaveLength(2);
  });

  it("opens in pdf-lib with width = roll width and height = lead + length + trail", async () => {
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(layout.panels.length);
    for (const panel of layout.panels) {
      const { width, height } = doc.getPage(panel.index).getSize();
      expect(Math.abs(width - 400)).toBeLessThanOrEqual(PAGE_TOLERANCE_PT);
      expect(Math.abs(height - (10 + panel.lengthPt + 10))).toBeLessThanOrEqual(PAGE_TOLERANCE_PT);
    }
  });

  it("opens in pdf.js with the same page sizes", async () => {
    const doc = await openWithPdfJs(pdf);
    try {
      expect(doc.numPages).toBe(layout.panels.length);
      for (const panel of layout.panels) {
        const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = (await doc.getPage(panel.index + 1)).view;
        expect(Math.abs(x1 - x0 - 400)).toBeLessThanOrEqual(PAGE_TOLERANCE_PT);
        expect(Math.abs(y1 - y0 - (20 + panel.lengthPt))).toBeLessThanOrEqual(PAGE_TOLERANCE_PT);
      }
    } finally {
      await doc.destroy();
    }
  });

  it("produces one blank page for an empty layout", async () => {
    const empty = nest(media, [], OPTS);
    const doc = await PDFDocument.load(await impose(empty, new Map()));
    expect(doc.getPageCount()).toBe(1);
  });
});

describe("impose: preserved resources", () => {
  it("keeps the /Separation /TestSpot color space and the OCG (parsed from resources)", async () => {
    const items = [item("spot", ART_W, ART_H)];
    const pdf = await impose(nest(roll(400), items, OPTS), sourcesFor(items, () => plainArt));
    const doc = await PDFDocument.load(pdf);

    const forms = formXObjects(doc, 0);
    expect(forms).toHaveLength(1);
    const resources = forms[0]?.dict.lookupMaybe(PDFName.of("Resources"), PDFDict);
    const colorSpaces = resources?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
    const separations = (colorSpaces?.entries() ?? []).flatMap(([, value]) => {
      const space = value instanceof PDFRef ? doc.context.lookup(value) : value;
      return space instanceof PDFArray ? [space] : [];
    });
    expect(
      separations.some((s) => s.get(0) === PDFName.of("Separation") && s.get(1) === PDFName.of(SPOT_NAME)),
    ).toBe(true);

    const ocgRef = resources?.lookupMaybe(PDFName.of("Properties"), PDFDict)?.get(PDFName.of("OC0"));
    expect(ocgRef).toBeInstanceOf(PDFRef);
    const ocProperties = doc.catalog.lookupMaybe(PDFName.of("OCProperties"), PDFDict);
    const ocgs = ocProperties?.lookupMaybe(PDFName.of("OCGs"), PDFArray)?.asArray() ?? [];
    expect(ocgs).toContain(ocgRef);
    const ocg = doc.context.lookup(ocgRef as PDFRef, PDFDict);
    expect(pdfText(ocg.get(PDFName.of("Name")))).toBe(LAYER_NAME);
  });

  it("carries a source page's transparency group to the output page", async () => {
    const grouped = await artPdf({ widthPt: ART_W, heightPt: ART_H, transparencyGroup: true });
    const items = [item("g", ART_W, ART_H)];
    const doc = await PDFDocument.load(await impose(nest(roll(400), items, OPTS), sourcesFor(items, () => grouped)));
    const group = doc.getPage(0).node.lookupMaybe(PDFName.of("Group"), PDFDict);
    expect(group?.get(PDFName.of("S"))).toBe(PDFName.of("Transparency"));
  });
});

describe("impose: output intents", () => {
  const items = [item("first", ART_W, ART_H), item("second", ART_W, ART_H)];
  const layout = nest(roll(400), items, OPTS);

  async function imposeWithIntents(first: string, second: string): Promise<{ doc: PDFDocument; warnings: ImposeWarning[]; pdf: Uint8Array }> {
    const bytes = new Map([
      ["first", await artPdf({ widthPt: ART_W, heightPt: ART_H, outputIntent: first })],
      ["second", await artPdf({ widthPt: ART_W, heightPt: ART_H, outputIntent: second })],
    ]);
    const warnings: ImposeWarning[] = [];
    const pdf = await impose(layout, sourcesFor(items, (i) => bytes.get(i.id) ?? plainArt), {
      onWarning: (warning) => warnings.push(warning),
    });
    return { doc: await PDFDocument.load(pdf), warnings, pdf };
  }

  function intentIdentifier(doc: PDFDocument): string | undefined {
    const intents = doc.catalog.lookupMaybe(PDFName.of("OutputIntents"), PDFArray);
    const first = intents?.lookup(0, PDFDict);
    return pdfText(first?.get(PDFName.of("OutputConditionIdentifier")));
  }

  it("copies the first source's OutputIntent and warns on conflict", async () => {
    const { doc, warnings, pdf } = await imposeWithIntents("Condition A", "Condition B");
    expect(intentIdentifier(doc)).toBe("Condition A");
    expect(warnings.map((w) => w.code)).toEqual(["output-intent-conflict"]);
    const metadata = await readLayoutMetadata(pdf);
    expect(metadata?.warnings.map((w) => w.code)).toEqual(["output-intent-conflict"]);
  });

  it("does not warn when the OutputIntents agree", async () => {
    const { doc, warnings } = await imposeWithIntents("Condition A", "Condition A");
    expect(intentIdentifier(doc)).toBe("Condition A");
    expect(warnings).toEqual([]);
  });
});

describe("impose: rendered placements", () => {
  const SCALE = 2;
  const media = roll(600, 20);
  const rotations: readonly Rotation[] = [0, 90, 180, 270];
  const items = [
    ...rotations.map((r) => item(`plain-${r}`, ART_W, ART_H, { lock: { orientation: r } })),
    ...rotations.map((r) => item(`bled-${r}`, ART_W, ART_H, { bleedPt: BLEED, lock: { orientation: r } })),
  ];
  const isBled = (id: string): boolean => id.startsWith("bled");
  let layout: Layout;
  let output: Raster;
  let plainRaster: Raster;
  let bledRaster: Raster;

  beforeAll(async () => {
    layout = nest(media, items, OPTS);
    const pdf = await impose(layout, sourcesFor(items, (i) => (isBled(i.id) ? bledArt : plainArt)));
    output = await renderPage(pdf, 0, SCALE);
    plainRaster = await renderPage(plainArt, 0, SCALE);
    bledRaster = await renderPage(bledArt, 0, SCALE);
  });

  /** Quadrant centers, the spot square's center and (with bleed) a point inside the bleed. */
  function samplePoints(w: number, h: number, bleed: number): [number, number][] {
    const points: [number, number][] = [
      [w / 4, h / 4],
      [(3 * w) / 4, h / 4],
      [w / 4, (3 * h) / 4],
      [(3 * w) / 4, (3 * h) / 4],
      [w / 2, h / 2],
    ];
    return bleed > 0 ? [...points, [bleed / 2, h / 4]] : points;
  }

  it("uses a fixture whose sample colors are all distinct", () => {
    const colors = samplePoints(ART_W, ART_H, 0).map(([u, v]) => plainRaster.colorAt(u, v).join(","));
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("matches the source colors for unrotated and rotated placements, with and without bleed", () => {
    expect(layout.placements).toHaveLength(items.length);
    expect(new Set(layout.placements.map((p) => p.rotation))).toEqual(new Set(rotations));
    for (const p of layout.placements) {
      const bleed = isBled(p.itemId) ? BLEED : 0;
      const w = ART_W + 2 * bleed;
      const h = ART_H + 2 * bleed;
      const source = bleed > 0 ? bledRaster : plainRaster;
      for (const [u, v] of samplePoints(w, h, bleed)) {
        const [fx, fy] = artToFootprint(p.rotation, w, h, u, v);
        const actual = output.colorAt(media.margins.left + p.xPt + fx, media.margins.lead + p.yPt + fy);
        expectColor(actual, source.colorAt(u, v), `${p.itemId} at art (${u}, ${v})`);
      }
    }
  });

  it("clips art to the footprint so bleed outside it is not drawn", async () => {
    const clipped = [item("clipped", ART_W, ART_H)];
    const clipLayout = nest(media, clipped, OPTS);
    const raster = await renderPage(await impose(clipLayout, sourcesFor(clipped, () => bledArt)), 0, SCALE);
    const p = clipLayout.placements[0];
    expect(p).toBeDefined();
    const left = media.margins.left + (p?.xPt ?? 0);
    const bottom = media.margins.lead + (p?.yPt ?? 0);
    const white: Rgb = [255, 255, 255];
    expectColor(raster.colorAt(left - 4, bottom + ART_H / 2), white, "left of the footprint");
    expectColor(raster.colorAt(left + ART_W / 4, bottom - 4), white, "below the footprint");
    expectColor(raster.colorAt(left + ART_W / 4, bottom + ART_H / 4), bledRaster.colorAt(BLEED + ART_W / 4, BLEED + ART_H / 4), "inside");
  });
});

describe("impose: layout metadata", () => {
  it("round-trips /BPS_Layout", async () => {
    const items = [item("m", ART_W, ART_H, { quantity: 3, rotation: "any" })];
    const layout = nest(roll(400, 10), items, OPTS);
    const pdf = await impose(layout, sourcesFor(items, () => plainArt));
    const metadata = await readLayoutMetadata(pdf);
    expect(metadata?.version).toBe(LAYOUT_METADATA_VERSION);
    expect(metadata?.layout).toEqual(JSON.parse(layoutToJson(layout)));
    expect(metadata?.pages.map((page) => page.panel)).toEqual(layout.panels.map((panel) => panel.index));
    expect(metadata?.warnings).toEqual([]);
  });

  it("returns undefined for PDFs without metadata and for non-PDF bytes", async () => {
    expect(await readLayoutMetadata(plainArt)).toBeUndefined();
    expect(await readLayoutMetadata(new TextEncoder().encode("not a pdf"))).toBeUndefined();
  });

  it("warns about missing sources but still writes the PDF", async () => {
    const items = [item("lost", ART_W, ART_H)];
    const warnings: ImposeWarning[] = [];
    const pdf = await impose(nest(roll(400), items, OPTS), new Map(), { onWarning: (w) => warnings.push(w) });
    expect(warnings.map((w) => [w.code, w.itemId])).toEqual([["missing-source", "lost"]]);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });
});

describe("impose: marks hook", () => {
  const SCALE = 8;
  const media = roll(400, 10, 200);
  const items = [item("a", 180, 150, { quantity: 4 })];

  it("draws in the nesting frame: a 1 pt square at each placement origin is found by pdf.js", async () => {
    const art = await artPdf({ widthPt: 180, heightPt: 150 });
    const layout = nest(media, items, OPTS);
    expect(layout.panels.length).toBeGreaterThan(1);
    const calls: number[] = [];
    const pdf = await impose(layout, sourcesFor(items, () => art), {
      marks: async ({ page, layout: marked, frame, panel }) => {
        await Promise.resolve();
        calls.push(panel);
        for (const p of marked.placements) {
          if (p.panel !== panel) continue;
          page.drawRectangle({
            x: frame.originX + frame.scale * p.xPt,
            y: frame.originY + frame.scale * p.yPt,
            width: 1,
            height: 1,
            color: rgb(0, 0, 0),
          });
        }
      },
    });
    expect(calls).toEqual(layout.panels.map((panel) => panel.index));

    for (const panel of layout.panels) {
      const raster = await renderPage(pdf, panel.index, SCALE);
      for (const p of layout.placements.filter((placement) => placement.panel === panel.index)) {
        const x = media.margins.left + p.xPt;
        const y = media.margins.lead + p.yPt - panel.offsetPt;
        expectColor(raster.colorAt(x + 0.5, y + 0.5), [0, 0, 0], `mark at ${p.itemId}#${p.copy}`);
        const [r, g, b] = raster.colorAt(x + 3, y + 3);
        expect(r + g + b, `art next to mark at ${p.itemId}#${p.copy}`).toBeGreaterThan(100);
      }
    }
  });
});
