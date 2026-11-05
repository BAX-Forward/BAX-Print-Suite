import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { stepAndRepeat, stepAndRepeatJob, type Contour, type Layout } from '@bax-print/nest';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import type { StepRepeatBody, StepRepeatRunner } from '../src/step-repeat-routes.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

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
  async function createHarness(run?: StepRepeatRunner): Promise<Harness> {
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
    const app = buildServer({ archive, media, jobs: repository, stepRepeat: { blobPath, ...(run ? { run } : {}) } });
    return { app, jobs, repository };
  }

  async function createJob(harness: Harness): Promise<string> {
    const job = await harness.jobs.create({ name: 'Sticker', sources: [{ name: 'sticker.pdf', bytes: SOURCE_PDF }], ticket: TICKET });
    return job.id;
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
