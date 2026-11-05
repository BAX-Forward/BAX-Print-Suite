import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

const PAGE_COUNT = 3;

/** A PDF with `PAGE_COUNT` 200 × 100 pt pages, each with a filled rectangle. */
async function sourcePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < PAGE_COUNT; i++) {
    pdf.addPage([200, 100]).drawRectangle({ x: 10, y: 10, width: 180, height: 80 });
  }
  return pdf.save();
}

interface Harness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
  readonly repository: MemoryJobRepository;
}

describe('POST /jobs/:id/proof (Spec 004a)', () => {
  let h: Harness | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await h?.app.close();
    h = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  /** A server whose blobs are files in a temp dir, read back by the route as `main.ts` wires it. */
  async function createHarness(): Promise<Harness> {
    dataDir = await mkdtemp(join(tmpdir(), 'bps-004a-'));
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
    const app = buildServer({ archive, media, jobs: repository, proof: { blobPath } });
    return { app, jobs, repository };
  }

  async function createJob(harness: Harness): Promise<string> {
    const job = await harness.jobs.create({ name: 'Poster', sources: [{ name: 'poster.pdf', bytes: await sourcePdf() }], ticket: TICKET });
    return job.id;
  }

  function postProof(harness: Harness, jobId: string, body: object = {}) {
    return harness.app.inject({ method: 'POST', url: `/jobs/${jobId}/proof`, payload: body });
  }

  it('answers the watermarked PDF with the same page count', async () => {
    h = await createHarness();
    const jobId = await createJob(h);

    const response = await postProof(h, jobId, { text: 'DRAFT', opacity: 0.4 });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    const proof = await PDFDocument.load(response.rawPayload);
    expect(proof.getPageCount()).toBe(PAGE_COUNT);
  });

  it('answers 422 proof_watermark_invalid with the issues for invalid options', async () => {
    h = await createHarness();
    const jobId = await createJob(h);

    const response = await postProof(h, jobId, { opacity: 2 });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: { code: 'proof_watermark_invalid', message: expect.any(String), details: [expect.stringContaining('opacity')] },
    });
  });

  it('answers 404 with the error envelope for an unknown job', async () => {
    h = await createHarness();

    const response = await postProof(h, 'no-such-job');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Job no-such-job not found' } });
  });

  it('answers 409 when the job has no source file', async () => {
    h = await createHarness();
    const jobId = await createJob(h);
    const job = await h.repository.get(jobId);
    if (!job) throw new Error('job was not stored');
    await h.repository.save({ ...job, sourceFiles: [] });

    const response = await postProof(h, jobId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'conflict', message: `Job ${jobId} has no source file to proof` } });
  });

  it('documents the route in /openapi.json', async () => {
    h = await createHarness();

    const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
    }>();

    const operation = document.paths['/jobs/{id}/proof']?.post;
    expect(operation?.operationId).toBe('proofJob');
    expect(Object.keys(operation?.responses ?? {})).toEqual(expect.arrayContaining(['200', '404', '409', '422']));
  });
});
