import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { JobTicket } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import type { Contour } from '@bax-print/plugin-sdk';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { createPdfCutExtractor } from '../src/pdf-cut-extractor.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

type Edits = NonNullable<JobTicket['edits']>;

/**
 * A one-page PDF written in the test (ISO 32000-1 §7.5): catalog, page tree and one page whose
 * dictionary holds `pageEntries`, with a cross-reference table. ASCII only, so string offsets are byte offsets.
 */
function onePagePdf(pageEntries: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /Resources << >> ${pageEntries} >>`,
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

/** A 600 × 400 pt page with a 500 × 300 pt TrimBox. */
const TRIMMED_PAGE = onePagePdf('/MediaBox [0 0 600 400] /TrimBox [50 50 550 350]');

interface InjectResponse {
  readonly statusCode: number;
  json<T = unknown>(): T;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
  readonly repository: MemoryJobRepository;
}

describe('createPdfCutExtractor with POST /jobs/:id/cut-job (Spec 007h)', () => {
  let h: Harness | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await h?.app.close();
    h = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  /** A server whose blobs are files in a temp dir, read back by the real extractor as `main.ts` wires it. */
  async function createHarness(): Promise<Harness> {
    dataDir = await mkdtemp(join(tmpdir(), 'bps-007h-'));
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
    const cutExtractor = createPdfCutExtractor({ blobPath, cut: { spotNames: ['CutContour'] } });
    const app = buildServer({ archive, jobs: repository, cutExtractor });
    return { app, jobs, repository };
  }

  async function createJob(harness: Harness, bytes: Uint8Array, edits?: Edits): Promise<string> {
    const ticket: JobTicket = edits ? { ...TICKET, edits } : TICKET;
    const job = await harness.jobs.create({ name: 'Sticker', sources: [{ name: 'sticker.pdf', bytes }], ticket });
    return job.id;
  }

  function postCutJob(harness: Harness, jobId: string): Promise<InjectResponse> {
    return harness.app.inject({ method: 'POST', url: `/jobs/${jobId}/cut-job` });
  }

  it('plans the trim frame of the stored source PDF with the configured selection', async () => {
    h = await createHarness();
    const jobId = await createJob(h, TRIMMED_PAGE);

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(200);
    // This build has no content-stream contour extraction, so the configured selection yields no contours.
    expect(response.json()).toMatchObject({
      kind: 'job',
      contours: [],
      warnings: [],
      job: { jobId, contours: [], frame: { widthPt: 500, heightPt: 300 } },
    });
  });

  it('cuts the TrimBox of the stored source PDF for a trimBox cutContour edit', async () => {
    h = await createHarness();
    const jobId = await createJob(h, TRIMMED_PAGE, [{ kind: 'cutContour', source: { kind: 'trimBox', offsetMm: 0 } }]);

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ kind: string; contours: Contour[] }>();
    expect(body.kind).toBe('job');
    expect(body.contours).toHaveLength(1);
    const [rect] = body.contours;
    expect(rect?.id).toBe('cut-rect');
    expect(rect?.bbox.minX).toBeCloseTo(0, 6);
    expect(rect?.bbox.minY).toBeCloseTo(0, 6);
    expect(rect?.bbox.maxX).toBeCloseTo(500, 6);
    expect(rect?.bbox.maxY).toBeCloseTo(300, 6);
  });

  it('answers 409 when the job has no source file', async () => {
    h = await createHarness();
    const jobId = await createJob(h, TRIMMED_PAGE);
    const job = await h.repository.get(jobId);
    if (!job) throw new Error('job was not stored');
    await h.repository.save({ ...job, sourceFiles: [] });

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'conflict', message: `Job ${jobId} has no source document with page boxes to cut` } });
  });

  it('answers 422 unreadable_pdf when the source file is not a readable PDF', async () => {
    h = await createHarness();
    const jobId = await createJob(h, new TextEncoder().encode('not a pdf at all'));

    const response = await postCutJob(h, jobId);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: { code: 'unreadable_pdf', message: expect.stringContaining('not a readable PDF') } });
  });
});
