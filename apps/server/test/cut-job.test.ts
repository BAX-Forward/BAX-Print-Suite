import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { JobTicket } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import type { Contour } from '@bax-print/plugin-sdk';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import type { CutExtractor } from '../src/cut-routes.js';
import type { CutPlanDeps } from '../src/cut-service.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

type Edits = NonNullable<JobTicket['edits']>;
type Selection = Parameters<CutPlanDeps['extract']>[0];

/** A 600 × 400 pt page with no TrimBox or CropBox, so the trim frame is the MediaBox. */
const PAGE_BOXES: CutPlanDeps['pageBoxes'] = { mediaBox: { x0: 0, y0: 0, x1: 600, y1: 400 } };

/** One closed square contour painted in `name`, as the extraction stage would return it. */
function spotContour(name: string): Contour {
  return {
    id: `spot-${name}`,
    tool: 'kiss',
    source: { kind: 'spot', name },
    closed: true,
    points: [
      [10, 10],
      [110, 10],
      [110, 110],
      [10, 110],
      [10, 10],
    ],
    bbox: { minX: 10, minY: 10, maxX: 110, maxY: 110 },
    areaSigned: 10_000,
  };
}

interface FakeExtractor {
  readonly extractor: CutExtractor;
  /** Selections the extraction stage was called with, in order. */
  readonly selections: Selection[];
}

/** Fake extraction stage: every selected spot name yields one contour. No PDF is read. */
function fakeExtractor(pageBoxes: CutPlanDeps['pageBoxes'] = PAGE_BOXES): FakeExtractor {
  const selections: Selection[] = [];
  const extractor: CutExtractor = async () => ({
    pageBoxes,
    frame: { widthPt: 600, heightPt: 400 },
    toolMap: {},
    cut: { spotNames: ['CutContour'] },
    extract: (selection) => {
      selections.push(selection);
      return (selection.spotNames ?? []).map(spotContour);
    },
  });
  return { extractor, selections };
}

/** A job whose source document has no readable page. */
const noPageExtractor: CutExtractor = async () => undefined;

interface InjectResponse {
  readonly statusCode: number;
  json<T = unknown>(): T;
}

interface CutHarness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
}

function createCutHarness(cutExtractor?: CutExtractor): CutHarness {
  const time = fakeClock('2026-03-01T08:00:00.000Z');
  const outbox = new MemoryOutbox();
  const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
  const repository = new MemoryJobRepository();
  const blobs = new MemoryStorage();
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
  const app = buildServer({ archive, media, jobs: repository, ...(cutExtractor ? { cutExtractor } : {}) });
  return { app, jobs };
}

async function createJob(h: CutHarness, edits?: Edits): Promise<string> {
  const ticket: JobTicket = edits ? { ...TICKET, edits } : TICKET;
  const job = await h.jobs.create({ name: 'Sticker', sources: [{ name: 'sticker.pdf', bytes: Buffer.from('%PDF-1.7 sticker') }], ticket });
  return job.id;
}

function postCutJob(h: CutHarness, jobId: string): Promise<InjectResponse> {
  return h.app.inject({ method: 'POST', url: `/jobs/${jobId}/cut-job` });
}

