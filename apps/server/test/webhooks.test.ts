import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor, Role } from '@bax-print/core';
import {
  EventBus,
  MemoryOutbox,
  verifySignature,
  WEBHOOK_SIGNATURE_HEADER,
  type CloudEvent,
  type WebhookRequest,
  type WebhookRetryScheduler,
  type WebhookTargetPolicy,
} from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage, openDatabase, SqliteWebhookSubscriptionRepository } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import type { WebhookSubscriptionStore } from '../src/stores.js';
import { parseAllowLanTargets } from '../src/webhook-routes.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { fakeClock, ROLE_HEADER, sequentialIds, TICKET, type FakeClock } from './helpers.js';

const SECRET = 'test-secret-not-real-0000';
const HOOK_URL = 'https://hooks.example.com/bps';
const ROLES: Readonly<Record<string, Role>> = { viewer: 'viewer', operator: 'operator', admin: 'admin' };

interface Scheduled {
  readonly delayMs: number;
  readonly fn: () => void;
  cancelled: boolean;
}

interface WebhookHarness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
  readonly time: FakeClock;
  /** Requests the fake `send` received, in order. */
  readonly requests: WebhookRequest[];
  /** Retries the fake scheduler holds; nothing runs until a test calls `fn`. */
  readonly scheduled: Scheduled[];
  /** HTTP statuses the fake endpoint answers with, consumed in order; then 204. */
  readonly statuses: number[];
}

/** A documentation-range address the guard treats as public. */
const PUBLIC_ADDRESS = '203.0.113.10';

/** Fake DNS: hosts map to answers; any other host resolves to `PUBLIC_ADDRESS`. No real lookups. */
function fakeResolver(answers: Readonly<Record<string, readonly string[]>> = {}): WebhookTargetPolicy['resolve'] {
  return async (host) => [...(answers[host] ?? [PUBLIC_ADDRESS])];
}

interface HarnessOptions {
  readonly resolve?: WebhookTargetPolicy['resolve'];
  readonly allowLanTargets?: boolean;
  readonly store?: WebhookSubscriptionStore;
}

