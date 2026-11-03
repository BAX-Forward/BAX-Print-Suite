/**
 * Acceptance (differential, own fixtures): reassemble the panel renders
 * virtually, translating each by its offset in the artwork and discarding
 * overlap and bleed, then compare with the unsplit render. Metric: number of
 * visible pixels that differ in any channel. Tolerance: 0.
 */
import { describe, expect, it } from "vitest";
import { panelPdf, tile, type Panel, type TileSpec } from "../src/index.js";
import { ART, ART_BLEED_MM, artworkPdf } from "./fixtures/artwork.js";
import { PX_PER_MM, renderPages, rgbAt, type Raster } from "./helpers/render.js";

const px = (mm: number): number => Math.round(mm * PX_PER_MM);

interface Reassembly {
  /** Artwork pixels written by some panel's visible area. */
  covered: number;
  /** Artwork pixels written more than once. */
  doubled: number;
  /** Covered pixels that differ from the unsplit render. */
  differing: number;
}

function reassemble(full: Raster, panels: readonly Panel[], rasters: readonly Raster[]): Reassembly {
  const widthPx = px(ART.widthMm);
  const heightPx = px(ART.heightMm);
  const bleedPx = px(ART_BLEED_MM);
  const writes = new Uint8Array(widthPx * heightPx);
  let differing = 0;

  panels.forEach((panel, i) => {
    const raster = rasters[i];
    const originX = px(panel.printed.x);
    const originY = px(panel.printed.y);
    // Artwork pixel columns and rows (rows counted up from the bottom) in the visible area only.
    for (let ay = px(panel.visible.y); ay < px(panel.visible.y + panel.visible.height); ay++) {
      for (let ax = px(panel.visible.x); ax < px(panel.visible.x + panel.visible.width); ax++) {
        writes[ay * widthPx + ax]++;
        const fromPanel = rgbAt(raster, ax - originX, raster.height - 1 - (ay - originY));
        const fromFull = rgbAt(full, ax + bleedPx, full.height - 1 - (ay + bleedPx));
        if (fromPanel.some((v, c) => v !== fromFull[c])) differing++;
      }
    }
  });

  let covered = 0;
  let doubled = 0;
  for (const n of writes) {
    if (n > 0) covered++;
    if (n > 1) doubled++;
  }
  return { covered, doubled, differing };
}

async function check(spec: TileSpec): Promise<Reassembly> {
  const source = await artworkPdf();
  const result = tile(ART, spec);
  expect(result.ok).toBe(true);
  const [full] = await renderPages(source);
  const rasters = await renderPages(await panelPdf(source, 0, result.panels));
  return reassemble(full, result.panels, rasters);
}

const artworkPixels = px(ART.widthMm) * px(ART.heightMm);

describe("acceptance: virtual reassembly equals the unsplit render", () => {
  it("overlap seams with bleed: pixel diff 0 over the whole visible artwork", async () => {
    const r = await check({ grid: { mode: "count", columns: 3, rows: 2 }, seam: { kind: "overlap", overlapMm: 25 }, bleedMm: 5 });
    expect(r).toEqual({ covered: artworkPixels, doubled: 0, differing: 0 });
  });

  it("individually positioned butt and overlap seams: pixel diff 0", async () => {
    const r = await check({
      grid: { mode: "count", columns: 1, rows: 1 },
      seamsX: [70, 190],
      seamsY: [55],
      seam: { kind: "butt" },
      seamTreatmentsX: [null, { kind: "overlap", overlapMm: 12 }],
    });
    expect(r).toEqual({ covered: artworkPixels, doubled: 0, differing: 0 });
  });
});
