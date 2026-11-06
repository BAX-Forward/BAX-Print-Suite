import { describe, expect, it } from 'vitest';
import type { Job, JobTicket, TilingSetting } from '@bax-print/core';
import { DEFAULT_OVERLAP_MM, mmToPt, panelItemId, ptToMm, tile, toNestItems, type PanelNestItem } from '@bax-print/tile/layout';
import { errorResponse, HttpError } from '../src/errors.js';
import {
  jobTilingNestItems,
  rejectTiledJob,
  requireJobTilingNestItems,
  tilingToTileSpec,
  type JobTilingSource,
  type TiledJob,
} from '../src/job-tiling.js';

const JOB_ID = 'job-0001';
const TICKET: JobTicket = { intent: { quantity: 1 }, process: {} };
/** A 600 × 400 mm page whose TrimBox starts at (10, 20) pt. */
const WIDTH_MM = 600;
const HEIGHT_MM = 400;
const SOURCE: JobTilingSource = {
  pageCount: 1,
  pageIndex: 0,
  trimBoxPt: { x: 10, y: 20, widthPt: mmToPt(WIDTH_MM), heightPt: mmToPt(HEIGHT_MM) },
};
/** Two rows of three columns. */
const GRID = { columns: 3, rows: 2 };
const OVERLAP: TilingSetting = { grid: GRID, seam: { kind: 'overlap', overlapMm: 20 } };

const SOURCE_FILE = { name: 'banner.pdf', sha256: 'a'.repeat(64), sizeBytes: 100, storageKey: `jobs/${JOB_ID}/sources/0-banner.pdf` };

function tiledJob(tiling: TilingSetting | undefined, fields: Partial<TiledJob> = {}): TiledJob {
  return { id: JOB_ID, ticket: TICKET, sourceFiles: [SOURCE_FILE], sourceFormat: 'pdf', ...(tiling ? { tiling } : {}), ...fields };
}

function itemsOf(tiling: TilingSetting, source: JobTilingSource = SOURCE): PanelNestItem[] {
  const result = jobTilingNestItems(tiledJob(tiling), source);
  if (result.ok) return result.items;
  throw new Error(`expected panel items, got issues: ${result.issues.join('; ')}`);
}

function issuesOf(job: TiledJob, source: JobTilingSource = SOURCE): string[] {
  const result = jobTilingNestItems(job, source);
  if (result.ok) throw new Error('expected issues, got panel items');
  return result.issues;
}

/** The clip box of a printed area in mm on the artwork, in the source page's user space. */
function clipBox(xMm: number, yMm: number, widthMm: number, heightMm: number) {
  return { x: 10 + mmToPt(xMm), y: 20 + mmToPt(yMm), width: mmToPt(widthMm), height: mmToPt(heightMm) };
}

function expectBox(actual: PanelNestItem['clipBox'] | undefined, expected: ReturnType<typeof clipBox>): void {
  expect(actual?.x).toBeCloseTo(expected.x, 6);
  expect(actual?.y).toBeCloseTo(expected.y, 6);
  expect(actual?.width).toBeCloseTo(expected.width, 6);
  expect(actual?.height).toBeCloseTo(expected.height, 6);
}

describe('tilingToTileSpec (Spec 050b)', () => {
  it('maps the grid to a count grid and the page to mm', () => {
    const { page, spec } = tilingToTileSpec({ grid: GRID }, { widthPt: mmToPt(WIDTH_MM), heightPt: mmToPt(HEIGHT_MM) });

    expect(spec).toEqual({ grid: { mode: 'count', columns: 3, rows: 2 } });
    expect(page.widthMm).toBeCloseTo(WIDTH_MM, 9);
    expect(page.heightMm).toBeCloseTo(HEIGHT_MM, 9);
  });

  it.each([
    ['butt', { kind: 'butt' }, { kind: 'butt' }],
    ['gap', { kind: 'gap', gapMm: 10 }, { kind: 'gap', gapMm: 10 }],
    ['overlap with a width', { kind: 'overlap', overlapMm: 20 }, { kind: 'overlap', overlapMm: 20 }],
    ['overlap without a width', { kind: 'overlap' }, { kind: 'overlap' }],
  ] as const)('maps a %s seam to the same seam treatment', (_name, seam, treatment) => {
    const { spec } = tilingToTileSpec({ grid: GRID, seam }, { widthPt: 100, heightPt: 100 });

    expect(spec.seam).toEqual(treatment);
  });
});

