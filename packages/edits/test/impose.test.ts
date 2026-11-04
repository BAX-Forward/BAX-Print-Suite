import type { JobEdit } from "@bax-print/core";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { computeGeometry } from "../src/geometry.js";
import { EDGE_SAMPLE_PT, bleedRegions, imposeEdited, mediaBoxOf, pageSourceOf } from "../src/impose.js";

const PT_PER_MM = 72 / 25.4;
const WIDTH_PT = 200;
const HEIGHT_PT = 100;

async function sourcePdf(pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([WIDTH_PT, HEIGHT_PT]);
    page.drawRectangle({ x: 10, y: 10, width: 50, height: 30 });
  }
  return doc.save();
}

async function outputPage(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf);
  return { doc, page: doc.getPage(0) };
}

describe("imposeEdited", () => {
  it("writes exactly one page, even from a multi-page source", async () => {
    const result = await imposeEdited(await sourcePdf(3), 1, []);
    const { doc, page } = await outputPage(result.pdf);
    expect(doc.getPageCount()).toBe(1);
    expect(page.getSize()).toEqual({ width: WIDTH_PT, height: HEIGHT_PT });
  });

  it("sizes the page box to trim plus bleed", async () => {
    const edits: JobEdit[] = [{ kind: "addBleed", mm: 3, mode: "mirror" }];
    const result = await imposeEdited(await sourcePdf(), 0, edits);
    const { page } = await outputPage(result.pdf);
    const bleed = 3 * PT_PER_MM;
    const box = mediaBoxOf(page);
    expect(box.x0).toBe(0);
    expect(box.y0).toBe(0);
    expect(box.x1).toBeCloseTo(WIDTH_PT + 2 * bleed, 3);
    expect(box.y1).toBeCloseTo(HEIGHT_PT + 2 * bleed, 3);
    expect(result.geometry.footprintWidthPt).toBeCloseTo(box.x1, 3);
  });

  it("swaps the page box for a quarter turn and scales it", async () => {
    const edits: JobEdit[] = [{ kind: "rotate", degrees: 90 }, { kind: "scale", percent: 50 }];
    const result = await imposeEdited(await sourcePdf(), 0, edits);
    const { page } = await outputPage(result.pdf);
    const size = page.getSize();
    expect(size.width).toBeCloseTo(HEIGHT_PT / 2, 3);
    expect(size.height).toBeCloseTo(WIDTH_PT / 2, 3);
  });

  it("uses the pageSize override as the page box", async () => {
    const edits: JobEdit[] = [{ kind: "pageSize", widthMm: 100, heightMm: 50 }];
    const result = await imposeEdited(await sourcePdf(), 0, edits);
    const { page } = await outputPage(result.pdf);
    expect(page.getSize().width).toBeCloseTo(100 * PT_PER_MM, 3);
    expect(page.getSize().height).toBeCloseTo(50 * PT_PER_MM, 3);
  });

  it("reads the source page as the same page source preflight uses", async () => {
    const { page } = await outputPage(await sourcePdf());
    expect(pageSourceOf(page)).toEqual({ box: { x0: 0, y0: 0, x1: WIDTH_PT, y1: HEIGHT_PT }, rotate: 0, userUnit: 1 });
  });
});

describe("bleedRegions", () => {
  const source = { box: { x0: 0, y0: 0, x1: WIDTH_PT, y1: HEIGHT_PT } };

  it("draws only the trim area without bleed", () => {
    const regions = bleedRegions(computeGeometry(source, []));
    expect(regions).toHaveLength(1);
    expect(regions[0]?.region).toEqual({ x0: 0, y0: 0, x1: WIDTH_PT, y1: HEIGHT_PT });
  });

  it("adds eight bleed regions that tile the footprint in mirror mode", () => {
    const g = computeGeometry(source, [{ kind: "addBleed", mm: 5, mode: "mirror" }]);
    const regions = bleedRegions(g);
    expect(regions).toHaveLength(9);
    const area = regions.reduce((sum, { region }) => sum + (region.x1 - region.x0) * (region.y1 - region.y0), 0);
    expect(area).toBeCloseTo(g.footprintWidthPt * g.footprintHeightPt, 3);
    // A mirror reflects at unit scale: the left strip's matrix flips x without stretching.
    const left = regions.find(({ region }) => region.x1 === g.trimOriginX && region.y0 === g.trimOriginY);
    expect(left?.matrix[0]).toBeCloseTo(-1, 9);
  });

  it("stretches the edge strip outward in edge mode", () => {
    const g = computeGeometry(source, [{ kind: "addBleed", mm: 5, mode: "edge" }]);
    const left = bleedRegions(g).find(({ region }) => region.x1 === g.trimOriginX && region.y0 === g.trimOriginY);
    expect(left?.matrix[0]).toBeCloseTo(-(g.bleedPt / EDGE_SAMPLE_PT), 6);
  });

  it("drops generated bleed when the bleed is set back to 0", () => {
    const g = computeGeometry(source, [
      { kind: "addBleed", mm: 5, mode: "edge" },
      { kind: "addBleed", mm: 0, mode: "edge" },
    ]);
    expect(bleedRegions(g)).toHaveLength(1);
    expect(g.footprintWidthPt).toBe(WIDTH_PT);
  });
});
