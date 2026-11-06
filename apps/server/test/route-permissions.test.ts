import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { BuiltinInspector, builtinRegistry } from '@bax-print/inspect';
import {
  MemoryArchiveIndex,
  MemoryJobRepository,
  MemoryStorage,
  openDatabase,
  SqliteApiTokenRepository,
  SqliteFinishingPlanRepository,
  SqliteLayoutTemplateRepository,
  type Database,
} from '@bax-print/store';
import { buildServer, localAdminWarning } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { PreflightService } from '../src/preflight-service.js';
import type { PrintOutput } from '../src/print-output.js';
import { ProfileService } from '../src/profiles.js';
import { isPublicRoute, guardRoutes, ROUTE_PERMISSIONS, routePermission, routesOf } from '../src/route-permissions.js';
import { registerErrorHandler } from '../src/routes.js';
import { MemoryFindingsStore, MemoryProfileStore } from '../src/stores.js';
import { fakeClock, sequentialIds } from './helpers.js';

const NOW = '2026-03-01T08:00:00.000Z';
const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };
const OPERATOR: Actor = { id: 'operator-1', role: 'operator' };
const ADMIN: Actor = { id: 'admin-1', role: 'admin' };

/**
 * A resolver may hand back a role outside `Role` at runtime, e.g. one it read from parsed data;
 * the intersection `Object.assign` returns models that without a cast.
 */
function actorWithRole(role: string): Actor {
  return Object.assign({}, VIEWER, { id: `${role}-1`, role });
}

const FINISHING_BODY = { steps: [{ kind: 'laminate' }] };

/** Spec 034a: mounts the print routes without a plugin process. */
const PRINT_OUTPUT: PrintOutput = {
  submit: async () => ({ outputJobId: 'out-1' }),
  status: async (outputJobId) => ({ outputJobId, state: 'queued' }),
  cancel: async (outputJobId) => ({ outputJobId, state: 'cancelled' }),
  close: async () => undefined,
};

interface Harness {
  readonly app: FastifyInstance;
  readonly db: Database;
}

/** A server with every optional route group mounted, as `main.ts` wires it with `BPS_DATABASE`. */
function createHarness(actor?: Actor): Harness {
  const time = fakeClock(NOW);
  const outbox = new MemoryOutbox();
  const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
  const jobs = new MemoryJobRepository();
  const blobs = new MemoryStorage();
  const archive = new ArchiveService({
    jobs,
    index: new MemoryArchiveIndex(),
    blobs,
    archive: new MemoryStorage(),
    bus,
    outbox,
    colorSetups: new StaticColorSetupResolver(),
    clock: time.clock,
    newId: sequentialIds('pkg'),
  });
  const registry = builtinRegistry();
  const profiles = new ProfileService(new MemoryProfileStore(), registry);
  const blobPath = (key: string): string => `/blobs/${key}`;
  const preflight = new PreflightService({
    jobs,
    findings: new MemoryFindingsStore(),
    profiles,
    events: new JobService({ jobs, blobs, bus, clock: time.clock, newId: sequentialIds('job') }),
    inspector: new BuiltinInspector({ registry }),
    blobPath,
    spoolDir: '/spool',
  });
  const db = openDatabase();
  const now = (): Date => new Date(NOW);
  const app = buildServer({
    archive,
    preflight: { preflight, profiles, registry },
    media: new MediaService({ stores: memoryMediaStores(), bus, jobs, clock: time.clock, newId: sequentialIds('m') }),
    webhooks: { bus },
    jobs,
    stepRepeat: { blobPath },
    proof: { blobPath },
    printOutput: { output: PRINT_OUTPUT, blobPath },
    layoutTemplates: new SqliteLayoutTemplateRepository(db),
    finishing: { plans: new SqliteFinishingPlanRepository(db, { now }), now },
    productionReport: { jobs },
    accounting: { jobs, reports: { list: async () => [] }, clock: time.clock },
    apiTokens: { tokens: new SqliteApiTokenRepository(db), now },
    swatchCharts: true,
    ...(actor ? { authenticate: () => actor } : {}),
  });
  return { app, db };
}