/** Archive, job and media services on one bus, with webhooks on a fake `send`, resolver, clock and scheduler. */
function createWebhookHarness(options: HarnessOptions = {}): WebhookHarness {
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

  const requests: WebhookRequest[] = [];
  const scheduled: Scheduled[] = [];
  const statuses: number[] = [];
  const schedule: WebhookRetryScheduler = (delayMs, fn) => {
    const entry: Scheduled = { delayMs, fn, cancelled: false };
    scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  const app = buildServer({
    archive,
    media,
    webhooks: {
      bus,
      send: async (request) => {
        requests.push(request);
        return { status: statuses.shift() ?? 204 };
      },
      resolve: options.resolve ?? fakeResolver(),
      ...(options.allowLanTargets !== undefined ? { allowLanTargets: options.allowLanTargets } : {}),
      ...(options.store !== undefined ? { store: options.store } : {}),
      now: () => time.clock().getTime(),
      schedule,
      newId: sequentialIds('wh'),
    },
    authenticate: (request): Actor => {
      const header = request.headers[ROLE_HEADER];
      return { id: 'tester', role: (typeof header === 'string' ? ROLES[header] : undefined) ?? 'admin' };
    },
  });
  return { app, jobs, time, requests, scheduled, statuses };
}

/** Lets the fake sends (which resolve immediately) and the delivery log writes finish. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function createJob(h: WebhookHarness, name = 'Shop window'): Promise<string> {
  const job = await h.jobs.create({ name, sources: [{ name: `${name}.pdf`, bytes: Buffer.from(`%PDF-1.7 ${name}`) }], ticket: TICKET });
  await settle();
  return job.id;
}

async function subscribe(h: WebhookHarness, body: Record<string, unknown> = {}): Promise<{ id: string }> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/webhooks',
    payload: { url: HOOK_URL, secret: SECRET, eventTypes: ['job.created'], ...body },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>();
}

function parseEvent(request: WebhookRequest | undefined): CloudEvent | undefined {
  return request === undefined ? undefined : (JSON.parse(request.body) as CloudEvent);
}

describe('webhook routes (Spec 019b)', () => {
  let h: WebhookHarness;

  beforeEach(() => {
    h = createWebhookHarness();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('creates a subscription and never returns its secret', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: { url: HOOK_URL, secret: SECRET, eventTypes: ['job.created', 'job.status.changed'] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: 'wh-0001', url: HOOK_URL, eventTypes: ['job.created', 'job.status.changed'], active: true });
    expect(created.body).not.toContain(SECRET);

    await subscribe(h, { id: 'paused', eventTypes: ['*'], active: false });
    const listed = await h.app.inject({ method: 'GET', url: '/webhooks' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        { id: 'paused', url: HOOK_URL, eventTypes: ['*'], active: false },
        { id: 'wh-0001', url: HOOK_URL, eventTypes: ['job.created', 'job.status.changed'], active: true },
      ],
    });
    expect(listed.body).not.toContain(SECRET);
  });

  it('rejects invalid subscriptions with the error envelope', async () => {
    const plainHttp = await h.app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: { url: 'http://hooks.example.com/bps', secret: SECRET, eventTypes: ['*'] },
    });
    expect(plainHttp.statusCode).toBe(400);
    expect(plainHttp.json()).toEqual({ error: { code: 'INVALID_WEBHOOK_SUBSCRIPTION', message: expect.stringContaining('https') } });

    const shortSecret = await h.app.inject({ method: 'POST', url: '/webhooks', payload: { url: HOOK_URL, secret: 'short', eventTypes: ['*'] } });
    expect(shortSecret.statusCode).toBe(400);
    expect(shortSecret.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const noTypes = await h.app.inject({ method: 'POST', url: '/webhooks', payload: { url: HOOK_URL, secret: SECRET, eventTypes: [] } });
    expect(noTypes.statusCode).toBe(400);
    expect(noTypes.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const listed = await h.app.inject({ method: 'GET', url: '/webhooks' });
    expect(listed.json()).toEqual({ items: [] });
  });

  it('answers 409 for an id in use', async () => {
    await subscribe(h, { id: 'erp' });
    const again = await h.app.inject({ method: 'POST', url: '/webhooks', payload: { id: 'erp', url: HOOK_URL, secret: SECRET, eventTypes: ['*'] } });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: { code: 'conflict', message: 'Webhook subscription erp already exists' } });
  });

  it('limits webhook management to admins', async () => {
    await subscribe(h, { id: 'erp' });
    const headers = { [ROLE_HEADER]: 'operator' };
    const requests = [
      { method: 'POST' as const, url: '/webhooks', payload: { url: HOOK_URL, secret: SECRET, eventTypes: ['*'] } },
      { method: 'GET' as const, url: '/webhooks' },
      { method: 'DELETE' as const, url: '/webhooks/erp' },
      { method: 'GET' as const, url: '/webhooks/erp/deliveries' },
    ];
    for (const request of requests) {
      const response = await h.app.inject({ ...request, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it('deletes a subscription and answers 404 for unknown ids', async () => {
    await subscribe(h, { id: 'erp' });
    expect((await h.app.inject({ method: 'DELETE', url: '/webhooks/erp' })).statusCode).toBe(204);

    const gone = await h.app.inject({ method: 'DELETE', url: '/webhooks/erp' });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ error: { code: 'not_found', message: 'Webhook subscription erp not found' } });
    expect((await h.app.inject({ method: 'GET', url: '/webhooks/erp/deliveries' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/webhooks' })).json()).toEqual({ items: [] });
  });

  it('delivers a signed job.created event and logs the attempt', async () => {
    const { id } = await subscribe(h);

    const jobId = await createJob(h);

    expect(h.requests).toHaveLength(1);
    const [request] = h.requests;
    expect(request?.url).toBe(HOOK_URL);
    expect(parseEvent(request)).toMatchObject({ type: 'job.created', subject: jobId, data: { jobId } });
    const nowSeconds = Math.floor(h.time.clock().getTime() / 1_000);
    expect(verifySignature(SECRET, request?.headers[WEBHOOK_SIGNATURE_HEADER] ?? '', request?.body ?? '', nowSeconds)).toBe(true);

    const deliveries = await h.app.inject({ method: 'GET', url: `/webhooks/${id}/deliveries` });
    expect(deliveries.statusCode).toBe(200);
    expect(deliveries.json()).toEqual({
      items: [{ subscriptionId: id, eventId: parseEvent(request)?.id, attempt: 1, ok: true, status: 204, at: '2026-03-01T08:00:00.000Z' }],
    });
    expect(deliveries.body).not.toContain(SECRET);
  });

  it('skips inactive and non-matching subscriptions', async () => {
    await subscribe(h, { id: 'paused', eventTypes: ['*'], active: false });
    await subscribe(h, { id: 'status-only', eventTypes: ['job.status.changed'] });

    const jobId = await createJob(h);
    expect(h.requests).toHaveLength(0);

    await h.jobs.setStatus(jobId, 'inspecting');
    await settle();
    expect(h.requests.map((request) => parseEvent(request)?.type)).toEqual(['job.status.changed']);
  });

  it('retries a failed delivery on the injected scheduler', async () => {
    const { id } = await subscribe(h);
    h.statuses.push(503);

    await createJob(h);
    expect(h.scheduled.map((entry) => entry.delayMs)).toEqual([1_000]);

    h.time.advance(1_000);
    h.scheduled[0]?.fn();
    await settle();

    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.body).toBe(h.requests[0]?.body);
    const deliveries = (await h.app.inject({ method: 'GET', url: `/webhooks/${id}/deliveries` })).json<{ items: unknown[] }>();
    expect(deliveries.items).toEqual([
      expect.objectContaining({ attempt: 1, ok: false, status: 503, error: 'webhook endpoint answered HTTP 503', at: '2026-03-01T08:00:00.000Z' }),
      expect.objectContaining({ attempt: 2, ok: true, status: 204, at: '2026-03-01T08:00:01.000Z' }),
    ]);
  });

  it('drops scheduled retries of a deleted subscription', async () => {
    await subscribe(h, { id: 'erp' });
    h.statuses.push(500);
    await createJob(h);
    expect(h.scheduled).toHaveLength(1);

    await h.app.inject({ method: 'DELETE', url: '/webhooks/erp' });
    h.scheduled[0]?.fn();
    await settle();

    expect(h.requests).toHaveLength(1);
  });

  it('stops dispatching and cancels retries when the app closes', async () => {
    await subscribe(h);
    h.statuses.push(500);
    await createJob(h, 'First');

    await h.app.close();
    expect(h.scheduled.every((entry) => entry.cancelled)).toBe(true);

    await createJob(h, 'Second');
    expect(h.requests).toHaveLength(1);
    // `afterEach` closes `h.app`; give it an open app rather than closing this one twice.
    h = createWebhookHarness();
  });

  it('documents the webhook routes in /openapi.json without the secret in any response', async () => {
    const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: { properties: Record<string, unknown> } }> } }>>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    }>();

    expect(Object.keys(document.paths['/webhooks'] ?? {}).sort()).toEqual(['get', 'post']);
    expect(Object.keys(document.paths['/webhooks/{id}'] ?? {})).toEqual(['delete']);
    expect(Object.keys(document.paths['/webhooks/{id}/deliveries'] ?? {})).toEqual(['get']);
    const requestSchema = document.paths['/webhooks']?.post?.requestBody?.content['application/json']?.schema;
    expect(requestSchema?.properties.secret).toMatchObject({ type: 'string', writeOnly: true });
    expect(document.components.schemas.WebhookSubscription?.properties).not.toHaveProperty('secret');
    expect(document.components.schemas.WebhookDelivery?.properties).toHaveProperty('attempt');
  });
});

describe('webhook target guard (Spec 019c)', () => {
  let h: WebhookHarness;

  afterEach(async () => {
    await h.app.close();
  });

  async function post(url: string): Promise<{ statusCode: number; json: () => unknown }> {
    return h.app.inject({ method: 'POST', url: '/webhooks', payload: { url, secret: SECRET, eventTypes: ['*'] } });
  }

  it('answers 400 with the error envelope for blocked targets and stores nothing', async () => {
    h = createWebhookHarness({ resolve: fakeResolver({ 'mixed.example.com': [PUBLIC_ADDRESS, '10.1.2.3'], 'void.example.com': [] }) });
    for (const url of [
      'https://10.0.0.5/hook',
      'https://169.254.169.254/latest',
      'https://[::ffff:192.168.0.1]/hook',
      'https://[fd00::1]/hook',
      'https://mixed.example.com/hook',
      'https://void.example.com/hook',
    ]) {
      const response = await post(url);
      expect(response.statusCode, url).toBe(400);
      expect(response.json(), url).toEqual({ error: { code: 'BLOCKED_WEBHOOK_DESTINATION', message: expect.any(String) } });
    }
    expect((await h.app.inject({ method: 'GET', url: '/webhooks' })).json()).toEqual({ items: [] });
  });

  it('answers 400 when the host cannot be resolved', async () => {
    h = createWebhookHarness({
      resolve: async () => {
        throw new Error('no such host');
      },
    });
    const response = await post(HOOK_URL);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_request', message: 'webhook subscription "url" host could not be resolved' } });
  });

  it('keeps the localhost development allowance', async () => {
    h = createWebhookHarness({ resolve: fakeResolver({ localhost: ['127.0.0.1', '::1'] }) });
    expect((await post('http://localhost:9000/hook')).statusCode).toBe(201);
    expect((await post('http://127.0.0.1:9000/hook')).statusCode).toBe(201);
  });

  it('accepts private targets only with allowLanTargets', async () => {
    h = createWebhookHarness({ allowLanTargets: true });
    expect((await post('https://192.168.10.20/hook')).statusCode).toBe(201);
    expect((await post('https://169.254.1.1/hook')).statusCode).toBe(400);
  });

  it('records a blocked delivery as one failed attempt with no retry and no request', async () => {
    const answers = new Map<string, string[]>([['hooks.example.com', [PUBLIC_ADDRESS]]]);
    h = createWebhookHarness({ resolve: async (host) => [...(answers.get(host) ?? [])] });
    const { id } = await subscribe(h);

    // The name now answers with a private address (DNS rebinding).
    answers.set('hooks.example.com', ['10.0.0.7']);
    await createJob(h);

    expect(h.requests).toHaveLength(0);
    expect(h.scheduled).toHaveLength(0);
    const deliveries = (await h.app.inject({ method: 'GET', url: `/webhooks/${id}/deliveries` })).json<{ items: unknown[] }>();
    expect(deliveries.items).toEqual([expect.objectContaining({ attempt: 1, ok: false, error: 'blocked-destination' })]);
  });

  it('keeps subscriptions in a SQLite database across server instances', async () => {
    const db = openDatabase();
    h = createWebhookHarness({ store: new SqliteWebhookSubscriptionRepository(db) });
    const { id } = await subscribe(h, { eventTypes: ['job.created'] });
    await h.app.close();

    h = createWebhookHarness({ store: new SqliteWebhookSubscriptionRepository(db) });
    const listed = await h.app.inject({ method: 'GET', url: '/webhooks' });
    expect(listed.json()).toEqual({ items: [{ id, url: HOOK_URL, eventTypes: ['job.created'], active: true }] });
    expect(listed.body).not.toContain(SECRET);

    await createJob(h);
    const [request] = h.requests;
    const nowSeconds = Math.floor(h.time.clock().getTime() / 1_000);
    expect(verifySignature(SECRET, request?.headers[WEBHOOK_SIGNATURE_HEADER] ?? '', request?.body ?? '', nowSeconds)).toBe(true);
    db.close();
  });
});

describe('parseAllowLanTargets', () => {
  it('defaults to false and accepts only true/false/1/0', () => {
    expect(parseAllowLanTargets(undefined)).toBe(false);
    expect(parseAllowLanTargets('')).toBe(false);
    expect(parseAllowLanTargets('false')).toBe(false);
    expect(parseAllowLanTargets('0')).toBe(false);
    expect(parseAllowLanTargets('true')).toBe(true);
    expect(parseAllowLanTargets(' TRUE ')).toBe(true);
    expect(parseAllowLanTargets('1')).toBe(true);
    expect(() => parseAllowLanTargets('yes')).toThrow(RangeError);
  });
});

describe('buildServer without webhooks', () => {
  it('does not mount the webhook routes', async () => {
    const outbox = new MemoryOutbox();
    const archive = new ArchiveService({
      jobs: new MemoryJobRepository(),
      index: new MemoryArchiveIndex(),
      blobs: new MemoryStorage(),
      archive: new MemoryStorage(),
      bus: new EventBus(outbox),
      outbox,
      colorSetups: new StaticColorSetupResolver(),
    });
    const app = buildServer({ archive });

    expect((await app.inject({ method: 'GET', url: '/webhooks' })).statusCode).toBe(404);
    await app.close();
  });
});
