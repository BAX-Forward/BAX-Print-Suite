import { PDFDocument, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  readLayoutMetadata,
  stepAndRepeatJob,
  type Contour,
  type StepRepeatJobOptions,
} from "../src/index.js";
import type { Layout, Placement } from "../src/types.js";

const PT_PER_MM = 72 / 25.4;
const DIGITS = 6;
const PAGE_TOLERANCE_PT = 0.5;

function mm(value: number): number {
  return value * PT_PER_MM;
}

function margins(all: number): StepRepeatJobOptions["marginsMm"] {
  return { left: all, right: all, lead: all, trail: all };
}

/** One page: trim `widthMm` × `heightMm`, `bleedMm` on every side, media box = bleed box. */
async function sourcePdf(widthMm: number, heightMm: number, bleedMm = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bleed = mm(bleedMm);
  const width = mm(widthMm) + 2 * bleed;
  const height = mm(heightMm) + 2 * bleed;
  const page = doc.addPage([width, height]);
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.2, 0.4, 0.6) });
  page.setBleedBox(0, 0, width, height);
  page.setTrimBox(bleed, bleed, mm(widthMm), mm(heightMm));
  return doc.save();
}

async function options(
  pdf: Promise<Uint8Array>,
  extra: Partial<StepRepeatJobOptions> = {},
): Promise<StepRepeatJobOptions> {
  return {
    sourcePdf: await pdf,
    sourceBox: "trim",
    copies: 7,
    rollWidthMm: 340,
    marginsMm: margins(10),
    gapXMm: 10,
    gapYMm: 5,
    ...extra,
  };
}

/** The placement's footprint on the imposed page, shrunk by `insetPt` on every side. */
function footprintOnPage(layout: Layout, placement: Placement, insetPt = 0): [number, number, number, number] {
  const { left, lead } = layout.media.margins;
  const x = left + placement.xPt;
  const y = lead + placement.yPt;
  return [x + insetPt, y + insetPt, x + placement.footprint.w - insetPt, y + placement.footprint.h - insetPt];
}

function expectRect(
  contour: Contour | undefined,
  [minX, minY, maxX, maxY]: readonly [number, number, number, number],
): void {
  const expected: [number, number][] = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  expect(contour?.points).toHaveLength(4);
  expected.forEach(([x, y], index) => {
    expect(contour?.points[index]?.[0], `${contour?.id} x${index}`).toBeCloseTo(x, DIGITS);
    expect(contour?.points[index]?.[1], `${contour?.id} y${index}`).toBeCloseTo(y, DIGITS);
  });
}

function sizeMm(contour: Contour | undefined): [number, number] {
  const box = contour?.bbox;
  return box ? [(box.maxX - box.minX) / PT_PER_MM, (box.maxY - box.minY) / PT_PER_MM] : [Number.NaN, Number.NaN];
}

describe("stepAndRepeatJob: cut contours", () => {
  it("returns one closed trim rectangle per copy at the layout positions", async () => {
    const job = await stepAndRepeatJob(await options(sourcePdf(100, 50)));
    expect(job.warnings).toEqual([]);
    expect(job.layout.placements).toHaveLength(7);
    expect(job.cutContours).toHaveLength(7);
    expect(job.cutContours.map((c) => c.id)).toEqual(["copy-0", "copy-1", "copy-2", "copy-3", "copy-4", "copy-5", "copy-6"]);
    job.layout.placements.forEach((placement, index) => {
      const contour = job.cutContours[index];
      expect(contour?.closed).toBe(true);
      expect(contour?.tool).toBe("kiss");
      expect(contour?.source).toEqual({ kind: "layer", name: "trim" });
      expectRect(contour, footprintOnPage(job.layout, placement));
    });
    // Second column starts 10 mm margin + 100 mm copy + 10 mm gap from the left edge.
    expect(job.cutContours[1]?.bbox.minX).toBeCloseTo(mm(120), DIGITS);
    expect(job.cutContours[3]?.bbox.minY).toBeCloseTo(mm(65), DIGITS);
  });

  it("reports bbox and a positive (counter-clockwise) signed area", async () => {
    const job = await stepAndRepeatJob(await options(sourcePdf(100, 50), { copies: 1 }));
    const [contour] = job.cutContours;
    expect(contour?.bbox.minX).toBeCloseTo(mm(10), DIGITS);
    expect(contour?.bbox.minY).toBeCloseTo(mm(10), DIGITS);
    expect(contour?.bbox.maxX).toBeCloseTo(mm(110), DIGITS);
    expect(contour?.bbox.maxY).toBeCloseTo(mm(60), DIGITS);
    expect(contour?.areaSigned).toBeCloseTo(mm(100) * mm(50), 3);
  });

  it("follows rotated copies", async () => {
    // 30 × 100 mm on a 250 mm roll: auto turns it (2 × 5 grid, 150 mm instead of 200 mm).
    const job = await stepAndRepeatJob(
      await options(sourcePdf(30, 100), {
        copies: 10,
        rollWidthMm: 250,
        marginsMm: margins(0),
        gapXMm: 0,
        gapYMm: 0,
        rotate: "auto",
      }),
    );
    expect(job.warnings).toEqual([]);
    expect(new Set(job.layout.placements.map((p) => p.rotation))).toEqual(new Set([90]));
    expect(job.cutContours).toHaveLength(10);
    job.layout.placements.forEach((placement, index) => {
      const contour = job.cutContours[index];
      expectRect(contour, footprintOnPage(job.layout, placement));
      const [w, h] = sizeMm(contour);
      expect(w).toBeCloseTo(100, DIGITS);
      expect(h).toBeCloseTo(30, DIGITS);
    });
  });

  it("cuts the trim box, not the bleed box, when the item size comes from the bleed box", async () => {
    const job = await stepAndRepeatJob(await options(sourcePdf(100, 50, 3), { sourceBox: "bleed", copies: 4 }));
    expect(job.warnings).toEqual([]);
    const first = job.layout.placements[0];
    expect(first?.footprint.w).toBeCloseTo(mm(106), DIGITS);
    expect(first?.footprint.h).toBeCloseTo(mm(56), DIGITS);
    job.layout.placements.forEach((placement, index) => {
      expectRect(job.cutContours[index], footprintOnPage(job.layout, placement, mm(3)));
      expect(sizeMm(job.cutContours[index])[0]).toBeCloseTo(100, DIGITS);
    });
  });

  it("cuts the trim box of rotated bleed copies", async () => {
    // 34 × 104 mm with bleed: upright 7 × 2 = 208 mm, turned 2 × 5 = 170 mm.
    const job = await stepAndRepeatJob(
      await options(sourcePdf(30, 100, 2), {
        sourceBox: "bleed",
        copies: 10,
        rollWidthMm: 250,
        marginsMm: margins(0),
        gapXMm: 0,
        gapYMm: 0,
        rotate: "auto",
      }),
    );
    expect(new Set(job.layout.placements.map((p) => p.rotation))).toEqual(new Set([90]));
    job.layout.placements.forEach((placement, index) => {
      const contour = job.cutContours[index];
      expectRect(contour, footprintOnPage(job.layout, placement, mm(2)));
      const [w, h] = sizeMm(contour);
      expect(w).toBeCloseTo(100, DIGITS);
      expect(h).toBeCloseTo(30, DIGITS);
    });
  });
});