describe('route permissions (Spec 024b)', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.app.close();
    h?.db.close();
    h = undefined;
  });

  it('declares a permission for every registered route but the public ones', async () => {
    h = createHarness();
    await h.app.ready();

    const routes = routesOf(h.app);
    const undeclared = routes.filter((key) => {
      const [method = '', url = ''] = key.split(' ');
      return !isPublicRoute(method, url) && routePermission(method, url) === undefined;
    });

    expect(routes.length).toBeGreaterThan(0);
    expect(undeclared).toEqual([]);
    // No stale rows: every row of the table names a mounted route.
    expect(Object.keys(ROUTE_PERMISSIONS).filter((key) => !routes.includes(key))).toEqual([]);
  });

  it('denies every caller a route without a declared permission', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    guardRoutes(app, () => ADMIN);
    app.get('/undeclared', async () => ({ ok: true }));

    const response = await app.inject({ method: 'GET', url: '/undeclared' });
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('denies a viewer a write with 403 forbidden and details.permission, before any work', async () => {
    h = createHarness(VIEWER);

    const response = await h.app.inject({ method: 'PUT', url: '/jobs/job-1/finishing', payload: FINISHING_BODY });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'forbidden',
        message: 'PUT /jobs/:id/finishing requires the finishing:write permission',
        details: { permission: 'finishing:write' },
      },
    });
    expect((await h.app.inject({ method: 'GET', url: '/jobs/job-1/finishing' })).statusCode).toBe(404);
  });

  it('checks the permission before the body is validated', async () => {
    h = createHarness(VIEWER);

    const response = await h.app.inject({ method: 'PUT', url: '/jobs/job-1/finishing', payload: { steps: [] } });

    expect(response.statusCode).toBe(403);
  });

  it('allows a viewer a read', async () => {
    h = createHarness(VIEWER);

    const trash = await h.app.inject({ method: 'GET', url: '/trash' });
    const templates = await h.app.inject({ method: 'GET', url: '/layout-templates' });

    expect(trash.statusCode).toBe(200);
    expect(trash.json()).toEqual({ items: [] });
    expect(templates.statusCode).toBe(200);
  });

  it.each([
    ['an operator', OPERATOR],
    ['an admin', ADMIN],
  ])('allows %s a write', async (_name, actor) => {
    h = createHarness(actor);

    const response = await h.app.inject({ method: 'PUT', url: '/jobs/job-1/finishing', payload: FINISHING_BODY });

    expect(response.statusCode).toBe(201);
  });

  it('allows only an admin what the operator role lacks', async () => {
    h = createHarness(OPERATOR);
    const byOperator = await h.app.inject({ method: 'DELETE', url: '/layout-templates/no-such-template' });
    await h.app.close();
    h.db.close();

    h = createHarness(ADMIN);
    const byAdmin = await h.app.inject({ method: 'DELETE', url: '/layout-templates/no-such-template' });
    const webhooks = await h.app.inject({ method: 'GET', url: '/webhooks' });

    expect(byOperator.statusCode).toBe(403);
    expect(byOperator.json()).toMatchObject({ error: { details: { permission: 'layouts:delete' } } });
    expect(byAdmin.statusCode).toBe(404);
    expect(webhooks.statusCode).toBe(200);
  });

  it.each(['designer', 'guest', ''])('gives an actor with the unmapped role %j no permissions', async (role) => {
    h = createHarness(actorWithRole(role));

    const read = await h.app.inject({ method: 'GET', url: '/trash' });
    const write = await h.app.inject({ method: 'PUT', url: '/jobs/job-1/finishing', payload: FINISHING_BODY });

    expect(read.statusCode).toBe(403);
    expect(read.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'archive:read' } } });
    expect(write.statusCode).toBe(403);
  });

  it('serves the OpenAPI document to any caller and documents the 403s and the local admin default', async () => {
    h = createHarness(actorWithRole('guest'));

    const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(200);
    const document = response.json<{
      info: { description: string };
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
    }>();
    expect(document.info.description).toContain('local admin');
    expect(document.paths['/jobs/{id}/finishing']?.put?.responses['403']?.description).toContain('finishing:write');
    expect(document.paths['/media']?.get?.responses['403']?.description).toContain('media:read');
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.responses, `${method.toUpperCase()} ${path}`).toHaveProperty('403');
      }
    }
  });

  it('treats every caller as the local admin without a resolver', async () => {
    h = createHarness();

    const response = await h.app.inject({ method: 'GET', url: '/webhooks' });

    expect(response.statusCode).toBe(200);
  });
});

describe('localAdminWarning (Spec 024b)', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'])('is quiet on the loopback host %s', (host) => {
    expect(localAdminWarning({}, host)).toBeUndefined();
  });

  it.each(['0.0.0.0', '192.168.1.20', '::', 'print-server.local'])('warns on the non-loopback host %s', (host) => {
    expect(localAdminWarning({}, host)).toContain('local admin');
  });

  it('is quiet when a resolver is configured', () => {
    expect(localAdminWarning({ authenticate: () => ADMIN }, '0.0.0.0')).toBeUndefined();
  });
});
