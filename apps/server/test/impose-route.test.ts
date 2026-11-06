import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor, SiteMembership, SourceFormat } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MAX_PROOF_SIDES } from '@bax-print/marks';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { IMPOSE_BODY_LIMIT } from '../src/imposition-routes.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { scopedActor } from '../src/route-permissions.js';
import type { SiteMembershipLookup } from '../src/site-scope.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };
/** A viewer of the north site only. */
const NORTH_VIEWER: Actor = { id: 'north-1', role: 'viewer' };
const NORTH_ONLY: SiteMembership = { userId: NORTH_VIEWER.id, siteIds: ['north'] };
const memberships: SiteMembershipLookup = (actor) => (actor.id === NORTH_VIEWER.id ? NORTH_ONLY : undefined);

const BOOKLET_8 = { pageCount: 8, signaturePages: 8, binding: 'left' };
/** Two rows by three columns of 100 pt cells: 12 pages fill two sheets. */
const N_UP_2X3 = { sheet: { width: 340, height: 230 }, cell: { width: 100, height: 100 }, rows: 2, cols: 3, gutter: 10, margin: 5, pageCount: 12 };

/** A PDF with `count` 200 × 100 pt pages, each with a filled rectangle. */
async function sourcePdf(count: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < count; i++) {
    pdf.addPage([200, 100]).drawRectangle({ x: 10, y: 10, width: 180, height: 80 });
  }
  return pdf.save();
}

