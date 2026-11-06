import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { InkLimitSetting, PlaneCurvesSetting, ScreeningSetting } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { packPlane1bpp, writePbmP4, type PackedPlane1bpp } from '@bax-print/marks';
import { buildCurveLut, composeScreening, pipelineOptionsFromJob, type JobPipelineOptions, type PlaneCurveLuts } from '@bax-print/media';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

const BAYER: ScreeningSetting = { kind: 'bayer', size: 4 };
const BLUE_NOISE: ScreeningSetting = { kind: 'blue-noise', size: 16, seed: 7 };
const INK_LIMIT: InkLimitSetting = { limitPercent: 250, method: 'proportional' };

/** Not a multiple of 8 wide, so the packed rows carry padding bits. */
const WIDTH = 37;
const HEIGHT = 11;
const PIXELS = WIDTH * HEIGHT;
const PLANE_SEEDS = { c: 1, m: 2, y: 3, k: 4 } as const;

/** A non-identity setting: c darkened to half, k lifted in the midtones. */
const CURVES: PlaneCurvesSetting = {
  c: {
    points: [
      { in: 0, out: 0 },
      { in: 255, out: 128 },
    ],
    method: 'linear',
  },
  k: {
    points: [
      { in: 0, out: 0 },
      { in: 128, out: 200 },
      { in: 255, out: 255 },
    ],
    method: 'monotone',
  },
};

/** The LUTs CURVES maps to, built here from spec 044a: linear as linear, monotone as monotone-cubic. */
function curvesLuts(): PlaneCurveLuts {
  return {
    c: buildCurveLut(
      [
        { input: 0, output: 0 },
        { input: 255, output: 128 },
      ],
      { interpolation: 'linear' },
    ),
    k: buildCurveLut(
      [
        { input: 0, output: 0 },
        { input: 128, output: 200 },
        { input: 255, output: 255 },
      ],
      { interpolation: 'monotone-cubic' },
    ),
  };
}

const IDENTITY_POINTS = [
  { in: 0, out: 0 },
  { in: 255, out: 255 },
];
const IDENTITY_CURVES: PlaneCurvesSetting = {
  c: { points: IDENTITY_POINTS, method: 'linear' },
  m: { points: IDENTITY_POINTS, method: 'monotone' },
  y: { points: [{ in: 0, out: 0 }, { in: 128, out: 128 }, { in: 255, out: 255 }], method: 'linear' },
  k: { points: IDENTITY_POINTS, method: 'monotone' },
};

type Format = 'packed' | 'pbm';
const FORMATS: readonly Format[] = ['packed', 'pbm'];

interface Planes {
  readonly c: Uint8Array;
  readonly m: Uint8Array;
  readonly y: Uint8Array;
  readonly k: Uint8Array;
}

/** A deterministic plane from a linear congruential generator, so every run sends the same bytes. */
function seededPlane(seed: number): Uint8Array {
  let state = seed >>> 0;
  return Uint8Array.from({ length: PIXELS }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  });
}

/** Fresh planes on every call, so no computation can see another one's buffers. */
function seededPlanes(): Planes {
  return {
    c: seededPlane(PLANE_SEEDS.c),
    m: seededPlane(PLANE_SEEDS.m),
    y: seededPlane(PLANE_SEEDS.y),
    k: seededPlane(PLANE_SEEDS.k),
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function requestBody(format: Format): Record<string, unknown> {
  const { c, m, y, k } = seededPlanes();
  return { width: WIDTH, height: HEIGHT, format, c: toBase64(c), m: toBase64(m), y: toBase64(y), k: toBase64(k) };
}

/** The answer computed without the server: composeScreening on the seeded planes, packed with marks. */
function expectedPayload(options: JobPipelineOptions, format: Format): string {
  const planes = composeScreening({ width: WIDTH, height: HEIGHT, ...seededPlanes(), ...options });
  const pack = (plane: Uint8Array): PackedPlane1bpp => packPlane1bpp({ width: WIDTH, height: HEIGHT, plane });
  if (format === 'pbm') {
    const pbm = (plane: Uint8Array): string => toBase64(writePbmP4(pack(plane)));
    return JSON.stringify({ width: WIDTH, height: HEIGHT, format, c: pbm(planes.c), m: pbm(planes.m), y: pbm(planes.y), k: pbm(planes.k) });
  }
  const c = pack(planes.c);
  return JSON.stringify({
    width: WIDTH,
    height: HEIGHT,
    rowBytes: c.rowBytes,
    c: toBase64(c.data),
    m: toBase64(pack(planes.m).data),
    y: toBase64(pack(planes.y).data),
    k: toBase64(pack(planes.k).data),
  });
}

/** The pre-044e options: screening and ink limit only, planeCurves never passed. */
function noCurvesOptions(screening: ScreeningSetting): JobPipelineOptions {
  return pipelineOptionsFromJob({ screening, inkLimit: INK_LIMIT });
}

async function sourcePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 100]);
  return pdf.save();
}

interface Harness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
  readonly repository: MemoryJobRepository;
}

