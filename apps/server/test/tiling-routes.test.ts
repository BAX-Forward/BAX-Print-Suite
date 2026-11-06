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
import type { SiteMembershipLookup } from '../src/site-scope.js';
import { TILING_BODY_LIMIT, TILING_ENV, parseTilingFlag } from '../src/tiling-routes.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };
/** An operator of the north site only. */
const NORTH_OPERATOR: Actor = { id: 'north-1', role: 'operator' };
const NORTH_ONLY: SiteMembership = { userId: NORTH_OPERATOR.id, siteIds: ['north'] };
const memberships: SiteMembershipLookup = (actor) => (actor.id === NORTH_OPERATOR.id ? NORTH_ONLY : undefined);

const GRID = { columns: 3, rows: 2 };
const SETTING = { grid: GRID };

interface HarnessOptions {
  readonly tiling?: boolean;
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

describe('PUT and DELETE /jobs/:id/tiling (Spec 050a)', () => {
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
    const { actor, tiling = true, siteScoped = false } = options;
    const app = buildServer({
      archive,
      media,
      jobs: repository,
      ...(tiling ? { tiling: { jobs: repository, clock: time.clock } } : {}),
      ...(siteScoped ? { siteScope: { memberships, jobs: repository } } : {}),
      ...(actor ? { authenticate: () => actor } : {}),
    });
    apps.push(app);
    return { app, jobs, repository };
  }

  async function createJob(harness: Harness, siteId?: string): Promise<string> {
    const ticket = siteId === undefined ? TICKET : { ...TICKET, siteId };
    const job = await harness.jobs.create({ name: 'Banner', sources: [{ name: 'banner.pdf', bytes: await sourcePdf() }], ticket });
    return job.id;
  }

  function put(harness: Harness, jobId: string, body: unknown) {
    return harness.app.inject({
      method: 'PUT',
      url: `/jobs/${jobId}/tiling`,
      payload: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  function remove(harness: Harness, jobId: string) {
    return harness.app.inject({ method: 'DELETE', url: `/jobs/${jobId}/tiling` });
  }

  describe('the BPS_TILING flag', () => {
    it('is off when unset and on only for 1', () => {
      expect(parseTilingFlag({})).toBe(false);
      expect(parseTilingFlag({ [TILING_ENV]: '1' })).toBe(true);
    });

    it.each(['', '0', 'true', 'yes', ' 1', '1 ', 'on'])('stops startup for %j', (value) => {
      expect(() => parseTilingFlag({ [TILING_ENV]: value })).toThrow(`${TILING_ENV} must be 1 or unset`);
    });
  });

  it('is not mounted with the flag off', async () => {
    const h = createHarness({ tiling: false });
    const jobId = await createJob(h);

    const putResponse = await put(h, jobId, SETTING);
    const deleteResponse = await remove(h, jobId);
    const openapi = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    expect(putResponse.statusCode).toBe(404);
    expect(deleteResponse.statusCode).toBe(404);
    const paths: unknown = openapi.json<{ paths: Record<string, unknown> }>().paths;
    expect(paths).not.toHaveProperty(['/jobs/{id}/tiling']);
    expect((await h.repository.get(jobId))?.tiling).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>]>([
    ['a grid alone', SETTING],
    ['the largest grid', { grid: { columns: 500, rows: 500 } }],
    ['a butt seam', { grid: GRID, seam: { kind: 'butt' } }],
    ['an overlap seam without a width', { grid: GRID, seam: { kind: 'overlap' } }],
    ['an overlap of 0', { grid: { columns: 1, rows: 1 }, seam: { kind: 'overlap', overlapMm: 0 } }],
    ['a gap seam', { grid: GRID, seam: { kind: 'gap', gapMm: 12.5 } }],
  ])('sets %s, which the job then reads back with', async (_name, setting) => {
    const h = createHarness();
    const jobId = await createJob(h);

    const response = await put(h, jobId, setting);

    expect(response.statusCode).toBe(200);
    const { job } = response.json<{ job: { id: string; updatedAt: string; tiling?: unknown } }>();
    expect(job.id).toBe(jobId);
    expect(job.tiling).toEqual(setting);
    const stored = await h.repository.get(jobId);
    expect(stored?.tiling).toEqual(setting);
    expect(stored?.updatedAt).toBe(job.updatedAt);
  });

  it('replaces a previous setting', async () => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, { grid: GRID, seam: { kind: 'gap', gapMm: 5 } });
    const next = { grid: { columns: 1, rows: 4 } };

    const response = await put(h, jobId, next);

    expect(response.statusCode).toBe(200);
    expect((await h.repository.get(jobId))?.tiling).toEqual(next);
  });

  it.each<[string, unknown]>([
    ['an empty object', {}],
    ['a missing grid', { seam: { kind: 'butt' } }],
    ['an unknown top-level field', { ...SETTING, bleedMm: 3 }],
    ["tile's grid mode", { grid: { ...GRID, mode: 'count' } }],
    ['a size grid', { grid: { maxWidthMm: 1000 } }],
    ['zero columns', { grid: { columns: 0, rows: 1 } }],
    ['501 rows', { grid: { columns: 1, rows: 501 } }],
    ['a fractional count', { grid: { columns: 1.5, rows: 1 } }],
    ['an unknown seam kind', { grid: GRID, seam: { kind: 'glue' } }],
    ['a gap seam without gapMm', { grid: GRID, seam: { kind: 'gap' } }],
    ['a gap of 0', { grid: GRID, seam: { kind: 'gap', gapMm: 0 } }],
    ['gapMm on an overlap seam', { grid: GRID, seam: { kind: 'overlap', gapMm: 5 } }],
    ['overlapMm on a butt seam', { grid: GRID, seam: { kind: 'butt', overlapMm: 5 } }],
    ['a negative overlap', { grid: GRID, seam: { kind: 'overlap', overlapMm: -1 } }],
    ['an overlap above the maximum', { grid: GRID, seam: { kind: 'overlap', overlapMm: 1001 } }],
    ['a null seam', { grid: GRID, seam: null }],
    ['a string', '3x2'],
    ['null', null],
    ['an array', [SETTING]],
  ])('answers 400 invalid_tiling for %s and leaves the job unchanged', async (_name, body) => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, SETTING);
    const before = await h.repository.get(jobId);

    const response = await put(h, jobId, body);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_tiling');
    expect(await h.repository.get(jobId)).toStrictEqual(before);
  });

  it('answers 400 invalid_tiling without a body', async () => {
    const h = createHarness();
    const jobId = await createJob(h);

    const response = await h.app.inject({ method: 'PUT', url: `/jobs/${jobId}/tiling` });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_tiling');
    expect((await h.repository.get(jobId))?.tiling).toBeUndefined();
  });

  it(`answers 413 for a body above ${String(TILING_BODY_LIMIT)} bytes and leaves the job unchanged`, async () => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, SETTING);
    const before = await h.repository.get(jobId);

    const response = await put(h, jobId, { ...SETTING, pad: 'x'.repeat(TILING_BODY_LIMIT) });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_request');
    expect(await h.repository.get(jobId)).toStrictEqual(before);
  });

  it('DELETE turns tiling off', async () => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, SETTING);

    const response = await remove(h, jobId);

    expect(response.statusCode).toBe(200);
    const { job } = response.json<{ job: Record<string, unknown> }>();
    expect(job).toHaveProperty('id', jobId);
    expect(job).not.toHaveProperty('tiling');
    const stored = await h.repository.get(jobId);
    expect(stored !== undefined && 'tiling' in stored).toBe(false);
  });

  it('DELETE of a job without a setting leaves it off', async () => {
    const h = createHarness();
    const jobId = await createJob(h);

    const response = await remove(h, jobId);

    expect(response.statusCode).toBe(200);
    expect((await h.repository.get(jobId))?.tiling).toBeUndefined();
  });

  it('needs jobs:write, like the plane-curves routes', async () => {
    const h = createHarness({ actor: VIEWER });
    const jobId = await createJob(h);

    const putResponse = await put(h, jobId, SETTING);
    const deleteResponse = await remove(h, jobId);

    expect(putResponse.statusCode).toBe(403);
    expect(putResponse.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:write' } } });
    expect(deleteResponse.statusCode).toBe(403);
    expect(deleteResponse.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:write' } } });
    expect((await h.repository.get(jobId))?.tiling).toBeUndefined();
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
      expect((await other.repository.get(jobId))?.tiling).toBeUndefined();
    },
  );

  it('sets the setting of a job in the caller site', async () => {
    const h = createHarness({ siteScoped: true, actor: NORTH_OPERATOR });
    const jobId = await createJob(h, 'north');

    const response = await put(h, jobId, SETTING);

    expect(response.statusCode).toBe(200);
    expect((await h.repository.get(jobId))?.tiling).toEqual(SETTING);
  });

  it('documents both routes and the TilingSetting schema with its bounds', async () => {
    const h = createHarness();

    const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    const spec = response.json<{
      info: { description: string };
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();
    const path = spec.paths['/jobs/{id}/tiling'];
    expect(path?.put?.operationId).toBe('setJobTiling');
    expect(Object.keys(path?.put?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '403', '404', '413']));
    expect(path?.delete?.operationId).toBe('clearJobTiling');
    expect(spec.components.schemas).toHaveProperty('TilingJob');
    expect(spec.components.schemas.TilingSetting).toMatchObject({
      additionalProperties: false,
      required: ['grid'],
      properties: {
        grid: {
          required: ['columns', 'rows'],
          additionalProperties: false,
          properties: { columns: { minimum: 1, maximum: 500 }, rows: { minimum: 1, maximum: 500 } },
        },
        seam: {
          oneOf: [
            { properties: { kind: { const: 'butt' } } },
            { properties: { kind: { const: 'overlap' }, overlapMm: { minimum: 0, maximum: 1000 } } },
            { required: ['kind', 'gapMm'], properties: { kind: { const: 'gap' }, gapMm: { exclusiveMinimum: 0, maximum: 1000 } } },
          ],
        },
      },
    });
    expect(spec.info.description).toContain('BPS_TILING=1');
  });
});