/** A one-page PDF with a correct xref table and an /Encrypt dictionary in its trailer. */
function encryptedPdf(): Uint8Array {
  const zeros = '00'.repeat(32);
  const stream = '0 0 100 100 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Filter /Standard /V 1 /R 2 /O <${zeros}> /U <${zeros}> /P -44 >>`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  const rows = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  const size = objects.length + 1;
  body += `xref\n0 ${size}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${size} /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

interface HarnessOptions {
  readonly imposition?: boolean;
  readonly actor?: Actor;
  readonly siteScoped?: boolean;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
  readonly repository: MemoryJobRepository;
}

describe('POST /jobs/:id/impose (Spec 036e)', () => {
  const apps: FastifyInstance[] = [];
  const dataDirs: string[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const dir of dataDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A server whose blobs are files in a temp dir, read back by the route as `main.ts` wires it. */
  async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
    const dataDir = await mkdtemp(join(tmpdir(), 'bps-036e-'));
    dataDirs.push(dataDir);
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
    const { actor, imposition = true, siteScoped = false } = options;
    const app = buildServer({
      archive,
      media,
      jobs: repository,
      proof: { blobPath },
      imposition,
      ...(siteScoped ? { siteScope: { memberships, jobs: repository } } : {}),
      ...(actor ? { authenticate: () => actor } : {}),
    });
    apps.push(app);
    return { app, jobs, repository };
  }

  async function createJob(harness: Harness, bytes: Uint8Array, siteId?: string): Promise<string> {
    const ticket = siteId === undefined ? TICKET : { ...TICKET, siteId };
    const job = await harness.jobs.create({ name: 'Booklet', sources: [{ name: 'booklet.pdf', bytes }], ticket });
    return job.id;
  }

  function impose(harness: Harness, jobId: string, body: unknown) {
    return harness.app.inject({ method: 'POST', url: `/jobs/${jobId}/impose`, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  }

  it.each([
    ['without the flag', undefined],
    ['with the flag off', false],
  ])('is not mounted %s', async (_name, imposition) => {
    const h = await createHarness(imposition === undefined ? { imposition: false } : { imposition });
    const jobId = await createJob(h, await sourcePdf(8));

    const response = await impose(h, jobId, { kind: 'booklet', options: BOOKLET_8 });

    expect(response.statusCode).toBe(404);
  });

  it('answers an 8-page booklet as a PDF attachment with one page per sheet side', async () => {
    const h = await createHarness();
    const jobId = await createJob(h, await sourcePdf(8));

    const response = await impose(h, jobId, { kind: 'booklet', options: BOOKLET_8 });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${jobId}-imposed.pdf"`);
    // Two sheets, front and back.
    expect((await PDFDocument.load(response.rawPayload)).getPageCount()).toBe(4);
  });

  it('answers a 2 x 3 n-up with one page per sheet, with proof marks too', async () => {
    const h = await createHarness();
    const jobId = await createJob(h, await sourcePdf(12));

    const plain = await impose(h, jobId, { kind: 'n-up', options: N_UP_2X3 });
    const marked = await impose(h, jobId, { kind: 'n-up', options: N_UP_2X3, proofMarks: true });

    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-type']).toBe('application/pdf');
    const plainPdf = await PDFDocument.load(plain.rawPayload);
    expect(plainPdf.getPageCount()).toBe(2);
    // Without proof marks the MediaBox is the requested sheet.
    expect(plainPdf.getPage(0).getMediaBox()).toMatchObject({ width: 340, height: 230 });
    expect(marked.statusCode).toBe(200);
    expect((await PDFDocument.load(marked.rawPayload)).getPageCount()).toBe(2);
  });

  it('answers a missing job and a job of another site with the same 404 status and body', async () => {
    const other = await createHarness({ siteScoped: true, actor: NORTH_VIEWER });
    const jobId = await createJob(other, await sourcePdf(8), 'south');
    const scopedMissing = await createHarness({ siteScoped: true, actor: NORTH_VIEWER });
    const unscopedMissing = await createHarness();
    const body = { kind: 'booklet', options: BOOKLET_8 };

    const outOfScope = await impose(other, jobId, body);
    const missingForScoped = await impose(scopedMissing, jobId, body);
    const missing = await impose(unscopedMissing, jobId, body);

    expect(outOfScope.statusCode).toBe(404);
    expect(outOfScope.json()).toEqual({ error: { code: 'not_found', message: `Job ${jobId} not found` } });
    for (const response of [missingForScoped, missing]) {
      expect(response.statusCode).toBe(outOfScope.statusCode);
      expect(response.headers['content-type']).toBe(outOfScope.headers['content-type']);
      expect(response.payload).toBe(outOfScope.payload);
    }
  });

  it('answers a missing job with 404 even when the body is invalid', async () => {
    const h = await createHarness();

    const response = await impose(h, 'no-such-job', { kind: 'gang' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Job no-such-job not found' } });
  });

  it.each<SourceFormat>(['png', 'svg'])('answers 409 job_source_not_pdf for a %s job', async (sourceFormat) => {
    const h = await createHarness();
    const jobId = await createJob(h, await sourcePdf(8));
    const job = await h.repository.get(jobId);
    if (job === undefined) throw new Error('job was not stored');
    await h.repository.save({ ...job, sourceFormat });

    const response = await impose(h, jobId, { kind: 'booklet', options: BOOKLET_8 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'job_source_not_pdf' } });
  });

  it('answers 409 conflict when the job has no source file', async () => {
    const h = await createHarness();
    const jobId = await createJob(h, await sourcePdf(8));
    const job = await h.repository.get(jobId);
    if (job === undefined) throw new Error('job was not stored');
    await h.repository.save({ ...job, sourceFiles: [] });

    const response = await impose(h, jobId, { kind: 'booklet', options: BOOKLET_8 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'conflict', message: `Job ${jobId} has no source file to impose` } });
  });

  it('answers 422 source_pdf_encrypted for an encrypted source', async () => {
    const h = await createHarness();
    const jobId = await createJob(h, encryptedPdf());

    const response = await impose(h, jobId, { kind: 'booklet', options: { pageCount: 1, signaturePages: 4, binding: 'left' } });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'source_pdf_encrypted' } });
  });

  it('answers 400 plan_page_out_of_range when the plan places a page the source lacks', async () => {
    const h = await createHarness();
    const jobId = await createJob(h, await sourcePdf(8));

    const response = await impose(h, jobId, { kind: 'booklet', options: { ...BOOKLET_8, pageCount: 12, signaturePages: 4 } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'plan_page_out_of_range' } });
  });

  it('answers 422 imposition_too_many_sides above the proof side limit', async () => {
    const h = await createHarness();
    const pages = MAX_PROOF_SIDES + 1;
    const jobId = await createJob(h, await sourcePdf(pages));
    const options = { sheet: { width: 100, height: 100 }, cell: { width: 100, height: 100 }, rows: 1, cols: 1, pageCount: pages };

    const response = await impose(h, jobId, { kind: 'n-up', options });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'imposition_too_many_sides' } });
  });

  it(`answers 413 for a body above ${IMPOSE_BODY_LIMIT} bytes`, async () => {
    const h = await createHarness();
    const jobId = await createJob(h, await sourcePdf(8));

    const response = await impose(h, jobId, { kind: 'booklet', options: BOOKLET_8, pad: 'x'.repeat(IMPOSE_BODY_LIMIT) });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it.each([
    ['an unknown field', { kind: 'booklet', options: BOOKLET_8, bleed: 3 }, ['bleed: unknown field']],
    ['an unknown kind', { kind: 'gang', options: BOOKLET_8 }, ['kind: must be one of "n-up", "booklet"']],
    ['a string proofMarks', { kind: 'booklet', options: BOOKLET_8, proofMarks: 'yes' }, ['proofMarks: must be a boolean']],
    ['missing options', { kind: 'booklet' }, ['options: must be a JSON object']],
    ['an unknown option field', { kind: 'booklet', options: { ...BOOKLET_8, cover: true } }, ['options.cover: unknown field']],
    ['n-up options for a booklet', { kind: 'booklet', options: N_UP_2X3 }, expect.arrayContaining(['options.sheet: unknown field'])],
  ])('answers 400 invalid_request with the issues for %s', async (_name, body, details) => {
    const h = await createHarness();
    const jobId = await createJob(h, await sourcePdf(8));

    const response = await impose(h, jobId, body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request', details } });
  });

  it('answers 400 invalid_imposition_input when the planner rejects a value', async () => {
    const h = await createHarness();
    const jobId = await createJob(h, await sourcePdf(8));

    const response = await impose(h, jobId, { kind: 'booklet', options: { ...BOOKLET_8, pageCount: 0 } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_imposition_input', message: 'planBooklet: pageCount must be at least 1, got 0' } });
  });

  it('allows a viewer, whose role holds jobs:read', async () => {
    const h = await createHarness({ actor: VIEWER });
    const jobId = await createJob(h, await sourcePdf(8));

    expect((await impose(h, jobId, { kind: 'booklet', options: BOOKLET_8 })).statusCode).toBe(200);
  });

  it('denies an API token without jobs:read with 403 before the job is looked up', async () => {
    const h = await createHarness({ actor: scopedActor(VIEWER, ['reports:read']) });

    const response = await impose(h, 'no-such-job', { kind: 'booklet', options: BOOKLET_8 });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:read' } } });
  });

  it('documents the route and its request schema in /openapi.json', async () => {
    const h = await createHarness();

    const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();

    const operation = document.paths['/jobs/{id}/impose']?.post;
    expect(operation?.operationId).toBe('imposeJob');
    expect(Object.keys(operation?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '403', '404', '409', '413', '422']));
    expect(Object.keys(document.components.schemas)).toContain('ImposeRequest');
  });
});