describe('jobTilingNestItems (Spec 050b)', () => {
  it('splits a 2 x 3 overlap tiling into 6 panel items with tile ids and clip boxes', () => {
    const items = itemsOf(OVERLAP);

    expect(items.map((item) => item.id)).toEqual(
      ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3'].map((panelId) => panelItemId(panelId, JOB_ID)),
    );
    expect(items.map((item) => item.panel.label)).toEqual(['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
    for (const item of items) {
      expect(item).toMatchObject({ jobId: JOB_ID, pageIndex: 0, quantity: 1, rotation: 'none', lock: { orientation: 0 } });
      expect(item.widthPt).toBe(item.clipBox.width);
      expect(item.heightPt).toBe(item.clipBox.height);
    }
    // Seams at 200 and 400 mm across and 200 mm up; each side prints 20 mm past a seam. Row 1 is the top row.
    expectBox(items[0]?.clipBox, clipBox(0, 180, 220, 220));
    expectBox(items[1]?.clipBox, clipBox(180, 180, 240, 220));
    expectBox(items[2]?.clipBox, clipBox(380, 180, 220, 220));
    expectBox(items[3]?.clipBox, clipBox(0, 0, 220, 220));
    expectBox(items[4]?.clipBox, clipBox(180, 0, 240, 220));
    expectBox(items[5]?.clipBox, clipBox(380, 0, 220, 220));
  });

  it('meets butt seam panels exactly at the seam', () => {
    const items = itemsOf({ grid: GRID, seam: { kind: 'butt' } });

    expect(items).toHaveLength(6);
    expectBox(items[0]?.clipBox, clipBox(0, 200, 200, 200));
    expectBox(items[1]?.clipBox, clipBox(200, 200, 200, 200));
    expectBox(items[5]?.clipBox, clipBox(400, 0, 200, 200));
  });

  it('leaves a gap seam strip unprinted, half on each side of the seam', () => {
    const items = itemsOf({ grid: GRID, seam: { kind: 'gap', gapMm: 10 } });

    expect(items).toHaveLength(6);
    expectBox(items[0]?.clipBox, clipBox(0, 205, 195, 195));
    expectBox(items[1]?.clipBox, clipBox(205, 205, 190, 195));
    expectBox(items[5]?.clipBox, clipBox(405, 0, 195, 195));
  });

  it("uses tile's default overlap without a seam or an overlap width", () => {
    const expected = clipBox(0, 200 - DEFAULT_OVERLAP_MM, 200 + DEFAULT_OVERLAP_MM, 200 + DEFAULT_OVERLAP_MM);

    expectBox(itemsOf({ grid: GRID })[0]?.clipBox, expected);
    expectBox(itemsOf({ grid: GRID, seam: { kind: 'overlap' } })[0]?.clipBox, expected);
  });

  it('is deterministic', () => {
    expect(itemsOf(OVERLAP)).toEqual(itemsOf(OVERLAP));
    expect(JSON.stringify(itemsOf(OVERLAP))).toBe(JSON.stringify(itemsOf(OVERLAP)));
  });

  it("answers tile's issue messages when tile rejects the setting for the page", () => {
    const tiling: TilingSetting = { grid: GRID, seam: { kind: 'overlap', overlapMm: 300 } };
    const { page, spec } = tilingToTileSpec(tiling, SOURCE.trimBoxPt);
    const expected = tile(page, spec).issues.map((issue) => issue.message);

    const issues = issuesOf(tiledJob(tiling));

    expect(expected.length).toBeGreaterThan(0);
    expect(issues).toEqual(expected);
  });

  it.each([
    ['a multi-page source', tiledJob(OVERLAP), { ...SOURCE, pageCount: 3 }, 'one-page source'],
    ['a page past the one page', tiledJob(OVERLAP), { ...SOURCE, pageIndex: 1 }, 'not the one page'],
    ['a source without pages', tiledJob(OVERLAP), { ...SOURCE, pageCount: 0 }, 'not the one page'],
    ['a non-PDF source', tiledJob(OVERLAP, { sourceFormat: 'svg' }), SOURCE, 'only a PDF source'],
    ['two source files', tiledJob(OVERLAP, { sourceFiles: [SOURCE_FILE, SOURCE_FILE] }), SOURCE, 'exactly one source file'],
    ['no source file', tiledJob(OVERLAP, { sourceFiles: [] }), SOURCE, 'exactly one source file'],
    ['ticket edits', tiledJob(OVERLAP, { ticket: { ...TICKET, edits: [{ kind: 'rotate', degrees: 90 }] } }), SOURCE, 'ticket edits'],
    ['a non-finite TrimBox origin', tiledJob(OVERLAP), { ...SOURCE, trimBoxPt: { ...SOURCE.trimBoxPt, x: Number.NaN } }, 'finite'],
    ['no tiling setting', tiledJob(undefined), SOURCE, 'no tiling setting'],
  ] as const)('rejects %s with an issue', (_name, job, source, text) => {
    expect(issuesOf(job, source)).toEqual([expect.stringContaining(text)]);
  });

  it('names every shape issue at once', () => {
    const job = tiledJob(OVERLAP, { sourceFormat: 'png', ticket: { ...TICKET, edits: [{ kind: 'mirror' }] } });

    expect(issuesOf(job, { ...SOURCE, pageCount: 2 })).toHaveLength(3);
  });
});

describe('requireJobTilingNestItems (Spec 050b)', () => {
  it('answers the panel items of a tiled job', () => {
    expect(requireJobTilingNestItems(tiledJob(OVERLAP), SOURCE)).toEqual(itemsOf(OVERLAP));
  });

  it('throws 422 tiling_unsupported with the issues in details', () => {
    const job = tiledJob(OVERLAP);
    const source = { ...SOURCE, pageCount: 2 };
    let thrown: unknown;
    try {
      requireJobTilingNestItems(job, source);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpError);
    expect(errorResponse(thrown)).toEqual({
      statusCode: 422,
      body: { error: { code: 'tiling_unsupported', message: `Job ${JOB_ID} can not be tiled`, details: issuesOf(job, source) } },
    });
  });
});

/** A 600 × 400 pt poster whose TrimBox starts at (10, 20) pt. */
const POSTER: JobTilingSource = { pageCount: 1, pageIndex: 0, trimBoxPt: { x: 10, y: 20, widthPt: 600, heightPt: 400 } };
const BUTT = { kind: 'butt' } as const;
/** Two rows of three columns, butt seams at 50 and 120 mm across and 40 mm up. */
const UNEVEN: TilingSetting = { grid: GRID, seam: BUTT, seamsX: [50, 120], seamsY: [40] };
/** The uneven seams in pt from the TrimBox's left and bottom edge. */
const SEAM_X1_PT = mmToPt(50);
const SEAM_X2_PT = mmToPt(120);
const SEAM_Y1_PT = mmToPt(40);

/** A clip box from its corners in pt on the poster's TrimBox, in the source page's user space. */
function posterBox(x0Pt: number, y0Pt: number, x1Pt: number, y1Pt: number) {
  return { x: 10 + x0Pt, y: 20 + y0Pt, width: x1Pt - x0Pt, height: y1Pt - y0Pt };
}

describe('explicit seams (Spec 050d)', () => {
  it('passes seamsX and seamsY to the tile spec unchanged', () => {
    const { spec } = tilingToTileSpec(UNEVEN, POSTER.trimBoxPt);

    expect(spec).toStrictEqual({ grid: { mode: 'count', columns: 3, rows: 2 }, seamsX: [50, 120], seamsY: [40], seam: BUTT });
  });

  it('cuts 2 x 3 panels whose clip boxes follow uneven seams exactly', () => {
    const items = itemsOf(UNEVEN, POSTER);

    expect(SEAM_X1_PT).toBeCloseTo(141.732283, 6);
    expect(SEAM_X2_PT).toBeCloseTo(340.15748, 5);
    expect(SEAM_Y1_PT).toBeCloseTo(113.385827, 6);
    expect(items.map((item) => item.panel.label)).toEqual(['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
    // Row 1 (A) is the top row, above the 40 mm seam.
    expectBox(items[0]?.clipBox, posterBox(0, SEAM_Y1_PT, SEAM_X1_PT, 400));
    expectBox(items[1]?.clipBox, posterBox(SEAM_X1_PT, SEAM_Y1_PT, SEAM_X2_PT, 400));
    expectBox(items[2]?.clipBox, posterBox(SEAM_X2_PT, SEAM_Y1_PT, 600, 400));
    expectBox(items[3]?.clipBox, posterBox(0, 0, SEAM_X1_PT, SEAM_Y1_PT));
    expectBox(items[4]?.clipBox, posterBox(SEAM_X1_PT, 0, SEAM_X2_PT, SEAM_Y1_PT));
    expectBox(items[5]?.clipBox, posterBox(SEAM_X2_PT, 0, 600, SEAM_Y1_PT));
  });

  it('takes seams on the x axis only and splits y evenly', () => {
    const tiling: TilingSetting = { grid: GRID, seam: BUTT, seamsX: [50, 120] };
    const items = itemsOf(tiling, POSTER);

    expect(tilingToTileSpec(tiling, POSTER.trimBoxPt).spec).toStrictEqual({
      grid: { mode: 'count', columns: 3, rows: 2 },
      seamsX: [50, 120],
      seam: BUTT,
    });
    expect(items).toHaveLength(6);
    expectBox(items[0]?.clipBox, posterBox(0, 200, SEAM_X1_PT, 400));
    expectBox(items[1]?.clipBox, posterBox(SEAM_X1_PT, 200, SEAM_X2_PT, 400));
    expectBox(items[5]?.clipBox, posterBox(SEAM_X2_PT, 0, 600, 200));
  });

  it('takes seams on the y axis only and splits x evenly', () => {
    const tiling: TilingSetting = { grid: GRID, seam: BUTT, seamsY: [40] };
    const items = itemsOf(tiling, POSTER);

    expect(tilingToTileSpec(tiling, POSTER.trimBoxPt).spec).toStrictEqual({
      grid: { mode: 'count', columns: 3, rows: 2 },
      seamsY: [40],
      seam: BUTT,
    });
    expect(items).toHaveLength(6);
    expectBox(items[0]?.clipBox, posterBox(0, SEAM_Y1_PT, 200, 400));
    expectBox(items[4]?.clipBox, posterBox(200, 0, 400, SEAM_Y1_PT));
    expectBox(items[5]?.clipBox, posterBox(400, 0, 600, SEAM_Y1_PT));
  });

  it.each([
    ['without a seam', { grid: GRID }, { grid: { mode: 'count', columns: 3, rows: 2 } }],
    ['with an overlap seam', OVERLAP, { grid: { mode: 'count', columns: 3, rows: 2 }, seam: { kind: 'overlap', overlapMm: 20 } }],
    ['with a butt seam', { grid: GRID, seam: BUTT }, { grid: { mode: 'count', columns: 3, rows: 2 }, seam: BUTT }],
  ] as const)('keeps the spec and nest items of a tiling without seam positions %s', (_name, tiling, expectedSpec) => {
    const { page, spec } = tilingToTileSpec(tiling, POSTER.trimBoxPt);
    const panels = tile(page, expectedSpec).panels;
    const expectedItems = toNestItems(panels, { jobId: JOB_ID, pageIndex: 0, trimOriginPt: { x: 10, y: 20 } });

    expect(spec).toStrictEqual(expectedSpec);
    expect(itemsOf(tiling, POSTER)).toStrictEqual(expectedItems);
  });

  it.each([
    ['a seamsX entry at the right edge', { grid: GRID, seamsX: [50, ptToMm(600)] }, 'seamsX[1]'],
    ['a seamsX entry beyond the right edge', { grid: GRID, seamsX: [50, 250] }, 'seamsX[1]'],
    ['a seamsX entry at the left edge', { grid: GRID, seamsX: [0, 120] }, 'seamsX[0]'],
    ['a seamsY entry at the top edge', { grid: GRID, seamsY: [ptToMm(400)] }, 'seamsY[0]'],
    ['a seamsY entry beyond the top edge', { grid: GRID, seamsY: [150] }, 'seamsY[0]'],
  ] as const)('rejects %s with an issue', (_name, tiling, text) => {
    const issues = issuesOf(tiledJob(tiling), POSTER);

    expect(issues).toEqual([expect.stringContaining(`${text} at `)]);
    expect(issues[0]).toContain('is not inside the artwork');
  });

  it('names every seam outside the artwork on both axes', () => {
    const issues = issuesOf(tiledJob({ grid: GRID, seamsX: [250, 300], seamsY: [400] }), POSTER);

    expect(issues).toHaveLength(3);
    expect(issues[0]).toContain('TrimBox width of 211.667 mm');
    expect(issues[2]).toContain('TrimBox height of 141.111 mm');
  });

  it("answers tile's issue messages when tile rejects the uneven seams", () => {
    // An overlap of 60 mm is wider than the 50 mm first column.
    const tiling: TilingSetting = { ...UNEVEN, seam: { kind: 'overlap', overlapMm: 60 } };
    const { page, spec } = tilingToTileSpec(tiling, POSTER.trimBoxPt);
    const expected = tile(page, spec).issues.map((issue) => issue.message);

    expect(expected.length).toBeGreaterThan(0);
    expect(issuesOf(tiledJob(tiling), POSTER)).toEqual(expected);
  });

  it('throws 422 tiling_unsupported for a seam outside the artwork', () => {
    const job = tiledJob({ ...UNEVEN, seamsY: [200] });
    let thrown: unknown;
    try {
      requireJobTilingNestItems(job, POSTER);
    } catch (error) {
      thrown = error;
    }

    expect(errorResponse(thrown)).toEqual({
      statusCode: 422,
      body: { error: { code: 'tiling_unsupported', message: `Job ${JOB_ID} can not be tiled`, details: issuesOf(job, POSTER) } },
    });
  });
});

describe('rejectTiledJob (Spec 050b)', () => {
  it('passes a job without tiling', () => {
    const job: Pick<Job, 'id' | 'tiling'> = { id: JOB_ID };

    expect(() => rejectTiledJob(job, 'step and repeat')).not.toThrow();
  });

  it('throws 422 tiling_unsupported for a tiled job', () => {
    let thrown: unknown;
    try {
      rejectTiledJob({ id: JOB_ID, tiling: OVERLAP }, 'step and repeat');
    } catch (error) {
      thrown = error;
    }

    expect(errorResponse(thrown)).toEqual({
      statusCode: 422,
      body: {
        error: {
          code: 'tiling_unsupported',
          message: `Job ${JOB_ID} is tiled; step and repeat can not lay out tiling panels`,
          details: [expect.stringContaining(`DELETE /jobs/${JOB_ID}/tiling`)],
        },
      },
    });
  });
});
