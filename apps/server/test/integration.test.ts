import type { FastifyInstance } from 'fastify';
import { ArchiveService, StaticColorSetupResolver, type DeviceMediaCatalog } from '@bax-print/archive';
import type { Actor } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { builtinRegistry } from '@bax-print/inspect';
import { summarize, type Finding, type InspectRequest, type Inspector, type PreflightReport } from '@bax-print/plugin-sdk';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { PreflightService } from '../src/preflight-service.js';
import { ProfileService } from '../src/profiles.js';
import { MemoryFindingsStore, MemoryProfileStore } from '../src/stores.js';
import { createServerHarness, DEVICE_A, fakeClock, finishedJob, MEDIUM_GLOSS, sequentialIds, TICKET } from './helpers.js';

/** Makes `authenticate` throw a plain `Error`, which the error handler must answer as an opaque 500. */
const FAIL_HEADER = 'x-test-fail';
const AT = '2026-11-04T09:00:00.000Z';
const GLOSS = { id: MEDIUM_GLOSS, name: 'Gloss vinyl' };

/** Reports one error finding, so every inspected job ends up held by preflight. */
class HoldingInspector implements Inspector {
  readonly id = 'org.bax-print.test.holding';
  readonly version = '0.0.0';

  async inspect(request: InspectRequest): Promise<PreflightReport> {
    const findings: Finding[] = [{ checkId: 'fonts', severity: 'error', message: 'Font Fixture is not embedded', data: {} }];
    return {
      inspector: { id: this.id, version: this.version },
      profileId: request.profileId,
      generatedAt: AT,
      pageCount: 1,
      findings,
      summary: summarize(findings),
      conformance: [],
    };
  }
}

interface Integrated {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
}

/** Archive, preflight and media services on one `buildServer` instance, sharing one job store and bus. */
function createIntegrated(catalog?: DeviceMediaCatalog): Integrated {
  const time = fakeClock(AT);
  const outbox = new MemoryOutbox();
  const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
  const repository = new MemoryJobRepository();
  const blobs = new MemoryStorage();
  const newId = sequentialIds('job');
  const jobs = new JobService({ jobs: repository, blobs, bus, clock: time.clock, newId });
  const archive = new ArchiveService({
    jobs: repository,
    index: new MemoryArchiveIndex(),
    blobs,
    archive: new MemoryStorage(),
    bus,
    outbox,
    colorSetups: new StaticColorSetupResolver(),
    catalog,
    clock: time.clock,
    newId,
  });
  const registry = builtinRegistry();
  const profiles = new ProfileService(new MemoryProfileStore(), registry);
  const preflight = new PreflightService({
    jobs: repository,
    findings: new MemoryFindingsStore(),
    profiles,
    events: jobs,
    inspector: new HoldingInspector(),
    blobPath: (key) => `/blobs/${key}`,
    spoolDir: '/spool',
    now: time.clock,
  });
  const media = new MediaService({ stores: memoryMediaStores(), bus, jobs: repository, clock: time.clock, newId: sequentialIds('m') });
  const app = buildServer({
    archive,
    preflight: { preflight, profiles, registry },
    media,
    authenticate: (request): Actor => {
      if (request.headers[FAIL_HEADER] !== undefined) throw new Error('authenticator backend is down');
      return { id: 'tester', role: 'admin' };
    },
  });
  return { app, jobs };
}

async function receivedJob(h: Integrated): Promise<string> {
  const job = await h.jobs.create({ name: 'Banner', sources: [{ name: 'banner.pdf', bytes: Buffer.from('%PDF-1.7 banner') }], ticket: TICKET });
  return job.id;
}

describe('one server for archive, preflight and media (Spec 007d)', () => {
  let h: Integrated;
  beforeEach(() => {
    h = createIntegrated();
  });

  it('serves the routes of all three specs', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/archive' })).json()).toMatchObject({ items: [] });
    expect((await h.app.inject({ method: 'GET', url: '/preflight-checks' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: '/media', payload: GLOSS })).statusCode).toBe(201);
    expect((await h.app.inject({ method: 'GET', url: '/media' })).json()).toHaveLength(1);
  });

  it('documents the media routes in /openapi.json and skips the undocumented ones', async () => {
    const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(document.paths)).toContain('/media/{id}');
    expect(Object.keys(document.paths)).not.toContain('/archive');
    expect(Object.keys(document.paths)).not.toContain('/preflight-profiles');
  });

  it('holds a job through preflight, clears it, then refuses to archive it while in production', async () => {
    const id = await receivedJob(h);
    const inspected = await h.app.inject({ method: 'POST', url: `/jobs/${id}/inspect` });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json()).toMatchObject({ jobId: id, status: 'held', hold: { reason: 'preflight' } });

    const cleared = await h.app.inject({ method: 'POST', url: `/jobs/${id}/preflight/override`, payload: { reason: 'Customer approved' } });
    expect(cleared.json()).toEqual({ jobId: id, status: 'ready' });

    const archived = await h.app.inject({ method: 'POST', url: `/jobs/${id}/archive` });
    expect(archived.statusCode).toBe(409);
    expect(archived.json()).toMatchObject({ error: { code: 'INVALID_LIFECYCLE', message: expect.any(String) } });
  });
});

