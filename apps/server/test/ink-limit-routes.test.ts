import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor, SiteMembership } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { INK_LIMIT_BODY_LIMIT, INK_LIMIT_ENV, parseInkLimitFlag } from '../src/ink-limit-routes.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import type { SiteMembershipLookup } from '../src/site-scope.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };
/** An operator of the north site only. */
const NORTH_OPERATOR: Actor = { id: 'north-1', role: 'operator' };
const NORTH_ONLY: SiteMembership = { userId: NORTH_OPERATOR.id, siteIds: ['north'] };
const memberships: SiteMembershipLookup = (actor) => (actor.id === NORTH_OPERATOR.id ? NORTH_ONLY : undefined);

const SETTING = { limitPercent: 300, method: 'proportional' };

interface HarnessOptions {
  readonly inkLimit?: boolean;
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

describe('PUT and DELETE /jobs/:id/ink-limit (Spec 040c)', () => {
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
    const { actor, inkLimit = true, siteScoped = false } = options;
    const app = buildServer({
      archive,
      media,
      jobs: repository,
      ...(inkLimit ? { inkLimit: { jobs: repository, clock: time.clock } } : {}),
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
      url: `/jobs/${jobId}/ink-limit`,
      payload: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  function remove(harness: Harness, jobId: string) {
    return harness.app.inject({ method: 'DELETE', url: `/jobs/${jobId}/ink-limit` });
  }

  describe('the BPS_INK_LIMIT flag', () => {
    it('is off when unset and on only for 1', () => {
      expect(parseInkLimitFlag({})).toBe(false);
      expect(parseInkLimitFlag({ [INK_LIMIT_ENV]: '1' })).toBe(true);
    });

    it.each(['', '0', 'true', 'yes', ' 1', '1 ', 'on'])('stops startup for %j', (value) => {
      expect(() => parseInkLimitFlag({ [INK_LIMIT_ENV]: value })).toThrow(`${INK_LIMIT_ENV} must be 1 or unset`);
    });
  });

  it('is not mounted with the flag off', async () => {
    const h = createHarness({ inkLimit: false });
    const jobId = await createJob(h);

    const putResponse = await put(h, jobId, SETTING);
    const deleteResponse = await remove(h, jobId);
    const openapi = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    expect(putResponse.statusCode).toBe(404);
    expect(deleteResponse.statusCode).toBe(404);
    const paths: unknown = openapi.json<{ paths: Record<string, unknown> }>().paths;
    expect(paths).not.toHaveProperty(['/jobs/{id}/ink-limit']);
    expect((await h.repository.get(jobId))?.inkLimit).toBeUndefined();
  });

  it('sets the setting, which the job then reads back with', async () => {
    const h = createHarness();
    const jobId = await createJob(h);

    const response = await put(h, jobId, SETTING);

    expect(response.statusCode).toBe(200);
    const { job } = response.json<{ job: { id: string; inkLimit?: unknown } }>();
    expect(job.id).toBe(jobId);
    expect(job.inkLimit).toEqual(SETTING);
    expect((await h.repository.get(jobId))?.inkLimit).toEqual(SETTING);
  });

  it('replaces a previous setting', async () => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, SETTING);

    const response = await put(h, jobId, { limitPercent: 260, method: 'gcr' });

    expect(response.statusCode).toBe(200);
    expect((await h.repository.get(jobId))?.inkLimit).toEqual({ limitPercent: 260, method: 'gcr' });
  });

  it.each<[string, unknown]>([
    ['limitPercent 99', { limitPercent: 99, method: 'proportional' }],
    ['limitPercent 401', { limitPercent: 401, method: 'proportional' }],
    ['limitPercent 250.5', { limitPercent: 250.5, method: 'gcr' }],
    ['a string limitPercent', { limitPercent: '300', method: 'gcr' }],
    ["method 'x'", { limitPercent: 300, method: 'x' }],
    ['a missing method', { limitPercent: 300 }],
    ['an extra field', { limitPercent: 300, method: 'gcr', extra: 1 }],
    ['a string', 'gcr'],
    ['null', null],
    ['an array', [SETTING]],
  ])('answers 400 invalid_ink_limit for %s and leaves the job unchanged', async (_name, body) => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, SETTING);
    const before = await h.repository.get(jobId);

    const response = await put(h, jobId, body);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_ink_limit');
    expect(await h.repository.get(jobId)).toStrictEqual(before);
  });

  it('answers 400 invalid_ink_limit without a body', async () => {
    const h = createHarness();
    const jobId = await createJob(h);

    const response = await h.app.inject({ method: 'PUT', url: `/jobs/${jobId}/ink-limit` });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_ink_limit');
    expect((await h.repository.get(jobId))?.inkLimit).toBeUndefined();
  });

  it(`answers 413 for a body above ${String(INK_LIMIT_BODY_LIMIT)} bytes and leaves the job unchanged`, async () => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, SETTING);
    const before = await h.repository.get(jobId);

    const response = await put(h, jobId, { ...SETTING, pad: 'x'.repeat(INK_LIMIT_BODY_LIMIT) });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_request');
    expect(await h.repository.get(jobId)).toStrictEqual(before);
  });

  it('DELETE turns the ink limit off', async () => {
    const h = createHarness();
    const jobId = await createJob(h);
    await put(h, jobId, SETTING);

    const response = await remove(h, jobId);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ job: Record<string, unknown> }>().job).not.toHaveProperty('inkLimit');
    const stored = await h.repository.get(jobId);
    expect(stored !== undefined && 'inkLimit' in stored).toBe(false);
  });

  it('DELETE of a job without a setting leaves it off', async () => {
    const h = createHarness();
    const jobId = await createJob(h);

    const response = await remove(h, jobId);

    expect(response.statusCode).toBe(200);
    expect((await h.repository.get(jobId))?.inkLimit).toBeUndefined();
  });

  it('needs jobs:write, like the screening routes', async () => {
    const h = createHarness({ actor: VIEWER });
    const jobId = await createJob(h);

    const putResponse = await put(h, jobId, SETTING);
    const deleteResponse = await remove(h, jobId);

    expect(putResponse.statusCode).toBe(403);
    expect(putResponse.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:write' } } });
    expect(deleteResponse.statusCode).toBe(403);
    expect((await h.repository.get(jobId))?.inkLimit).toBeUndefined();
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
      expect((await other.repository.get(jobId))?.inkLimit).toBeUndefined();
    },
  );

  it('sets the setting of a job in the caller site', async () => {
    const h = createHarness({ siteScoped: true, actor: NORTH_OPERATOR });
    const jobId = await createJob(h, 'north');

    const response = await put(h, jobId, SETTING);

    expect(response.statusCode).toBe(200);
    expect((await h.repository.get(jobId))?.inkLimit).toEqual(SETTING);
  });

  it('documents both routes and the InkLimitSetting schema', async () => {
    const h = createHarness();

    const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    const spec = response.json<{
      info: { description: string };
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();
    const path = spec.paths['/jobs/{id}/ink-limit'];
    expect(path?.put?.operationId).toBe('setJobInkLimit');
    expect(Object.keys(path?.put?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '403', '404', '413']));
    expect(path?.delete?.operationId).toBe('clearJobInkLimit');
    expect(spec.components.schemas).toHaveProperty('InkLimitSetting');
    expect(spec.components.schemas).toHaveProperty('InkLimitJob');
    expect(spec.info.description).toContain('BPS_INK_LIMIT=1');
  });
});