describe('POST /jobs/:id/screen-preview with plane curves (Spec 044e)', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  /** Screen preview is always mounted; `planeCurves` mounts the Spec 044d routes, as `BPS_PLANE_CURVES=1` does. */
  function createHarness(planeCurves = true): Harness {
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
      screenPreview: { jobs: repository },
      ...(planeCurves ? { planeCurves: { jobs: repository, clock: time.clock } } : {}),
    });
    apps.push(app);
    return { app, jobs, repository };
  }

  interface JobSettings {
    readonly screening?: ScreeningSetting;
    readonly planeCurves?: PlaneCurvesSetting;
  }

  /** A job with the ink limit, and the given screening and plane curves written straight into the store. */
  async function createJob(harness: Harness, settings: JobSettings = {}): Promise<string> {
    const { screening, planeCurves } = settings;
    const created = await harness.jobs.create({ name: 'Label', sources: [{ name: 'label.pdf', bytes: await sourcePdf() }], ticket: TICKET });
    const job = await harness.repository.get(created.id);
    if (!job) throw new Error(`job ${created.id} was not stored`);
    await harness.repository.save({
      ...job,
      inkLimit: INK_LIMIT,
      ...(screening === undefined ? {} : { screening }),
      ...(planeCurves === undefined ? {} : { planeCurves }),
    });
    return created.id;
  }

  function preview(harness: Harness, jobId: string, payload: unknown) {
    return harness.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/screen-preview`,
      payload: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    });
  }

  async function putCurves(harness: Harness, jobId: string, setting: PlaneCurvesSetting): Promise<void> {
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/jobs/${jobId}/plane-curves`,
      payload: JSON.stringify(setting),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(200);
  }

  const SCREENINGS: readonly (readonly [string, ScreeningSetting])[] = [
    ['bayer', BAYER],
    ['blue-noise', BLUE_NOISE],
  ];
  const CASES = FORMATS.flatMap((format) => SCREENINGS.map(([name, screening]) => ({ format, name, screening })));

  describe('a job without curves', () => {
    it.each(FORMATS.flatMap((format) => [true, false].map((planeCurves) => ({ format, planeCurves }))))(
      'answers $format planes byte-identical to screening and ink limit alone (plane-curves routes mounted: $planeCurves)',
      async ({ format, planeCurves }) => {
        for (const screening of [BAYER, BLUE_NOISE]) {
          const h = createHarness(planeCurves);
          const jobId = await createJob(h, { screening });

          const response = await preview(h, jobId, requestBody(format));

          expect(response.statusCode).toBe(200);
          expect(response.payload).toBe(expectedPayload(noCurvesOptions(screening), format));
        }
      },
    );
  });

  it.each<[string, PlaneCurvesSetting]>([
    ['an empty object', {}],
    [
      'decreasing outputs',
      {
        k: {
          points: [
            { in: 0, out: 0 },
            { in: 128, out: 200 },
            { in: 255, out: 100 },
          ],
          method: 'linear',
        },
      },
    ],
    [
      'a missing 255 endpoint',
      {
        c: {
          points: [
            { in: 0, out: 0 },
            { in: 128, out: 200 },
          ],
          method: 'monotone',
        },
      },
    ],
    ['an output of 256', { m: { points: [{ in: 0, out: 0 }, { in: 255, out: 256 }], method: 'linear' } }],
  ])('treats a stored planeCurves of %s as absent', async (_name, planeCurves) => {
    const h = createHarness();
    const jobId = await createJob(h, { screening: BAYER, planeCurves });

    const stored = await h.repository.get(jobId);
    expect(stored).toBeDefined();
    expect(stored?.planeCurves).toBeUndefined();
    for (const format of FORMATS) {
      const response = await preview(h, jobId, requestBody(format));

      expect(response.statusCode).toBe(200);
      expect(response.payload).toBe(expectedPayload(noCurvesOptions(BAYER), format));
    }
  });

  it.each(CASES)('applies curves set through PUT to a $name job, $format', async ({ format, screening }) => {
    const h = createHarness();
    const jobId = await createJob(h, { screening });
    await putCurves(h, jobId, CURVES);

    const response = await preview(h, jobId, requestBody(format));

    expect(response.statusCode).toBe(200);
    const withCurves = expectedPayload({ ...noCurvesOptions(screening), planeCurves: curvesLuts() }, format);
    expect(response.payload).toBe(withCurves);
    expect(response.payload).not.toBe(expectedPayload(noCurvesOptions(screening), format));
  });

  it('builds the same LUTs from the stored setting as the test does', () => {
    expect(pipelineOptionsFromJob({ planeCurves: CURVES }).planeCurves).toEqual(curvesLuts());
  });

  it.each(CASES)('answers identity curves on a $name job like no curves, $format', async ({ format, screening }) => {
    const h = createHarness();
    const jobId = await createJob(h, { screening });
    await putCurves(h, jobId, IDENTITY_CURVES);

    const response = await preview(h, jobId, requestBody(format));

    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe(expectedPayload(noCurvesOptions(screening), format));
  });

  it('answers like no curves again after DELETE /jobs/:id/plane-curves', async () => {
    const h = createHarness();
    const jobId = await createJob(h, { screening: BAYER });
    await putCurves(h, jobId, CURVES);

    const cleared = await h.app.inject({ method: 'DELETE', url: `/jobs/${jobId}/plane-curves` });
    const response = await preview(h, jobId, requestBody('packed'));

    expect(cleared.statusCode).toBe(200);
    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe(expectedPayload(noCurvesOptions(BAYER), 'packed'));
  });

  it.each<[string, unknown]>([
    ['a packed request', requestBody('packed')],
    ['a pbm request', requestBody('pbm')],
    ['an invalid body', { width: 0 }],
  ])('answers 409 screening_not_set for %s of a job with curves but no screening', async (_name, payload) => {
    const h = createHarness();
    const jobId = await createJob(h);
    await putCurves(h, jobId, CURVES);

    const response = await preview(h, jobId, payload);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('screening_not_set');
  });

  it('answers 404 not_found for a missing job before anything else', async () => {
    const h = createHarness();

    const response = await preview(h, 'missing', { width: 0 });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('not_found');
  });

  it('documents that stored curves apply between the ink limit and screening', async () => {
    const h = createHarness();

    const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    const { description } = response.json<{ info: { description: string } }>().info;
    expect(description).toContain('applies stored `planeCurves` after the ink limit and before screening');
  });
});
