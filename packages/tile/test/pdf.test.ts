import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { mmToPt, overlapStrip, panelClipBox, panelPdf, tile, type Panel, type Side, type TileSpec } from "../src/index.js";
import { ART, ART_BLEED_MM, artworkPdf } from "./fixtures/artwork.js";
import { maxChannelDiff, PX_PER_MM, renderPages, rgbAt, rgbAtMm, type Raster } from "./helpers/render.js";

/** Acceptance tolerance per channel (Spec 009, imposition). */
const TOLERANCE = 3;
/** Sample every third pixel in each direction. */
const STRIDE_PX = 3;

const SPEC: TileSpec = {
  grid: { mode: "count", columns: 3, rows: 2 },
  seam: { kind: "overlap", overlapMm: 25 },
  bleedMm: 5,
};

let source: Uint8Array;
let full: Raster;
let panels: Panel[];
let panelBytes: Uint8Array;
let panelRasters: Raster[];

beforeAll(async () => {
  source = await artworkPdf();
  const result = tile(ART, SPEC);
  expect(result.ok).toBe(true);
  panels = result.panels;
  panelBytes = await panelPdf(source, 0, panels);
  [full] = await renderPages(source);
  panelRasters = await renderPages(panelBytes);
});

const contains = (r: { x: number; y: number; width: number; height: number }, x: number, y: number): boolean =>
  x > r.x && x < r.x + r.width && y > r.y && y < r.y + r.height;

describe("acceptance: each panel render matches the crop of the full-page render", () => {
  it("renders one page per panel at the printed size", () => {
    expect(panelRasters).toHaveLength(panels.length);
    panels.forEach((panel, i) => {
      expect(panelRasters[i].width).toBe(Math.round(panel.printed.width * PX_PER_MM));
      expect(panelRasters[i].height).toBe(Math.round(panel.printed.height * PX_PER_MM));
    });
  });

  it("matches within ±3/255 at sampled points, including both neighbours' overlap strips and the bleed", () => {
    let worst = 0;
    let samples = 0;
    const overlapSamples = new Map<string, number>();

    panels.forEach((panel, i) => {
      const raster = panelRasters[i];
      for (let row = 1; row < raster.height; row += STRIDE_PX) {
        for (let col = 1; col < raster.width; col += STRIDE_PX) {
          // Pixel centre → artwork frame (mm from the trim's bottom-left).
          const x = panel.printed.x + (col + 0.5) / PX_PER_MM;
          const y = panel.printed.y + (raster.height - row - 0.5) / PX_PER_MM;
          const expected = rgbAtMm(full, x + ART_BLEED_MM, y + ART_BLEED_MM);
          worst = Math.max(worst, maxChannelDiff(rgbAt(raster, col, row), expected));
          samples++;
          for (const side of ["left", "right", "bottom", "top"] as Side[]) {
            const strip = overlapStrip(panel, side);
            if (strip && contains(strip, x, y)) {
              overlapSamples.set(panel.id, (overlapSamples.get(panel.id) ?? 0) + 1);
            }
          }
        }
      }
    });

    expect(samples).toBeGreaterThan(10_000);
    expect(worst).toBeLessThanOrEqual(TOLERANCE);
    // Every panel in a 3 × 2 overlap grid prints at least one overlap strip, and it was sampled.
    for (const panel of panels) expect(overlapSamples.get(panel.id) ?? 0).toBeGreaterThan(100);
  });

  it("prints the same overlap strip on both neighbours", () => {
    const a1 = panels.findIndex((p) => p.label === "A1");
    const a2 = panels.findIndex((p) => p.label === "A2");
    const strip = overlapStrip(panels[a1], "right");
    expect(strip).toBeDefined();
    if (!strip) return;

    let compared = 0;
    for (let x = strip.x + 0.25; x < strip.x + strip.width; x += 1.5) {
      for (let y = strip.y + 0.25; y < strip.y + strip.height; y += 1.5) {
        const left = rgbAtMm(panelRasters[a1], x - panels[a1].printed.x, y - panels[a1].printed.y);
        const right = rgbAtMm(panelRasters[a2], x - panels[a2].printed.x, y - panels[a2].printed.y);
        expect(maxChannelDiff(left, right)).toBeLessThanOrEqual(TOLERANCE);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(500);
  });
});

describe("FR7 output structure", () => {
  it("draws each panel from a Form XObject clipped to the printed area, without rasterizing", async () => {
    const doc = await PDFDocument.load(panelBytes);
    const sourceDoc = await PDFDocument.load(source);
    const trim = sourceDoc.getPage(0).getTrimBox();

    doc.getPages().forEach((page, i) => {
      const box = panelClipBox(panels[i], { x: trim.x, y: trim.y });
      const size = page.getSize();
      expect(size.width).toBeCloseTo(mmToPt(panels[i].printed.width), 6);
      expect(size.height).toBeCloseTo(mmToPt(panels[i].printed.height), 6);

      const xobjects = page.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
      expect(xobjects).toBeDefined();
      const entries = xobjects?.entries() ?? [];
      expect(entries).toHaveLength(1);
      const form = doc.context.lookup(entries[0][1], PDFStream);
      expect(form.dict.lookup(PDFName.of("Subtype"))?.toString()).toBe("/Form");
      const bbox = form.dict.lookup(PDFName.of("BBox"), PDFArray).asRectangle();
      expect(bbox.x).toBeCloseTo(box.x, 6);
      expect(bbox.y).toBeCloseTo(box.y, 6);
      expect(bbox.width).toBeCloseTo(box.width, 6);
      expect(bbox.height).toBeCloseTo(box.height, 6);
    });

    // No image XObject anywhere in the output.
    const images = doc.context
      .enumerateIndirectObjects()
      .filter(([, obj]) => obj instanceof PDFStream && obj.dict.lookup(PDFName.of("Subtype"))?.toString() === "/Image");
    expect(images).toHaveLength(0);
  });

  it("reprints a single panel identically to its page in the full set", async () => {
    const index = panels.findIndex((p) => p.label === "B2");
    const reprint = await panelPdf(source, 0, [panels[index]]);
    const [raster] = await renderPages(reprint);

    expect((await PDFDocument.load(reprint)).getPageCount()).toBe(1);
    expect(raster.width).toBe(panelRasters[index].width);
    expect(raster.height).toBe(panelRasters[index].height);
    expect(Buffer.from(raster.data).equals(Buffer.from(panelRasters[index].data))).toBe(true);
  });

  it("rejects a page index outside the document", async () => {
    await expect(panelPdf(source, 1, panels)).rejects.toThrow(RangeError);
  });
});
