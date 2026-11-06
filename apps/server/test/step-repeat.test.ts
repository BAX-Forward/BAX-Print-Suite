import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFStream } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor, Job, SiteMembership, TilingSetting } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { stepAndRepeat, stepAndRepeatJob, type Contour, type Layout } from '@bax-print/nest';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { panelItemId } from '@bax-print/tile/layout';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import type { SiteMembershipLookup } from '../src/site-scope.js';
import type { StepRepeatBody, StepRepeatRunner } from '../src/step-repeat-routes.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

/** An operator (jobs:write) of the north site only. */
const NORTH_OPERATOR: Actor = { id: 'north-1', role: 'operator' };
const NORTH_ONLY: SiteMembership = { userId: NORTH_OPERATOR.id, siteIds: ['north'] };
const memberships: SiteMembershipLookup = (actor) => (actor.id === NORTH_OPERATOR.id ? NORTH_ONLY : undefined);

/**
 * A one-page PDF written in the test (ISO 32000-1 §7.5): catalog, page tree, one 200 × 100 pt
 * page and its content stream (a filled rectangle), with a cross-reference table. ASCII only,
 * so string offsets are byte offsets.
 */
function onePagePdf(): Uint8Array {
  const content = '0 0 0 rg 10 10 180 80 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << >> /MediaBox [0 0 200 100] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let text = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

/** About 70.6 × 35.3 mm: four columns fit across a 300 mm roll. */
const SOURCE_PDF = onePagePdf();

/**
 * A PDF with one page per entry, each page dictionary carrying the given box entries and sharing one content
 * stream (a filled rectangle), written like `onePagePdf`.
 */
function boxedPdf(pageBoxes: readonly string[]): Uint8Array {
  const content = '0 0 0 rg 10 10 580 380 re f';
  const firstPage = 3;
  const contentRef = firstPage + pageBoxes.length;
  const kids = pageBoxes.map((_boxes, index) => `${String(firstPage + index)} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${String(pageBoxes.length)} >>`,
    ...pageBoxes.map((boxes) => `<< /Type /Page /Parent 2 0 R /Resources << >> ${boxes} /Contents ${String(contentRef)} 0 R >>`),
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
  ];
  let text = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(text.length);
    text += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = text.length;
  text += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  text += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

/** A 600 × 400 pt page: a 3 × 2 butt tiling cuts it into six 200 × 200 pt panels. */
const POSTER_BOXES = '/MediaBox [0 0 600 400]';
const POSTER_PDF = boxedPdf([POSTER_BOXES]);

/** Spec 051b: one copy of each panel on a 300 mm roll (four 200 pt panels fit across). */
const TILED_BODY: StepRepeatBody = {
  copies: 1,
  rollWidthMm: 300,
  marginsMm: { left: 0, right: 0, lead: 0, trail: 0 },
  gapXMm: 0,
  gapYMm: 0,
  rotate: 'none',
  sourceBox: 'trim',
};

const BUTT_3X2: TilingSetting = { grid: { columns: 3, rows: 2 }, seam: { kind: 'butt' } };

/** The panel ids of a 3 × 2 tiling, row 1 the top row. */
const PANEL_IDS = ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3'];

/** The clip boxes of the 3 × 2 butt panels on the poster as `[x0 y0 x1 y1]`, the /BBox of each panel's Form XObject. */
const BUTT_3X2_BBOXES = ['0 0 200 200', '0 200 200 400', '200 0 400 200', '200 200 400 400', '400 0 600 200', '400 200 600 400'];

/** A /BBox as text, rounded to 1/1000 pt (and -0 as 0), so boxes compare after the pt → mm → pt round trip. */
function bboxText(bbox: readonly number[]): string {
  return bbox.map((value) => String(Math.round(value * 1000) / 1000 + 0)).join(' ');
}

/** Spec 050b: a shape tiling does not take, as the job, its sources or the request has it. */
interface UnsupportedTiling {
  readonly tiling?: TilingSetting;
  readonly sources?: readonly Uint8Array[];
  readonly edit?: (job: Job) => Job;
  readonly body?: Partial<StepRepeatBody>;
  /** Part of one issue; tile's own messages are not pinned here. */
  readonly detail?: string;
}

const UNSUPPORTED_TILINGS: readonly (readonly [string, UnsupportedTiling])[] = [
  ['two source files', { sources: [POSTER_PDF, POSTER_PDF], detail: 'exactly one source file' }],
  ['a multi-page source', { sources: [boxedPdf([POSTER_BOXES, POSTER_BOXES])], detail: 'one-page source' }],
  ['a page past the one page', { body: { pageIndex: 1 }, detail: 'not the one page' }],
  ['a non-PDF source', { edit: (job) => ({ ...job, sourceFormat: 'svg' }), detail: 'only a PDF source' }],
  ['ticket edits', { edit: (job) => ({ ...job, ticket: { ...job.ticket, edits: [{ kind: 'rotate', degrees: 90 }] } }), detail: 'ticket edits' }],
  ['an overlap wider than a panel', { tiling: { grid: { columns: 3, rows: 2 }, seam: { kind: 'overlap', overlapMm: 300 } } }],
];

/** The /BBox of every Form XObject in a PDF, and how many image XObjects it has. */
async function xobjects(pdf: Uint8Array): Promise<{ formBBoxes: number[][]; imageCount: number }> {
  const doc = await PDFDocument.load(pdf);
  const formBBoxes: number[][] = [];
  let imageCount = 0;
  const streams = doc.context
    .enumerateIndirectObjects()
    .map(([, object]) => object)
    .filter((object): object is PDFStream => object instanceof PDFStream);
  for (const stream of streams) {
    const subtype = stream.dict.get(PDFName.of('Subtype'));
    if (subtype === PDFName.of('Image')) imageCount += 1;
    if (subtype !== PDFName.of('Form')) continue;
    const bbox = stream.dict.lookup(PDFName.of('BBox'), PDFArray);
    formBBoxes.push(bbox.asArray().map((value) => (value instanceof PDFNumber ? value.asNumber() : Number.NaN)));
  }
  return { formBBoxes, imageCount };
}

const BODY: StepRepeatBody = {
  copies: 6,
  rollWidthMm: 300,
  marginsMm: { left: 0, right: 0, lead: 0, trail: 0 },
  gapXMm: 0,
  gapYMm: 0,
  rotate: 'none',
  sourceBox: 'trim',
};

/** The real job builder behind a placement cap of 4, as `stepAndRepeat` enforces it. */
const cappedRun: StepRepeatRunner = async (opts) => {
  stepAndRepeat({
    item: { id: 'art', widthMm: 70, heightMm: 35 },
    copies: opts.copies,
    rollWidthMm: opts.rollWidthMm,
    marginsMm: opts.marginsMm,
    gapXMm: opts.gapXMm,
    gapYMm: opts.gapYMm,
    maxPlacements: 4,
  });
  return stepAndRepeatJob(opts);
};

interface InjectResponse {
  readonly statusCode: number;
  readonly body: string;
  json<T = unknown>(): T;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
  readonly repository: MemoryJobRepository;
}

interface StepRepeatResult {
  layout: Layout;
  cutContours: Contour[];
  warnings: unknown[];
  imposedPdfBase64: string;
}

/** Spec 050b: tiling settings with each seam, two rows of three panels. */
const TILINGS: readonly (readonly [string, TilingSetting])[] = [
  ['overlap', { grid: { columns: 3, rows: 2 }, seam: { kind: 'overlap', overlapMm: 20 } }],
  ['gap', { grid: { columns: 3, rows: 2 }, seam: { kind: 'gap', gapMm: 10 } }],
  ['butt', { grid: { columns: 3, rows: 2 }, seam: { kind: 'butt' } }],
];

/**
 * A step-repeat answer with only its clock-dependent parts blanked: the layout's `elapsedMs` and the
 * imposed PDF's Info dates (it is written without object streams, so the dates are plain text).
 */
function stableResult(body: StepRepeatResult): unknown {
  const pdf = Buffer.from(body.imposedPdfBase64, 'base64')
    .toString('latin1')
    .replace(/\/(CreationDate|ModDate)\s*\([^)]*\)/g, '/$1 ()');
  return { ...body, layout: { ...body.layout, elapsedMs: 0 }, imposedPdfBase64: pdf };
}

describe('POST /jobs/:id/step-repeat (Spec 003u)', () => {
  let h: Harness | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await h?.app.close();
    h = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  /** A server whose blobs are files in a temp dir, read back by the route as `main.ts` wires it. */
  async function createHarness(run?: StepRepeatRunner, scopedTo?: Actor): Promise<Harness> {
    dataDir = await mkdtemp(join(tmpdir(), 'bps-003u-'));
    const blobsDir = join(dataDir, 'blobs');
    const blobPath = (storageKey: string): string => resolve(blobsDir, ...storageKey.split('/'));
    const time = fakeClock('2026-03-01T08:00:00.000Z');
    const outbox = new MemoryOutbox();
    const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
    const repository = new MemoryJobRepository();
    const blobs = new LocalDirStorage(blobsDir);
    const jobs = new JobService({ jobs: repository, blobs, bus, clock: time.clock, newId: sequentialIds('job') });
    const archive = new ArchiveService({
      jobs: repository,
      index: new MemoryArchiveIndex(),
      blobs,
      archive: new MemoryStorage(),
      bus,
      outbox,
      colorSetups: new StaticColorSetupResolver(),
      clock: time.clock,
      newId: sequentialIds('pkg'),
    });
    const media = new MediaService({ stores: memoryMediaStores(), bus, jobs: repository, clock: time.clock, newId: sequentialIds('m') });
    const app = buildServer({
      archive,
      media,
      jobs: repository,
      stepRepeat: { blobPath, ...(run ? { run } : {}) },
      ...(scopedTo === undefined ? {} : { siteScope: { memberships, jobs: repository }, authenticate: () => scopedTo }),
    });
    return { app, jobs, repository };
  }

  async function createJob(harness: Harness): Promise<string> {
    const job = await harness.jobs.create({ name: 'Sticker', sources: [{ name: 'sticker.pdf', bytes: SOURCE_PDF }], ticket: TICKET });
    return job.id;
  }

  /** Spec 051b: a job of the given source files (default the 600 × 400 pt poster) with a tiling setting. */
  async function createTiledJob(
    harness: Harness,
    tiling: TilingSetting,
    sources: readonly Uint8Array[] = [POSTER_PDF],
    siteId?: string,
  ): Promise<string> {
    const ticket = siteId === undefined ? TICKET : { ...TICKET, siteId };
    const files = sources.map((bytes, index) => ({ name: `poster-${String(index)}.pdf`, bytes }));
    const created = await harness.jobs.create({ name: 'Poster', sources: files, ticket });
    const job = await harness.repository.get(created.id);
    if (job === undefined) throw new Error('job was not stored');
    await harness.repository.save({ ...job, tiling });
    return created.id;
  }

  function postStepRepeat(harness: Harness, jobId: string, body: object = BODY): Promise<InjectResponse> {
    return harness.app.inject({ method: 'POST', url: `/jobs/${jobId}/step-repeat`, payload: body });
  }

  it('lays out the copies with one trim contour per copy and the imposed PDF', async () => {
    h = await createHarness();
    const jobId = await createJob(h);

    const response = await postStepRepeat(h, jobId);

    expect(response.statusCode).toBe(200);
    const body = response.json<StepRepeatResult>();
    expect(body.layout.placements).toHaveLength(BODY.copies);
    expect(body.cutContours).toHaveLength(BODY.copies);
    expect(body.cutContours.map((contour) => contour.id)).toEqual(['copy-0', 'copy-1', 'copy-2', 'copy-3', 'copy-4', 'copy-5']);
    expect(body.cutContours[0]).toMatchObject({ tool: 'kiss', closed: true, source: { kind: 'layer', name: 'trim' } });
    expect(body.cutContours[0]?.areaSigned).toBeCloseTo(200 * 100, 3);
    expect(body.warnings).toEqual([]);
    expect(Buffer.from(body.imposedPdfBase64, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('answers 400 invalid_request for more than MAX_STEP_REPEAT_COPIES copies', async () => {
    h = await createHarness();
    const jobId = await createJob(h);

    const response = await postStepRepeat(h, jobId, { ...BODY, copies: 10_001 });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_request', message: expect.any(String) } });
  });

  it('answers 400 invalid_request for an unknown rotate value', async () => {
    h = await createHarness();
    const jobId = await createJob(h);

    const response = await postStepRepeat(h, jobId, { ...BODY, rotate: 'sideways' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_request', message: expect.any(String) } });
  });

  it('answers 422 invalid_step_repeat when the placements exceed the cap', async () => {
    h = await createHarness(cappedRun);
    const jobId = await createJob(h);

    const response = await postStepRepeat(h, jobId);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: { code: 'invalid_step_repeat', message: expect.stringContaining('exceed the limit of 4') } });
  });

  it('answers 422 invalid_step_repeat when the item is wider than the roll', async () => {
    h = await createHarness();
    const jobId = await createJob(h);

    const response = await postStepRepeat(h, jobId, { ...BODY, rollWidthMm: 50 });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: { code: 'invalid_step_repeat', message: expect.stringContaining('wider than the printable width') } });
  });

  it('answers 404 with the error envelope for an unknown job', async () => {
    h = await createHarness();

    const response = await postStepRepeat(h, 'no-such-job');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Job no-such-job not found' } });
  });

  it('answers 409 when the job has no source file', async () => {
    h = await createHarness();
    const jobId = await createJob(h);
    const job = await h.repository.get(jobId);
    if (!job) throw new Error('job was not stored');
    await h.repository.save({ ...job, sourceFiles: [] });

    const response = await postStepRepeat(h, jobId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'conflict', message: `Job ${jobId} has no source file to step and repeat` } });
  });

  it('answers an untiled job the same after a tiling setting is set and cleared (Spec 050b)', async () => {
    h = await createHarness();
    const jobId = await createJob(h);
    const job = await h.repository.get(jobId);
    if (!job) throw new Error('job was not stored');

    const before = await postStepRepeat(h, jobId);
    await h.repository.save({ ...job, tiling: { grid: { columns: 3, rows: 2 } } });
    await postStepRepeat(h, jobId);
    await h.repository.save(job);
    const after = await postStepRepeat(h, jobId);

    expect(before.statusCode).toBe(200);
    expect(after.statusCode).toBe(200);
    expect(stableResult(after.json<StepRepeatResult>())).toEqual(stableResult(before.json<StepRepeatResult>()));
  });

  it('answers an untiled job with the bytes stepAndRepeatJob builds, its dates blanked (Spec 051b)', async () => {
    h = await createHarness();
    const jobId = await createJob(h);
    const direct = await stepAndRepeatJob({
      sourcePdf: SOURCE_PDF,
      sourceBox: BODY.sourceBox,
      copies: BODY.copies,
      rollWidthMm: BODY.rollWidthMm,
      marginsMm: BODY.marginsMm,
      gapXMm: BODY.gapXMm,
      gapYMm: BODY.gapYMm,
      rotate: BODY.rotate,
    });

    const response = await postStepRepeat(h, jobId);

    expect(response.statusCode).toBe(200);
    const expected: StepRepeatResult = {
      layout: direct.layout,
      cutContours: direct.cutContours,
      warnings: direct.warnings,
      imposedPdfBase64: Buffer.from(direct.imposedPdf).toString('base64'),
    };
    // Through JSON as the route answers, so only the clock-dependent parts may differ.
    const roundTripped = JSON.parse(JSON.stringify(expected)) as StepRepeatResult;
    expect(stableResult(response.json<StepRepeatResult>())).toEqual(stableResult(roundTripped));
    // The untiled page draws the whole page as one Form XObject per copy, no clip boxes.
    const { formBBoxes, imageCount } = await xobjects(Buffer.from(response.json<StepRepeatResult>().imposedPdfBase64, 'base64'));
    expect(imageCount).toBe(0);
    expect(formBBoxes.length).toBeGreaterThan(0);
  });

  it('pins the untiled layout of six 200 x 100 pt copies on a 300 mm roll (Spec 050b)', async () => {
    h = await createHarness();
    const jobId = await createJob(h);

    const { layout } = (await postStepRepeat(h, jobId)).json<StepRepeatResult>();

    expect(layout.mediaWidthPt).toBeCloseTo((300 * 72) / 25.4, 6);
    expect(layout.lengthUsedPt).toBeCloseTo(200, 6);
    expect(layout.unplaced).toEqual([]);
    // Four columns across the roll, then two copies on the second row.
    const corners = layout.placements
      .map((p) => ({ x: Math.round(p.xPt * 1000) / 1000, y: Math.round(p.yPt * 1000) / 1000 }))
      .sort((a, b) => a.x - b.x || a.y - b.y);
    expect(corners).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 400, y: 0 },
      { x: 600, y: 0 },
    ]);
  });

  it.each(TILINGS)('prints a job with a %s seam tiling as six panels, the same way twice (Spec 051b)', async (_name, tiling) => {
    h = await createHarness();
    const jobId = await createTiledJob(h, tiling);

    const first = await postStepRepeat(h, jobId, TILED_BODY);
    const second = await postStepRepeat(h, jobId, TILED_BODY);

    expect(first.statusCode).toBe(200);
    const body = first.json<StepRepeatResult>();
    expect(body.layout.placements).toHaveLength(6);
    expect(body.layout.unplaced).toEqual([]);
    expect(body.cutContours).toHaveLength(6);
    expect(stableResult(second.json<StepRepeatResult>())).toEqual(stableResult(body));
  });

  it('rejects a tiled job before its source is read (Spec 050b)', async () => {
    h = await createHarness();
    const jobId = await createJob(h);
    const job = await h.repository.get(jobId);
    if (!job) throw new Error('job was not stored');
    await h.repository.save({ ...job, sourceFiles: [], tiling: { grid: { columns: 2, rows: 1 } } });

    const response = await postStepRepeat(h, jobId);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'tiling_unsupported' } });
  });

  it('prints a 2 x 3 butt tiling as six Form XObjects clipped to the panels and no images (Spec 051b)', async () => {
    h = await createHarness();
    const jobId = await createTiledJob(h, BUTT_3X2);

    const response = await postStepRepeat(h, jobId, TILED_BODY);

    expect(response.statusCode).toBe(200);
    const body = response.json<StepRepeatResult>();
    // The same answer shape as an untiled step and repeat.
    expect(Object.keys(body).sort()).toEqual(['cutContours', 'imposedPdfBase64', 'layout', 'warnings']);
    expect(body.warnings).toEqual([]);
    expect(body.layout.unplaced).toEqual([]);
    const itemIds = body.layout.placements.map((placement) => placement.itemId).sort();
    expect(itemIds).toEqual(PANEL_IDS.map((panelId) => panelItemId(panelId, jobId)).sort());
    expect(body.cutContours.map((contour) => contour.id)).toEqual(
      body.layout.placements.map((placement) => `${placement.itemId}/copy-${String(placement.copy)}`),
    );
    for (const contour of body.cutContours) {
      expect(contour).toMatchObject({ tool: 'kiss', closed: true, source: { kind: 'layer', name: 'trim' } });
      expect(contour.areaSigned).toBeCloseTo(200 * 200, 3);
    }
    const { formBBoxes, imageCount } = await xobjects(Buffer.from(body.imposedPdfBase64, 'base64'));
    expect(imageCount).toBe(0);
    expect(formBBoxes.map(bboxText).sort()).toEqual(BUTT_3X2_BBOXES);
  });

  it.each(UNSUPPORTED_TILINGS)('answers 422 tiling_unsupported for a tiled job with %s (Spec 050b)', async (_name, shape) => {
    h = await createHarness();
    const jobId = await createTiledJob(h, shape.tiling ?? BUTT_3X2, shape.sources);
    const job = await h.repository.get(jobId);
    if (job === undefined) throw new Error('job was not stored');
    if (shape.edit) await h.repository.save(shape.edit(job));

    const response = await postStepRepeat(h, jobId, { ...TILED_BODY, ...shape.body });

    expect(response.statusCode).toBe(422);
    const detail = shape.detail === undefined ? expect.any(String) : expect.stringContaining(shape.detail);
    expect(response.json()).toEqual({
      error: { code: 'tiling_unsupported', message: `Job ${jobId} can not be tiled`, details: expect.arrayContaining([detail]) },
    });
  });

  it('answers 422 tiling_unsupported with the imposeNestItems issues when a panel lies outside the source box (Spec 051b)', async () => {
    h = await createHarness();
    // The BleedBox covers only the left half of the 600 pt TrimBox, so the right-hand panels lie outside it.
    const jobId = await createTiledJob(h, BUTT_3X2, [boxedPdf(['/MediaBox [0 0 600 400] /BleedBox [0 0 300 400]'])]);

    const response = await postStepRepeat(h, jobId, { ...TILED_BODY, sourceBox: 'bleed' });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: 'tiling_unsupported',
        message: `Job ${jobId}: the tiling panels can not be imposed`,
        details: expect.arrayContaining([expect.stringContaining(`item ${panelItemId('1-3', jobId)}:`)]),
      },
    });
  });

  it('answers a tiled job of another site with the same 404 as a missing job (Spec 051b)', async () => {
    h = await createHarness(undefined, NORTH_OPERATOR);
    const southId = await createTiledJob(h, BUTT_3X2, [POSTER_PDF], 'south');
    const northId = await createTiledJob(h, BUTT_3X2, [POSTER_PDF], 'north');

    const outOfScope = await postStepRepeat(h, southId, TILED_BODY);
    const missing = await postStepRepeat(h, 'no-such-job', TILED_BODY);
    const inScope = await postStepRepeat(h, northId, TILED_BODY);

    expect(outOfScope.statusCode).toBe(404);
    expect(outOfScope.json()).toEqual({ error: { code: 'not_found', message: `Job ${southId} not found` } });
    expect(missing.statusCode).toBe(outOfScope.statusCode);
    expect(missing.json()).toEqual({ error: { code: 'not_found', message: 'Job no-such-job not found' } });
    expect(inScope.statusCode).toBe(200);
  });

  it('documents the route in /openapi.json', async () => {
    h = await createHarness();

    const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();

    const operation = document.paths['/jobs/{id}/step-repeat']?.post;
    expect(operation?.operationId).toBe('stepRepeatJob');
    expect(Object.keys(operation?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '404', '409', '422']));
    expect(document.components.schemas).toHaveProperty('StepRepeatResult');
  });
});
