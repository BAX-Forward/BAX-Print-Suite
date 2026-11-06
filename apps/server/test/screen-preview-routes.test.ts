import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor, InkLimitSetting, ScreeningSetting, SiteMembership } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { unpackPlane1bpp } from '@bax-print/marks';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import {
  parseScreenPreviewFlag,
  SCREEN_PREVIEW_BODY_LIMIT,
  SCREEN_PREVIEW_ENV,
  SCREEN_PREVIEW_MAX_SIDE,
} from '../src/screen-preview-routes.js';
import type { SiteMembershipLookup } from '../src/site-scope.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

/**
 * A resolver may hand back a role outside `Role` at runtime; such a role holds no permissions.
 * The intersection `Object.assign` returns models that without a cast.
 */
const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };
const GUEST: Actor = Object.assign({}, VIEWER, { id: 'guest-1', role: 'guest' });
/** An operator of the north site only. */
const NORTH_OPERATOR: Actor = { id: 'north-1', role: 'operator' };
const NORTH_ONLY: SiteMembership = { userId: NORTH_OPERATOR.id, siteIds: ['north'] };
const memberships: SiteMembershipLookup = (actor) => (actor.id === NORTH_OPERATOR.id ? NORTH_ONLY : undefined);

const BAYER: ScreeningSetting = { kind: 'bayer', size: 4 };
const INK_LIMIT: InkLimitSetting = { limitPercent: 250, method: 'proportional' };

const WIDTH = 10;
const HEIGHT = 3;
const PIXELS = WIDTH * HEIGHT;

interface HarnessOptions {
  readonly screenPreview?: boolean;
  readonly actor?: Actor;
  readonly siteScoped?: boolean;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
  readonly repository: MemoryJobRepository;
}

async function sourcePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 100]);
  return pdf.save();
}

/** A plane of `pixels` bytes, each `value(i)`. */
function plane(pixels: number, value: (i: number) => number): string {
  return Buffer.from(Uint8Array.from({ length: pixels }, (_v, i) => value(i))).toString('base64');
}

/** A valid body: a gradient in every plane, so a bayer screen sets some dots and leaves others. */
function body(width = WIDTH, height = HEIGHT): Record<string, unknown> {
  const pixels = width * height;
  return {
    width,
    height,
    c: plane(pixels, (i) => (i * 9) % 256),
    m: plane(pixels, (i) => (i * 17) % 256),
    y: plane(pixels, (i) => 255 - ((i * 5) % 256)),
    k: plane(pixels, () => 128),
  };
}

