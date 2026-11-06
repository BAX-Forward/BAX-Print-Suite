import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { SCREENING_ERROR_DIFFUSION_KERNELS, type ErrorDiffusionScreeningSetting } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { unpackPlane1bpp } from '@bax-print/marks';
import { composeScreening } from '@bax-print/media';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

const WIDTH = 10;
const HEIGHT = 3;
const PIXELS = WIDTH * HEIGHT;

const FLOYD: ErrorDiffusionScreeningSetting = { kind: 'error-diffusion', kernel: 'floyd-steinberg' };
const JJN_SERPENTINE: ErrorDiffusionScreeningSetting = { kind: 'error-diffusion', kernel: 'jarvis-judice-ninke', serpentine: true };

interface Harness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
  readonly repository: MemoryJobRepository;
}

interface Preview {
  readonly width: number;
  readonly height: number;
  readonly rowBytes: number;
  readonly c: string;
  readonly m: string;
  readonly y: string;
  readonly k: string;
}

async function sourcePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 100]);
  return pdf.save();
}

function gradient(value: (i: number) => number): Uint8Array {
  return Uint8Array.from({ length: PIXELS }, (_v, i) => value(i));
}

/** Gradients in every plane, so error diffusion sets some dots and leaves others. */
const PLANES = {
  c: gradient((i) => (i * 9) % 256),
  m: gradient((i) => (i * 17) % 256),
  y: gradient((i) => 255 - ((i * 5) % 256)),
  k: gradient(() => 128),
};

function previewBody(): Record<string, unknown> {
  const base64 = (plane: Uint8Array): string => Buffer.from(plane).toString('base64');
  return { width: WIDTH, height: HEIGHT, c: base64(PLANES.c), m: base64(PLANES.m), y: base64(PLANES.y), k: base64(PLANES.k) };
}

describe('error-diffusion job screening (Spec 045c)', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  /** A server with the screening and screen-preview routes, plus the media routes for `GET /openapi.json`. */
  function createHarness(): Harness {
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
    const app = buildServer({
      archive,
      media,
      jobs: repository,
      screening: { jobs: repository, clock: time.clock },
      screenPreview: { jobs: repository },
    });
    apps.push(app);
    return { app, jobs, repository };
  }

  async function createJob(harness: Harness): Promise<string> {
    const job = await harness.jobs.create({ name: 'Label', sources: [{ name: 'label.pdf', bytes: await sourcePdf() }], ticket: TICKET });
    return job.id;
  }

  function put(harness: Harness, jobId: string, body: unknown) {
    return harness.app.inject({
      method: 'PUT',
      url: `/jobs/${jobId}/screening`,
      payload: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  function preview(harness: Harness, jobId: string) {
    return harness.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/screen-preview`,
      payload: JSON.stringify(previewBody()),
      headers: { 'content-type': 'application/json' },
    });
  }

  function unpack(answer: Preview, data: string): Uint8Array {
    const { width, height, rowBytes } = answer;
    return unpackPlane1bpp({ width, height, rowBytes, data: Buffer.from(data, 'base64') });
  }

  it.each([
    ['floyd-steinberg without serpentine', FLOYD],
    ['jarvis-judice-ninke with serpentine', JJN_SERPENTINE],
  ])('sets %s, which the job then reads back unchanged', async (_name, setting) => {
    const h = createHarness();
    const jobId = await createJob(h);

    const response = await put(h, jobId, setting);

    expect(response.statusCode).toBe(200);
    const { job } = response.json<{ job: { id: string; screening?: unknown } }>();
    expect(job.id).toBe(jobId);
    expect(job.screening).toStrictEqual(setting);
    expect((await h.repository.get(jobId))?.screening).toStrictEqual(setting);
  });

  it('keeps serpentine absent when the body leaves it out', async () => {
    const h = createHarness();
    const jobId = await createJob(h);

    await put(h, jobId, FLOYD);

    const stored = await h.repository.get(jobId);
    expect(stored?.screening).not.toHaveProperty('serpentine');
  });

  it.each([
    ['floyd-steinberg', FLOYD],
    ['jarvis-judice-ninke serpentine', JJN_SERPENTINE],
  ])('screen-preview of a %s job answers planes of only 0 and 255, as composeScreening screens them', async (_name, setting) => {
    const h = createHarness();
    const jobId = await createJob(h);
    expect((await put(h, jobId, setting)).statusCode).toBe(200);

    const response = await preview(h, jobId);

    expect(response.statusCode).toBe(200);
    const answer = response.json<Preview>();
    const expected = composeScreening({ width: WIDTH, height: HEIGHT, ...PLANES, screening: setting });
    for (const name of ['c', 'm', 'y', 'k'] as const) {
      const unpacked = unpack(answer, answer[name]);
      expect(unpacked).toHaveLength(PIXELS);
      expect(unpacked.every((v) => v === 0 || v === 255)).toBe(true);
      expect(Array.from(unpacked)).toEqual(Array.from(expected[name]));
    }
    // The gradients are neither all ink nor all paper.
    const c = unpack(answer, answer.c);
    expect(c.some((v) => v === 0)).toBe(true);
    expect(c.some((v) => v === 255)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a missing kernel', { kind: 'error-diffusion' }],
    ['an unknown kernel', { kind: 'error-diffusion', kernel: 'atkinson' }],
    ['a kernel of the wrong case', { kind: 'error-diffusion', kernel: 'Floyd-Steinberg' }],
    ['a non-string kernel', { kind: 'error-diffusion', kernel: 1 }],
    ['a string serpentine', { kind: 'error-diffusion', kernel: 'floyd-steinberg', serpentine: 'true' }],
    ['a numeric serpentine', { kind: 'error-diffusion', kernel: 'floyd-steinberg', serpentine: 1 }],
    ['a null serpentine', { kind: 'error-diffusion', kernel: 'floyd-steinberg', serpentine: null }],
    ['a size', { kind: 'error-diffusion', kernel: 'floyd-steinberg', size: 4 }],
    ['a seed', { kind: 'error-diffusion', kernel: 'floyd-steinberg', seed: 1 }],
    ['an unknown field', { kind: 'error-diffusion', kernel: 'floyd-steinberg', extra: true }],
  ])('answers 400 invalid_screening for %s and leaves the job unchanged', async (_name, body) => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, FLOYD);
    const before = await h.repository.get(jobId);

    const response = await put(h, jobId, body);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_screening');
    expect(await h.repository.get(jobId)).toStrictEqual(before);
  });

  it('documents the error-diffusion shape with the core kernel list', async () => {
    const h = createHarness();

    const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    const spec = response.json<{ components: { schemas: Record<string, { oneOf?: Record<string, unknown>[] }> } }>();
    const shapes = spec.components.schemas.ScreeningSetting?.oneOf ?? [];
    expect(shapes).toContainEqual(
      expect.objectContaining({
        required: ['kind', 'kernel'],
        additionalProperties: false,
        properties: {
          kind: { const: 'error-diffusion' },
          kernel: { enum: [...SCREENING_ERROR_DIFFUSION_KERNELS] },
          serpentine: expect.objectContaining({ type: 'boolean' }),
        },
      }),
    );
  });
});