describe('the shared error body', () => {
  let h: Integrated;
  beforeEach(() => {
    h = createIntegrated();
  });

  it('answers 400 with { error: { code, message, details? } } on every route family', async () => {
    const archive = await h.app.inject({ method: 'GET', url: '/archive?limit=0' });
    expect(archive.statusCode).toBe(400);
    expect(archive.json()).toEqual({ error: { code: 'INVALID_ARGUMENT', message: expect.any(String) } });

    const profile = await h.app.inject({ method: 'POST', url: '/preflight-profiles', payload: { id: 'x' } });
    expect(profile.statusCode).toBe(400);
    const body = profile.json<{ error: { code: string; message: string; details?: unknown } }>();
    expect(body.error).toMatchObject({ code: 'invalid_request', message: 'Invalid preflight profile' });
    expect(Array.isArray(body.error.details)).toBe(true);

    const media = await h.app.inject({ method: 'POST', url: '/media', payload: { attributes: {} } });
    expect(media.statusCode).toBe(400);
    expect(media.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.any(String) } });

    const malformed = await h.app.inject({
      method: 'POST',
      url: '/jobs/job-0001/preflight/override',
      payload: '{"reason":',
      headers: { 'content-type': 'application/json' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('answers 404 for unknown jobs, profiles, media and routes', async () => {
    const cases: [string, string, string][] = [
      ['GET', '/archive/job-9999', 'JOB_NOT_FOUND'],
      ['GET', '/jobs/job-9999/findings', 'not_found'],
      ['GET', '/preflight-profiles/nope', 'not_found'],
      ['GET', '/media/nope', 'not_found'],
      ['GET', '/no-such-route', 'not_found'],
    ];
    for (const [method, url, code] of cases) {
      const response = await h.app.inject({ method: method as 'GET', url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toEqual({ error: { code, message: expect.any(String) } });
    }
  });

  it('answers 409 for conflicts on every route family', async () => {
    const id = await receivedJob(h);
    const override = await h.app.inject({ method: 'POST', url: `/jobs/${id}/preflight/override`, payload: { reason: 'r' } });
    expect(override.statusCode).toBe(409);
    expect(override.json()).toEqual({ error: { code: 'conflict', message: `Job ${id} is not held by preflight` } });

    const builtin = await h.app.inject({ method: 'DELETE', url: '/preflight-profiles/default' });
    expect(builtin.statusCode).toBe(409);
    expect(builtin.json()).toMatchObject({ error: { code: 'conflict' } });

    await h.app.inject({ method: 'POST', url: '/media', payload: GLOSS });
    const duplicate = await h.app.inject({ method: 'POST', url: '/media', payload: GLOSS });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: 'conflict' } });

    const busy = await h.app.inject({ method: 'POST', url: `/jobs/${id}/archive` });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: 'INVALID_LIFECYCLE' } });
  });

  it('answers an unexpected failure with an opaque 500 on archive and preflight routes', async () => {
    const id = await receivedJob(h);
    for (const [method, url] of [
      ['POST', `/jobs/${id}/archive`],
      ['POST', `/jobs/${id}/inspect`],
    ] as const) {
      const response = await h.app.inject({ method, url, headers: { [FAIL_HEADER]: '1' } });
      expect(response.statusCode, url).toBe(500);
      expect(response.json(), url).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
    }
  });

  it('keeps the code and message of a deliberate 5xx', async () => {
    const id = await receivedJob(h);
    const response = await h.app.inject({ method: 'POST', url: `/jobs/${id}/normalize`, payload: { target: 'PDF/X-4' } });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({ error: { code: 'not_available', message: 'No normalization engine is configured' } });
  });
});

describe('RemapRequiredError on import', () => {
  it('puts the unknown devices and media in error.details with a 422', async () => {
    const source = createServerHarness();
    const jobId = await finishedJob(source, { name: 'Shop window', deviceId: DEVICE_A, mediumId: MEDIUM_GLOSS });
    expect((await source.app.inject({ method: 'POST', url: `/jobs/${jobId}/archive` })).statusCode).toBe(200);
    const bytes = (await source.app.inject({ method: 'GET', url: `/archive/${jobId}/package` })).rawPayload;

    const target = createIntegrated({ hasDevice: async () => false, hasMedium: async () => false });
    const response = await target.app.inject({
      method: 'POST',
      url: '/archive/import',
      payload: bytes,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: 'REMAP_REQUIRED',
        message: expect.any(String),
        details: { unknownDevices: [DEVICE_A], unknownMedia: [MEDIUM_GLOSS] },
      },
    });
  });
});