describe('POST /jobs/:id/screen-preview (Spec 043a)', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  /** A server with the media routes, so `GET /openapi.json` is mounted too. */
  function createHarness(options: HarnessOptions = {}): Harness {
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
    const { actor, screenPreview = true, siteScoped = false } = options;
    const app = buildServer({
      archive,
      media,
      jobs: repository,
      ...(screenPreview ? { screenPreview: { jobs: repository } } : {}),
      ...(siteScoped ? { siteScope: { memberships, jobs: repository } } : {}),
      ...(actor ? { authenticate: () => actor } : {}),
    });
    apps.push(app);
    return { app, jobs, repository };
  }

  interface JobSettings {
    readonly siteId?: string;
    readonly screening?: ScreeningSetting;
    readonly inkLimit?: InkLimitSetting;
  }

  async function createJob(harness: Harness, settings: JobSettings = {}): Promise<string> {
    const { siteId, screening, inkLimit } = settings;
    const ticket = siteId === undefined ? TICKET : { ...TICKET, siteId };
    const created = await harness.jobs.create({ name: 'Label', sources: [{ name: 'label.pdf', bytes: await sourcePdf() }], ticket });
    const job = await harness.repository.get(created.id);
    if (!job) throw new Error(`job ${created.id} was not stored`);
    await harness.repository.save({
      ...job,
      ...(screening === undefined ? {} : { screening }),
      ...(inkLimit === undefined ? {} : { inkLimit }),
    });
    return created.id;
  }

  function post(harness: Harness, jobId: string, payload: unknown) {
    return harness.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/screen-preview`,
      payload: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    });
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

  function unpack(preview: Preview, data: string): Uint8Array {
    const { width, height, rowBytes } = preview;
    return unpackPlane1bpp({ width, height, rowBytes, data: Buffer.from(data, 'base64') });
  }

  describe('the BPS_SCREEN_PREVIEW flag', () => {
    it('is off when unset and on only for 1', () => {
      expect(parseScreenPreviewFlag({})).toBe(false);
      expect(parseScreenPreviewFlag({ [SCREEN_PREVIEW_ENV]: '1' })).toBe(true);
    });

    it.each(['', '0', 'true', 'yes', ' 1', '1 ', 'on'])('stops startup for %j', (value) => {
      expect(() => parseScreenPreviewFlag({ [SCREEN_PREVIEW_ENV]: value })).toThrow(`${SCREEN_PREVIEW_ENV} must be 1 or unset`);
    });
  });

  it('is not mounted with the flag off', async () => {
    const h = createHarness({ screenPreview: false });
    const jobId = await createJob(h, { screening: BAYER });

    const response = await post(h, jobId, body());
    const openapi = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(404);
    const paths: unknown = openapi.json<{ paths: Record<string, unknown> }>().paths;
    expect(paths).not.toHaveProperty(['/jobs/{id}/screen-preview']);
  });

  it('screens a bayer job and answers 1-bit packed planes', async () => {
    const h = createHarness();
    const jobId = await createJob(h, { screening: BAYER });

    const response = await post(h, jobId, body());

    expect(response.statusCode).toBe(200);
    const preview = response.json<Preview>();
    expect(preview.width).toBe(WIDTH);
    expect(preview.height).toBe(HEIGHT);
    expect(preview.rowBytes).toBe(Math.ceil(WIDTH / 8));
    const packedBase64Length = Math.ceil((preview.rowBytes * HEIGHT) / 3) * 4;
    for (const data of [preview.c, preview.m, preview.y, preview.k]) {
      expect(data).toHaveLength(packedBase64Length);
      const unpacked = unpack(preview, data);
      expect(unpacked).toHaveLength(PIXELS);
      expect(unpacked.every((v) => v === 0 || v === 255)).toBe(true);
    }
    // A mid-gray plane under a 4x4 bayer screen has some dots on and some off.
    const k = unpack(preview, preview.k);
    expect(k.some((v) => v === 255)).toBe(true);
    expect(k.some((v) => v === 0)).toBe(true);
  });

  it('screens a job with an ink limit and screening', async () => {
    const h = createHarness();
    const jobId = await createJob(h, { screening: BAYER, inkLimit: INK_LIMIT });
    const full = plane(PIXELS, () => 255);

    const response = await post(h, jobId, { width: WIDTH, height: HEIGHT, c: full, m: full, y: full, k: full });

    expect(response.statusCode).toBe(200);
    const preview = response.json<Preview>();
    const planes = [preview.c, preview.m, preview.y, preview.k].map((data) => unpack(preview, data));
    for (const unpacked of planes) expect(unpacked.every((v) => v === 0 || v === 255)).toBe(true);
    // 400 % coverage limited to 250 %: not every dot of every plane stays on.
    expect(planes.some((unpacked) => unpacked.some((v) => v === 0))).toBe(true);
  });

  it('screens a blue-noise job', async () => {
    const h = createHarness();
    const jobId = await createJob(h, { screening: { kind: 'blue-noise', size: 16, seed: 7 } });

    const response = await post(h, jobId, body());

    expect(response.statusCode).toBe(200);
    const preview = response.json<Preview>();
    expect(unpack(preview, preview.c).every((v) => v === 0 || v === 255)).toBe(true);
  });

  it('answers 409 screening_not_set for a job without screening', async () => {
    const h = createHarness();
    const jobId = await createJob(h, { inkLimit: INK_LIMIT });

    const response = await post(h, jobId, body());

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('screening_not_set');
  });

  it('needs jobs:read', async () => {
    const h = createHarness({ actor: GUEST });
    const jobId = await createJob(h, { screening: BAYER });

    const response = await post(h, jobId, body());

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:read' } } });
  });

  it('answers a missing job and a job of another site with the same 404 status and body', async () => {
    const other = createHarness({ siteScoped: true, actor: NORTH_OPERATOR });
    const jobId = await createJob(other, { siteId: 'south', screening: BAYER });
    const scopedMissing = createHarness({ siteScoped: true, actor: NORTH_OPERATOR });
    const unscopedMissing = createHarness();

    const outOfScope = await post(other, jobId, body());
    const missingForScoped = await post(scopedMissing, jobId, body());
    const missing = await post(unscopedMissing, jobId, body());

    expect(outOfScope.statusCode).toBe(404);
    expect(outOfScope.json()).toEqual({ error: { code: 'not_found', message: `Job ${jobId} not found` } });
    for (const response of [missingForScoped, missing]) {
      expect(response.statusCode).toBe(outOfScope.statusCode);
      expect(response.headers['content-type']).toBe(outOfScope.headers['content-type']);
      expect(response.payload).toBe(outOfScope.payload);
    }
  });

  it('previews a job in the caller site', async () => {
    const h = createHarness({ siteScoped: true, actor: NORTH_OPERATOR });
    const jobId = await createJob(h, { siteId: 'north', screening: BAYER });

    const response = await post(h, jobId, body());

    expect(response.statusCode).toBe(200);
  });

  it.each<[string, unknown]>([
    ['width 0', { ...body(), width: 0 }],
    [`width ${String(SCREEN_PREVIEW_MAX_SIDE + 1)}`, { ...body(), width: SCREEN_PREVIEW_MAX_SIDE + 1 }],
    [`height ${String(SCREEN_PREVIEW_MAX_SIDE + 1)}`, { ...body(), height: SCREEN_PREVIEW_MAX_SIDE + 1 }],
    ['a non-integer width', { ...body(), width: 9.5 }],
    ['a string height', { ...body(), height: '3' }],
    ['a missing plane', { width: WIDTH, height: HEIGHT, c: plane(PIXELS, () => 0), m: plane(PIXELS, () => 0), y: plane(PIXELS, () => 0) }],
    ['a plane that is not a string', { ...body(), k: [1, 2, 3] }],
    ['bad base64', { ...body(), c: '*'.repeat(Math.ceil(PIXELS / 3) * 4) }],
    ['base64 padding inside a plane', { ...body(), c: `A=${'A'.repeat(Math.ceil(PIXELS / 3) * 4 - 2)}` }],
    ['a plane of the wrong base64 length', { ...body(), m: plane(PIXELS + 3, () => 0) }],
    ['a plane that decodes to the wrong length', { ...body(), y: `${'A'.repeat(Math.ceil(PIXELS / 3) * 4 - 1)}=` }],
    ['an extra field', { ...body(), extra: 1 }],
    ['an array', [body()]],
    ['null', null],
  ])('answers 400 invalid_screen_preview for %s', async (_name, payload) => {
    const h = createHarness();
    const jobId = await createJob(h, { screening: BAYER });

    const response = await post(h, jobId, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_screen_preview');
  });

  it('answers 400 invalid_screen_preview without a body', async () => {
    const h = createHarness();
    const jobId = await createJob(h, { screening: BAYER });

    const response = await h.app.inject({ method: 'POST', url: `/jobs/${jobId}/screen-preview` });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_screen_preview');
  });

  it(`answers 413 for a body above ${String(SCREEN_PREVIEW_BODY_LIMIT)} bytes`, async () => {
    const h = createHarness();
    const jobId = await createJob(h, { screening: BAYER });

    const response = await post(h, jobId, { ...body(), pad: 'x'.repeat(SCREEN_PREVIEW_BODY_LIMIT) });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_request');
  });

  it('sizes the body limit to four planes of the largest preview', () => {
    expect(SCREEN_PREVIEW_MAX_SIDE).toBe(1024);
    expect(SCREEN_PREVIEW_BODY_LIMIT).toBe(4 * Math.ceil((1024 * 1024) / 3) * 4 + 4096);
  });

  it('documents the route and its schemas', async () => {
    const h = createHarness();

    const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    const spec = response.json<{
      info: { description: string };
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();
    const path = spec.paths['/jobs/{id}/screen-preview'];
    expect(path?.post?.operationId).toBe('previewJobScreening');
    expect(Object.keys(path?.post?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '403', '404', '409', '413']));
    expect(spec.components.schemas).toHaveProperty('ScreenPreviewRequest');
    expect(spec.components.schemas).toHaveProperty('ScreenPreview');
    expect(spec.info.description).toContain('BPS_SCREEN_PREVIEW=1');
  });
});