describe("stepAndRepeatJob: imposed PDF", () => {
  it("has a page of roll width by layout length when there are no lead or trail margins", async () => {
    const job = await stepAndRepeatJob(await options(sourcePdf(100, 50), { marginsMm: margins(0), rollWidthMm: 320 }));
    const doc = await PDFDocument.load(job.imposedPdf);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.abs(width - mm(320))).toBeLessThanOrEqual(PAGE_TOLERANCE_PT);
    expect(Math.abs(height - job.layout.lengthUsedPt)).toBeLessThanOrEqual(PAGE_TOLERANCE_PT);
    // 3 rows × 50 mm + 2 gaps × 5 mm.
    expect(job.layout.lengthUsedPt).toBeCloseTo(mm(160), DIGITS);
  });

  it("adds the lead and trail margins to the page length", async () => {
    const job = await stepAndRepeatJob(await options(sourcePdf(100, 50)));
    const { width, height } = (await PDFDocument.load(job.imposedPdf)).getPage(0).getSize();
    const { lead, trail } = job.layout.media.margins;
    expect(Math.abs(width - mm(340))).toBeLessThanOrEqual(PAGE_TOLERANCE_PT);
    expect(Math.abs(height - (lead + job.layout.lengthUsedPt + trail))).toBeLessThanOrEqual(PAGE_TOLERANCE_PT);
  });

  it("embeds the layout metadata of every copy", async () => {
    const job = await stepAndRepeatJob(await options(sourcePdf(100, 50)));
    const metadata = await readLayoutMetadata(job.imposedPdf);
    expect(metadata?.layout.placements).toHaveLength(7);
    expect(metadata?.layout.algorithm).toBe("step-repeat");
    expect(metadata?.warnings).toEqual([]);
  });

  it("uses the requested page of a multi-page source", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([mm(10), mm(10)]).drawRectangle({ x: 0, y: 0, width: 1, height: 1 });
    doc.addPage([mm(80), mm(40)]).drawRectangle({ x: 0, y: 0, width: 1, height: 1 });
    const job = await stepAndRepeatJob(await options(doc.save(), { pageIndex: 1, copies: 1 }));
    expect(sizeMm(job.cutContours[0])[0]).toBeCloseTo(80, DIGITS);
    expect(sizeMm(job.cutContours[0])[1]).toBeCloseTo(40, DIGITS);
  });
});

describe("stepAndRepeatJob: errors", () => {
  it("rejects an empty source PDF", async () => {
    await expect(stepAndRepeatJob(await options(Promise.resolve(new Uint8Array())))).rejects.toThrow(/source PDF is empty/);
  });

  it("rejects bytes that are not a PDF", async () => {
    const garbage = Promise.resolve(new TextEncoder().encode("not a pdf at all"));
    await expect(stepAndRepeatJob(await options(garbage))).rejects.toThrow(/cannot read source PDF/);
  });

  it.each([-1, 1, 0.5])("rejects page index %s", async (pageIndex) => {
    await expect(stepAndRepeatJob(await options(sourcePdf(100, 50), { pageIndex }))).rejects.toThrow(RangeError);
  });

  it("passes on layout errors", async () => {
    await expect(stepAndRepeatJob(await options(sourcePdf(400, 50)))).rejects.toThrow(/wider than the printable width/);
    await expect(stepAndRepeatJob(await options(sourcePdf(100, 50), { copies: 0 }))).rejects.toThrow(
      /copies must be a positive integer/,
    );
  });
});