describe('POST /jobs/:id/cut-job (Spec 007g)', () => {
  let h: CutHarness | undefined;

  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('extracts with the configured selection when the job has no cutContour edit', async () => {
    const fake = fakeExtractor();
    h = createCutHarness(fake.extractor);
    const jobId = await createJob(h);

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(200);
    expect(fake.selections).toEqual([{ spotNames: ['CutContour'] }]);
    const body = response.json<{ kind: string; contours: Contour[]; warnings: unknown[]; job: { jobId: string; contours: Contour[] } }>();
    expect(body).toMatchObject({ kind: 'job', contours: [spotContour('CutContour')], warnings: [] });
    expect(body.job).toMatchObject({ jobId, contours: body.contours, frame: { widthPt: 600, heightPt: 400 }, options: {} });
  });

  it('extracts exactly the spot names of a spot cutContour edit', async () => {
    const fake = fakeExtractor();
    h = createCutHarness(fake.extractor);
    const jobId = await createJob(h, [{ kind: 'cutContour', source: { kind: 'spot', names: ['Thru', 'Kiss'] } }]);

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(200);
    expect(fake.selections).toEqual([{ spotNames: ['Thru', 'Kiss'], layerNames: [] }]);
    expect(response.json()).toMatchObject({ kind: 'job', contours: [spotContour('Thru'), spotContour('Kiss')], warnings: [] });
  });

  it('cuts one rectangle on the trim box without extracting', async () => {
    const fake = fakeExtractor();
    h = createCutHarness(fake.extractor);
    const jobId = await createJob(h, [{ kind: 'cutContour', source: { kind: 'trimBox', offsetMm: 0 } }]);

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(200);
    expect(fake.selections).toEqual([]);
    const body = response.json<{ kind: string; contours: Contour[]; warnings: unknown[] }>();
    expect(body.kind).toBe('job');
    expect(body.warnings).toEqual([]);
    expect(body.contours).toHaveLength(1);
    const [rect] = body.contours;
    expect(rect).toMatchObject({ id: 'cut-rect', tool: 'kiss', closed: true });
    expect(rect?.areaSigned).toBeCloseTo(600 * 400, 3);
    expect(rect?.bbox.minX).toBeCloseTo(0, 6);
    expect(rect?.bbox.minY).toBeCloseTo(0, 6);
    expect(rect?.bbox.maxX).toBeCloseTo(600, 6);
    expect(rect?.bbox.maxY).toBeCloseTo(400, 6);
  });

  it('answers kind none when the edits say the job is not cut', async () => {
    const fake = fakeExtractor();
    h = createCutHarness(fake.extractor);
    const jobId = await createJob(h, [{ kind: 'cutContour', source: { kind: 'none' } }]);

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'none' });
    expect(fake.selections).toEqual([]);
  });

  it('warns when every spot name of the cutContour edit was mapped to process', async () => {
    const fake = fakeExtractor();
    h = createCutHarness(fake.extractor);
    const jobId = await createJob(h, [
      { kind: 'cutContour', source: { kind: 'spot', names: ['Thru'] } },
      { kind: 'spotMap', from: 'Thru', to: { kind: 'process' } },
    ]);

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(200);
    expect(fake.selections).toEqual([]);
    expect(response.json()).toMatchObject({
      kind: 'job',
      contours: [],
      warnings: [{ severity: 'warning', code: 'no-cut-contours', path: 'edits.cutContour.source.names' }],
      job: { jobId, contours: [] },
    });
  });

  it('answers 404 with the error envelope for an unknown job', async () => {
    h = createCutHarness(fakeExtractor().extractor);

    const response = await postCutJob(h, 'no-such-job');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Job no-such-job not found' } });
  });

  it('answers 409 when the job has no source document with page boxes', async () => {
    h = createCutHarness(noPageExtractor);
    const jobId = await createJob(h);

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'conflict', message: `Job ${jobId} has no source document with page boxes to cut` } });
  });

  it('answers 501 cut_extractor_not_configured without a cut extractor', async () => {
    h = createCutHarness();
    const jobId = await createJob(h);

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({ error: { code: 'cut_extractor_not_configured', message: expect.any(String) } });
  });

  it('answers 422 when an inward trim-box offset leaves no cut area', async () => {
    // A 40 pt (≈ 14 mm) square page: 10 mm inward on each side leaves nothing.
    h = createCutHarness(fakeExtractor({ mediaBox: { x0: 0, y0: 0, x1: 40, y1: 40 } }).extractor);
    const jobId = await createJob(h, [{ kind: 'cutContour', source: { kind: 'trimBox', offsetMm: -10 } }]);

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: { code: 'invalid_cut_contour', message: expect.stringContaining('inward offset') } });
  });

  it('documents the route in /openapi.json', async () => {
    h = createCutHarness(fakeExtractor().extractor);

    const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();

    const operation = document.paths['/jobs/{id}/cut-job']?.post;
    expect(operation?.operationId).toBe('planCutJob');
    expect(Object.keys(operation?.responses ?? {})).toEqual(expect.arrayContaining(['200', '404', '409', '501']));
    expect(document.components.schemas).toHaveProperty('CutJobResult');
  });
});

describe('buildServer without jobs', () => {
  it('does not mount the cut-job route', async () => {
    const outbox = new MemoryOutbox();
    const archive = new ArchiveService({
      jobs: new MemoryJobRepository(),
      index: new MemoryArchiveIndex(),
      blobs: new MemoryStorage(),
      archive: new MemoryStorage(),
      bus: new EventBus(outbox),
      outbox,
      colorSetups: new StaticColorSetupResolver(),
    });
    const app = buildServer({ archive });

    expect((await app.inject({ method: 'POST', url: '/jobs/any/cut-job' })).statusCode).toBe(404);
    await app.close();
  });
});
