import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor, SiteMembership } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { PLANE_CURVES_BODY_LIMIT, PLANE_CURVES_ENV, parsePlaneCurvesFlag } from '../src/plane-curves-routes.js';
import type { SiteMembershipLookup } from '../src/site-scope.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };
/** An operator of the north site only. */
const NORTH_OPERATOR: Actor = { id: 'north-1', role: 'operator' };
const NORTH_ONLY: SiteMembership = { userId: NORTH_OPERATOR.id, siteIds: ['north'] };
const memberships: SiteMembershipLookup = (actor) => (actor.id === NORTH_OPERATOR.id ? NORTH_ONLY : undefined);

/** The smallest curve: the two required endpoints. */
const TWO_POINTS = [
  { in: 0, out: 0 },
  { in: 255, out: 230 },
];
/** The largest curve: one point per input level. */
const ALL_POINTS = Array.from({ length: 256 }, (_, level) => ({ in: level, out: Math.round(level * 0.9) }));

const SETTING = { k: { points: TWO_POINTS, method: 'linear' } };

interface HarnessOptions {
  readonly planeCurves?: boolean;
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

describe('PUT and DELETE /jobs/:id/plane-curves (Spec 044d)', () => {
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
    const { actor, planeCurves = true, siteScoped = false } = options;
    const app = buildServer({
      archive,
      media,
      jobs: repository,
      ...(planeCurves ? { planeCurves: { jobs: repository, clock: time.clock } } : {}),
      ...(siteScoped ? { siteScope: { memberships, jobs: repository } } : {}),
      ...(actor ? { authenticate: () => actor } : {}),
    });
    apps.push(app);
    return { app, jobs, repository };
  }

  async function createJob(harness: Harness, siteId?: string): Promise<string> {
    const ticket = siteId === undefined ? TICKET : { ...TICKET, siteId };
    const job = await harness.jobs.create({ name: 'Label', sources: [{ name: 'label.pdf', bytes: await sourcePdf() }], ticket });
    return job.id;
  }

  function put(harness: Harness, jobId: string, body: unknown) {
    return harness.app.inject({
      method: 'PUT',
      url: `/jobs/${jobId}/plane-curves`,
      payload: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  function remove(harness: Harness, jobId: string) {
    return harness.app.inject({ method: 'DELETE', url: `/jobs/${jobId}/plane-curves` });
  }

  describe('the BPS_PLANE_CURVES flag', () => {
    it('is off when unset and on only for 1', () => {
      expect(parsePlaneCurvesFlag({})).toBe(false);
      expect(parsePlaneCurvesFlag({ [PLANE_CURVES_ENV]: '1' })).toBe(true);
    });

    it.each(['', '0', 'true', 'yes', ' 1', '1 ', 'on'])('stops startup for %j', (value) => {
      expect(() => parsePlaneCurvesFlag({ [PLANE_CURVES_ENV]: value })).toThrow(`${PLANE_CURVES_ENV} must be 1 or unset`);
    });
  });

  it('is not mounted with the flag off', async () => {
    const h = createHarness({ planeCurves: false });
    const jobId = await createJob(h);

    const putResponse = await put(h, jobId, SETTING);
    const deleteResponse = await remove(h, jobId);
    const openapi = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    expect(putResponse.statusCode).toBe(404);
    expect(deleteResponse.statusCode).toBe(404);
    const paths: unknown = openapi.json<{ paths: Record<string, unknown> }>().paths;
    expect(paths).not.toHaveProperty(['/jobs/{id}/plane-curves']);
    expect((await h.repository.get(jobId))?.planeCurves).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>]>([
    ['2 points', SETTING],
    ['256 points', { c: { points: ALL_POINTS, method: 'monotone' } }],
    ['every channel', { c: SETTING.k, m: SETTING.k, y: SETTING.k, k: { points: ALL_POINTS, method: 'linear' } }],
  ])('sets a setting of %s, which the job then reads back with', async (_name, setting) => {
    const h = createHarness();
    const jobId = await createJob(h);

    const response = await put(h, jobId, setting);

    expect(response.statusCode).toBe(200);
    const { job } = response.json<{ job: { id: string; updatedAt: string; planeCurves?: unknown } }>();
    expect(job.id).toBe(jobId);
    expect(job.planeCurves).toEqual(setting);
    const stored = await h.repository.get(jobId);
    expect(stored?.planeCurves).toEqual(setting);
    expect(stored?.updatedAt).toBe(job.updatedAt);
  });

  it('replaces a previous setting', async () => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, SETTING);
    const next = { m: { points: ALL_POINTS, method: 'monotone' } };

    const response = await put(h, jobId, next);

    expect(response.statusCode).toBe(200);
    expect((await h.repository.get(jobId))?.planeCurves).toEqual(next);
  });

  it.each<[string, unknown]>([
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
        k: {
          points: [
            { in: 0, out: 0 },
            { in: 128, out: 200 },
          ],
          method: 'linear',
        },
      },
    ],
    [
      'a missing 0 endpoint',
      {
        k: {
          points: [
            { in: 1, out: 0 },
            { in: 255, out: 255 },
          ],
          method: 'linear',
        },
      },
    ],
    [
      'inputs that do not increase',
      {
        k: {
          points: [
            { in: 0, out: 0 },
            { in: 0, out: 10 },
            { in: 255, out: 255 },
          ],
          method: 'linear',
        },
      },
    ],
    ['an unknown channel', { ...SETTING, w: SETTING.k }],
    ['an unknown curve field', { k: { ...SETTING.k, gamma: 2 } }],
    ['an unknown point field', { k: { points: [{ in: 0, out: 0, x: 1 }, { in: 255, out: 255 }], method: 'linear' } }],
    ["method 'cubic'", { k: { points: TWO_POINTS, method: 'cubic' } }],
    ['a missing method', { k: { points: TWO_POINTS } }],
    ['one point', { k: { points: [{ in: 0, out: 0 }], method: 'linear' } }],
    ['257 points', { k: { points: [...ALL_POINTS, { in: 255, out: 255 }], method: 'linear' } }],
    ['an output of 256', { k: { points: [{ in: 0, out: 0 }, { in: 255, out: 256 }], method: 'linear' } }],
    ['a string', 'linear'],
    ['null', null],
    ['an array', [SETTING]],
  ])('answers 400 invalid_plane_curves for %s and leaves the job unchanged', async (_name, body) => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, SETTING);
    const before = await h.repository.get(jobId);

    const response = await put(h, jobId, body);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_plane_curves');
    expect(await h.repository.get(jobId)).toStrictEqual(before);
  });

  it('answers 400 invalid_plane_curves without a body', async () => {
    const h = createHarness();
    const jobId = await createJob(h);

    const response = await h.app.inject({ method: 'PUT', url: `/jobs/${jobId}/plane-curves` });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_plane_curves');
    expect((await h.repository.get(jobId))?.planeCurves).toBeUndefined();
  });

  it('accepts the largest setting pretty-printed, well below the body limit', async () => {
    const h = createHarness();
    const jobId = await createJob(h);
    const curve = { points: ALL_POINTS, method: 'monotone' };
    const setting = { c: curve, m: curve, y: curve, k: curve };
    const payload = JSON.stringify(setting, null, 2);

    const response = await h.app.inject({
      method: 'PUT',
      url: `/jobs/${jobId}/plane-curves`,
      payload,
      headers: { 'content-type': 'application/json' },
    });

    expect(Buffer.byteLength(payload)).toBeLessThan(PLANE_CURVES_BODY_LIMIT);
    expect(response.statusCode).toBe(200);
    expect((await h.repository.get(jobId))?.planeCurves).toEqual(setting);
  });

  it(`answers 413 for a body above ${String(PLANE_CURVES_BODY_LIMIT)} bytes and leaves the job unchanged`, async () => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, SETTING);
    const before = await h.repository.get(jobId);

    const response = await put(h, jobId, { ...SETTING, pad: 'x'.repeat(PLANE_CURVES_BODY_LIMIT) });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_request');
    expect(await h.repository.get(jobId)).toStrictEqual(before);
  });

  it('DELETE turns the curves off', async () => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, SETTING);

    const response = await remove(h, jobId);

    expect(response.statusCode).toBe(200);
    const { job } = response.json<{ job: Record<string, unknown> }>();
    expect(job).toHaveProperty('id', jobId);
    expect(job).not.toHaveProperty('planeCurves');
    const stored = await h.repository.get(jobId);
    expect(stored !== undefined && 'planeCurves' in stored).toBe(false);
  });

  it('DELETE of a job without a setting leaves it off', async () => {
    const h = createHarness();
    const jobId = await createJob(h);

    const response = await remove(h, jobId);

    expect(response.statusCode).toBe(200);
    expect((await h.repository.get(jobId))?.planeCurves).toBeUndefined();
  });

  it('needs jobs:write, like the ink-limit routes', async () => {
    const h = createHarness({ actor: VIEWER });
    const jobId = await createJob(h);

    const putResponse = await put(h, jobId, SETTING);
    const deleteResponse = await remove(h, jobId);

    expect(putResponse.statusCode).toBe(403);
    expect(putResponse.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:write' } } });
    expect(deleteResponse.statusCode).toBe(403);
    expect(deleteResponse.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:write' } } });
    expect((await h.repository.get(jobId))?.planeCurves).toBeUndefined();
  });

  it.each<['PUT' | 'DELETE']>([['PUT'], ['DELETE']])(
    '%s answers a missing job and a job of another site with the same 404 status and body',
    async (method) => {
      const send = (harness: Harness, jobId: string) => (method === 'PUT' ? put(harness, jobId, SETTING) : remove(harness, jobId));
      const other = createHarness({ siteScoped: true, actor: NORTH_OPERATOR });
      const jobId = await createJob(other, 'south');
      const scopedMissing = createHarness({ siteScoped: true, actor: NORTH_OPERATOR });
      const unscopedMissing = createHarness();

      const outOfScope = await send(other, jobId);
      const missingForScoped = await send(scopedMissing, jobId);
      const missing = await send(unscopedMissing, jobId);

      expect(outOfScope.statusCode).toBe(404);
      expect(outOfScope.json()).toEqual({ error: { code: 'not_found', message: `Job ${jobId} not found` } });
      for (const response of [missingForScoped, missing]) {
        expect(response.statusCode).toBe(outOfScope.statusCode);
        expect(response.headers['content-type']).toBe(outOfScope.headers['content-type']);
        expect(response.payload).toBe(outOfScope.payload);
      }
      expect((await other.repository.get(jobId))?.planeCurves).toBeUndefined();
    },
  );

  it('sets the setting of a job in the caller site', async () => {
    const h = createHarness({ siteScoped: true, actor: NORTH_OPERATOR });
    const jobId = await createJob(h, 'north');

    const response = await put(h, jobId, SETTING);

    expect(response.statusCode).toBe(200);
    expect((await h.repository.get(jobId))?.planeCurves).toEqual(SETTING);
  });

  it('documents both routes and the PlaneCurvesSetting schema with its bounds', async () => {
    const h = createHarness();

    const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    const spec = response.json<{
      info: { description: string };
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();
    const path = spec.paths['/jobs/{id}/plane-curves'];
    expect(path?.put?.operationId).toBe('setJobPlaneCurves');
    expect(Object.keys(path?.put?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '403', '404', '413']));
    expect(path?.delete?.operationId).toBe('clearJobPlaneCurves');
    expect(spec.components.schemas).toHaveProperty('PlaneCurvesJob');
    expect(spec.components.schemas.PlaneCurvesSetting).toMatchObject({
      additionalProperties: false,
      minProperties: 1,
      properties: {
        k: {
          required: ['points', 'method'],
          properties: {
            points: {
              minItems: 2,
              maxItems: 256,
              items: { properties: { in: { minimum: 0, maximum: 255 }, out: { minimum: 0, maximum: 255 } } },
            },
            method: { enum: ['monotone', 'linear'] },
          },
        },
      },
    });
    expect(spec.info.description).toContain('BPS_PLANE_CURVES=1');
  });
});
