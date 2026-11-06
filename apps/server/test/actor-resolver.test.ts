import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { createActorResolver, type ActorResolverOptions, type CredentialVerifier } from '../src/actor-resolver.js';
import { buildServer, type ServerDeps } from '../src/app.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { fakeClock, sequentialIds } from './helpers.js';

const NOW = '2026-03-01T08:00:00.000Z';
const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };
const ADMIN: Actor = { id: 'admin-1', role: 'admin' };
const SECRET = 'connection to credential store failed: password=hunter2';

interface FakeVerifier extends CredentialVerifier {
  /** `METHOD /url` of every request it was asked about. */
  readonly calls: readonly string[];
}

/** An in-test verifier that recognizes every caller as `actor`, or nobody when `actor` is undefined. */
function fakeVerifier(actor: Actor | undefined): FakeVerifier {
  const calls: string[] = [];
  return {
    calls,
    verify: (request) => {
      calls.push(`${request.method} ${request.url}`);
      return Promise.resolve(actor);
    },
  };
}

function failingVerifier(): CredentialVerifier {
  return { verify: () => Promise.reject(new Error(SECRET)) };
}

/** The archive, media and webhook routes, behind `authenticate` when one is given. */
function createApp(authenticate?: ServerDeps['authenticate']): FastifyInstance {
  const time = fakeClock(NOW);
  const outbox = new MemoryOutbox();
  const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
  const jobs = new MemoryJobRepository();
  const archive = new ArchiveService({
    jobs,
    index: new MemoryArchiveIndex(),
    blobs: new MemoryStorage(),
    archive: new MemoryStorage(),
    bus,
    outbox,
    colorSetups: new StaticColorSetupResolver(),
    clock: time.clock,
    newId: sequentialIds('pkg'),
  });
  return buildServer({
    archive,
    media: new MediaService({ stores: memoryMediaStores(), bus, jobs, clock: time.clock, newId: sequentialIds('m') }),
    webhooks: { bus },
    ...(authenticate ? { authenticate } : {}),
  });
}

describe('actor resolver (Spec 028c)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('resolves the actor of the first verifier that recognizes the caller', async () => {
    const miss = fakeVerifier(undefined);
    const hit = fakeVerifier(VIEWER);
    const after = fakeVerifier(ADMIN);
    app = createApp(createActorResolver({ verifiers: [miss, hit, after], fallback: 'deny' }));

    const read = await app.inject({ method: 'GET', url: '/trash' });
    const write = await app.inject({ method: 'PUT', url: '/jobs/job-1/legal-hold', payload: { hold: true } });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ items: [] });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'archive:write' } } });
    expect(miss.calls).toEqual(['GET /trash', 'PUT /jobs/job-1/legal-hold']);
    expect(hit.calls).toEqual(['GET /trash', 'PUT /jobs/job-1/legal-hold']);
    expect(after.calls).toEqual([]);
  });

  it('hands the verified actor to the route handlers', async () => {
    app = createApp(createActorResolver({ verifiers: [fakeVerifier(ADMIN)], fallback: 'deny' }));

    // The webhook routes check the admin role of the handler's actor as well as the guard's permission.
    const response = await app.inject({ method: 'GET', url: '/webhooks' });

    expect(response.statusCode).toBe(200);
  });

  it('treats an unrecognized caller as the local admin with the local-admin fallback', async () => {
    const miss = fakeVerifier(undefined);
    app = createApp(createActorResolver({ verifiers: [miss], fallback: 'local-admin' }));

    const response = await app.inject({ method: 'GET', url: '/webhooks' });

    expect(response.statusCode).toBe(200);
    expect(miss.calls).toEqual(['GET /webhooks']);
  });

  it('treats every caller as the local admin with no verifiers and the local-admin fallback', async () => {
    app = createApp(createActorResolver({ verifiers: [], fallback: 'local-admin' }));

    const response = await app.inject({ method: 'GET', url: '/webhooks' });

    expect(response.statusCode).toBe(200);
  });

  it('answers 401 unauthenticated to an unrecognized caller with the deny fallback, before any work', async () => {
    app = createApp(createActorResolver({ verifiers: [fakeVerifier(undefined)], fallback: 'deny' }));

    const read = await app.inject({ method: 'GET', url: '/trash' });
    const write = await app.inject({ method: 'PUT', url: '/jobs/job-1/legal-hold', payload: 'not json' });

    expect(read.statusCode).toBe(401);
    expect(read.json()).toEqual({ error: { code: 'unauthenticated', message: 'Authentication is required' } });
    expect(write.statusCode).toBe(401);
  });

  it('keeps the public routes and unknown URLs open with the deny fallback and asks no verifier', async () => {
    const miss = fakeVerifier(undefined);
    app = createApp(createActorResolver({ verifiers: [miss], fallback: 'deny' }));

    const openapi = await app.inject({ method: 'GET', url: '/openapi.json' });
    const unknown = await app.inject({ method: 'GET', url: '/no-such-route' });

    expect(openapi.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(404);
    expect(miss.calls).toEqual([]);
  });

  it('answers 500 without the reason when a verifier fails', async () => {
    const after = fakeVerifier(ADMIN);
    app = createApp(createActorResolver({ verifiers: [failingVerifier(), after], fallback: 'local-admin' }));

    const response = await app.inject({ method: 'GET', url: '/trash' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('credential store');
    // A failure is not a miss: neither a later verifier nor the fallback answers for the caller.
    expect(after.calls).toEqual([]);
  });

  it('rejects a fallback that is not one of the explicit choices', () => {
    const options: ActorResolverOptions = { verifiers: [], fallback: 'deny' };
    // A fallback read from parsed configuration may be any string at runtime.
    const misspelled = Object.assign({}, options, { fallback: 'allow' });

    expect(() => createActorResolver(misspelled)).toThrow(TypeError);
  });

  it('documents the 401 on guarded routes', async () => {
    app = createApp(createActorResolver({ verifiers: [], fallback: 'deny' }));

    const response = await app.inject({ method: 'GET', url: '/openapi.json' });

    const document = response.json<{
      info: { description: string };
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
    }>();
    expect(document.info.description).toContain('401 `unauthenticated`');
    expect(document.paths['/media']?.get?.responses['401']?.description).toContain('unauthenticated');
    expect(document.paths['/media']?.get?.responses['403']?.description).toContain('media:read');
  });
});

describe('authenticate (Spec 028c)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('still accepts a sync resolver', async () => {
    app = createApp(() => VIEWER);

    const read = await app.inject({ method: 'GET', url: '/trash' });
    const admin = await app.inject({ method: 'GET', url: '/webhooks' });

    expect(read.statusCode).toBe(200);
    expect(admin.statusCode).toBe(403);
  });

  it('answers 500 without the reason when a sync resolver throws', async () => {
    app = createApp(() => {
      throw new Error(SECRET);
    });

    const response = await app.inject({ method: 'GET', url: '/trash' });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('hunter2');
  });

  it('treats every caller as the local admin when nothing is configured', async () => {
    app = createApp();

    const response = await app.inject({ method: 'GET', url: '/webhooks' });

    expect(response.statusCode).toBe(200);
  });
});
