import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { issueApiToken, type Permission } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import {
  MemoryArchiveIndex,
  MemoryJobRepository,
  MemoryStorage,
  openDatabase,
  SqliteApiTokenRepository,
  type Database,
} from '@bax-print/store';
import { createActorResolver, type ActorResolver, type ActorResolverFallback } from '../src/actor-resolver.js';
import { configureApiTokens, parseApiTokensFlag, parseAuthFallback } from '../src/api-token-config.js';
import type { PublicApiToken } from '../src/api-token-routes.js';
import { buildServer } from '../src/app.js';
import { createBearerTokenVerifier } from '../src/bearer-token-verifier.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { fakeClock, sequentialIds } from './helpers.js';

const NOW = '2026-03-01T08:00:00.000Z';
const LATER = '2026-03-01T09:00:00.000Z';

interface Issued {
  readonly token: PublicApiToken;
  readonly secret: string;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly db: Database;
  setNow(iso: string): void;
}

type ResolverFactory = (tokens: SqliteApiTokenRepository, now: () => Date) => ActorResolver;

const withVerifier =
  (fallback: ActorResolverFallback): ResolverFactory =>
  (tokens, now) =>
    createActorResolver({ verifiers: [createBearerTokenVerifier({ tokens, now })], fallback });

/** The archive, media, webhook and API token routes over an in-memory job database. */
function createHarness(resolver: ResolverFactory = withVerifier('local-admin')): Harness {
  const db = openDatabase();
  const tokens = new SqliteApiTokenRepository(db);
  let current = new Date(NOW);
  const now = (): Date => current;
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
  const app = buildServer({
    archive,
    media: new MediaService({ stores: memoryMediaStores(), bus, jobs, clock: time.clock, newId: sequentialIds('m') }),
    webhooks: { bus },
    apiTokens: { tokens, now },
    authenticate: resolver(tokens, now),
  });
  return {
    app,
    db,
    setNow: (iso) => {
      current = new Date(iso);
    },
  };
}

const bearer = (secret: string): Record<string, string> => ({ authorization: `Bearer ${secret}` });

async function issue(app: FastifyInstance, payload: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Issued> {
  const response = await app.inject({ method: 'POST', url: '/api-tokens', payload, headers });
  expect(response.statusCode).toBe(201);
  return response.json<Issued>();
}

describe('API token routes (Spec 029c)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.app.close();
    harness?.db.close();
    harness = undefined;
  });

  it('issues a token and answers its secret once', async () => {
    harness = createHarness();

    const issued = await issue(harness.app, { name: 'ci', scopes: ['jobs:read', 'archive:read', 'jobs:read'] });

    const { id, ...rest } = issued.token;
    expect(issued.secret).toMatch(/^bps_[A-Za-z0-9_-]{43}$/);
    expect(id).toMatch(/\S/);
    expect(rest).toEqual({
      name: 'ci',
      prefix: issued.secret.slice(4, 12),
      scopes: ['archive:read', 'jobs:read'],
      createdAt: NOW,
    });
    expect(issued.token).not.toHaveProperty('secretHash');
  });

  it('lists tokens without secrets or hashes', async () => {
    harness = createHarness();
    const issued = await issue(harness.app, { name: 'ci', scopes: ['jobs:read'], expiresAt: LATER });

    const response = await harness.app.inject({ method: 'GET', url: '/api-tokens' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ ...issued.token, expiresAt: LATER }] });
    expect(response.body).not.toContain(issued.secret);
    expect(response.body).not.toContain('secretHash');
  });

  it('revokes a token, keeps the first revocation time and answers 404 for an unknown id', async () => {
    harness = createHarness();
    const { token } = await issue(harness.app, { name: 'ci', scopes: ['jobs:read'] });

    const first = await harness.app.inject({ method: 'DELETE', url: `/api-tokens/${token.id}` });
    harness.setNow(LATER);
    const second = await harness.app.inject({ method: 'DELETE', url: `/api-tokens/${token.id}` });
    const unknown = await harness.app.inject({ method: 'DELETE', url: '/api-tokens/no-such-token' });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ token: { ...token, revokedAt: NOW } });
    expect(second.json()).toEqual({ token: { ...token, revokedAt: NOW } });
    expect(unknown.statusCode).toBe(404);
  });

  it('answers 400 for invalid names, scopes and expiries', async () => {
    harness = createHarness();
    const bodies: unknown[] = [
      { scopes: ['jobs:read'] },
      { name: ' ', scopes: ['jobs:read'] },
      { name: 'ci', scopes: [] },
      { name: 'ci', scopes: ['jobs:fly'] },
      { name: 'ci', scopes: 'jobs:read' },
      { name: 'ci', scopes: ['jobs:read'], expiresAt: 'tomorrow' },
      { name: 'ci', scopes: ['jobs:read'], expiresAt: NOW },
      [],
    ];

    for (const payload of bodies) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api-tokens',
        payload: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const list = await harness.app.inject({ method: 'GET', url: '/api-tokens' });
    expect(list.json()).toEqual({ items: [] });
  });

  it('documents the token routes and keeps secrets out of every schema but the issue answer', async () => {
    harness = createHarness();

    const response = await harness.app.inject({ method: 'GET', url: '/openapi.json' });

    const document = response.json<{
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    }>();
    expect(document.paths['/api-tokens']?.post?.responses['403']?.description).toContain('scopes');
    expect(document.paths['/api-tokens']?.get?.responses['403']?.description).toContain('webhooks:read');
    expect(document.paths['/api-tokens/{id}']?.delete?.responses['403']?.description).toContain('webhooks:delete');
    expect(document.components.schemas.ApiToken?.properties).not.toHaveProperty('secretHash');
    expect(document.components.schemas.ApiToken?.properties).not.toHaveProperty('secret');
    expect(document.components.schemas.IssuedApiToken?.properties).toHaveProperty('secret');
  });
});

describe('bearer token verifier (Spec 029c)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.app.close();
    harness?.db.close();
    harness = undefined;
  });

  it('allows a valid token what its scopes allow', async () => {
    harness = createHarness(withVerifier('deny'));
    // Issued by a token holding every scope it hands out.
    const admin = await adminToken(harness);
    const { secret } = await issue(harness.app, { name: 'reader', scopes: ['archive:read'] }, bearer(admin));

    const response = await harness.app.inject({ method: 'GET', url: '/trash', headers: bearer(secret) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it('accepts the scheme in any case', async () => {
    harness = createHarness(withVerifier('deny'));
    const secret = await adminToken(harness);

    const response = await harness.app.inject({ method: 'GET', url: '/trash', headers: { authorization: `bEaReR   ${secret}` } });

    expect(response.statusCode).toBe(200);
  });

  it('answers 403 for a permission outside the token scopes, whatever role would allow', async () => {
    harness = createHarness();
    const { secret } = await issue(harness.app, { name: 'reader', scopes: ['archive:read', 'jobs:read'] });

    const write = await harness.app.inject({ method: 'PUT', url: '/jobs/job-1/legal-hold', payload: { hold: true }, headers: bearer(secret) });
    const tokens = await harness.app.inject({ method: 'GET', url: '/api-tokens', headers: bearer(secret) });

    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'archive:write' } } });
    expect(tokens.statusCode).toBe(403);
    expect(tokens.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'webhooks:read' } } });
  });

  it('lets an admin-scoped token pass the handlers that check the admin role', async () => {
    harness = createHarness();
    const { secret } = await issue(harness.app, { name: 'hooks', scopes: ['webhooks:read'] });

    const response = await harness.app.inject({ method: 'GET', url: '/webhooks', headers: bearer(secret) });

    expect(response.statusCode).toBe(200);
  });

  it('never lets a token issue a scope it does not hold', async () => {
    harness = createHarness();
    const { secret } = await issue(harness.app, { name: 'minter', scopes: ['archive:read', 'webhooks:write'] });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api-tokens',
      payload: { name: 'broader', scopes: ['archive:read', 'archive:write'] },
      headers: bearer(secret),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'archive:write' } } });
    const allowed = await issue(harness.app, { name: 'narrower', scopes: ['archive:read'] }, bearer(secret));
    expect(allowed.token.scopes).toEqual(['archive:read']);
  });

  it('answers 401 for a revoked token and does not fall back to the local admin', async () => {
    harness = createHarness();
    const { token, secret } = await issue(harness.app, { name: 'ci', scopes: ['archive:read'] });
    await harness.app.inject({ method: 'DELETE', url: `/api-tokens/${token.id}` });

    const response = await harness.app.inject({ method: 'GET', url: '/trash', headers: bearer(secret) });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: 'unauthenticated', message: 'The API token is not valid' } });
  });

  it('answers 401 for a token from its expiry onward', async () => {
    harness = createHarness();
    const { secret } = await issue(harness.app, { name: 'ci', scopes: ['archive:read'], expiresAt: LATER });

    const before = await harness.app.inject({ method: 'GET', url: '/trash', headers: bearer(secret) });
    harness.setNow(LATER);
    const after = await harness.app.inject({ method: 'GET', url: '/trash', headers: bearer(secret) });

    expect(before.statusCode).toBe(200);
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('answers 401 for garbage, unknown and wrong bearer tokens', async () => {
    harness = createHarness();
    const { secret } = await issue(harness.app, { name: 'ci', scopes: ['archive:read'] });
    // Same lookup prefix, different secret.
    const wrong = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
    const unknown = `bps_${'x'.repeat(43)}`;
    const presented = ['bps_', 'bps_garbage', `${secret} trailing`, wrong, unknown];

    // The harness falls back to the local admin, so a 401 shows the bad token was not treated as anonymous.
    for (const credential of presented) {
      const response = await harness.app.inject({ method: 'GET', url: '/trash', headers: bearer(credential) });
      expect(response.statusCode, credential).toBe(401);
      expect(response.json()).toEqual({ error: { code: 'unauthenticated', message: 'The API token is not valid' } });
    }
  });

  it('ignores a request without a bearer API token', async () => {
    const requests: InjectOptions[] = [
      { method: 'GET', url: '/trash' },
      { method: 'GET', url: '/trash', headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      { method: 'GET', url: '/trash', headers: { authorization: 'Bearer some-other-token' } },
      { method: 'GET', url: '/trash', headers: { authorization: 'bps_notbearer' } },
    ];

    harness = createHarness(withVerifier('local-admin'));
    for (const request of requests) {
      const response = await harness.app.inject(request);
      expect(response.statusCode, JSON.stringify(request.headers)).toBe(200);
    }
    await harness.app.close();
    harness.db.close();

    harness = createHarness(withVerifier('deny'));
    for (const request of requests) {
      const response = await harness.app.inject(request);
      expect(response.statusCode, JSON.stringify(request.headers)).toBe(401);
      expect(response.json()).toEqual({ error: { code: 'unauthenticated', message: 'Authentication is required' } });
    }
  });
});

/** A token for the archive and token routes, saved straight to the store: a `deny` harness has no caller to issue it. */
function adminToken(harness: Harness): string {
  const scopes: Permission[] = ['archive:read', 'webhooks:delete', 'webhooks:read', 'webhooks:write'];
  const issued = issueApiToken({ name: 'admin', scopes, now: new Date(NOW) });
  new SqliteApiTokenRepository(harness.db).save(issued.record);
  return issued.secret;
}

describe('API token flags (Spec 029c)', () => {
  it('turns tokens on only for BPS_API_TOKENS=1', () => {
    expect(parseApiTokensFlag(undefined)).toBe(false);
    expect(parseApiTokensFlag('1')).toBe(true);
    for (const value of ['', '0', 'true', 'yes', ' 1']) {
      expect(() => parseApiTokensFlag(value), value).toThrow(/BPS_API_TOKENS/);
    }
  });

  it('keeps the local admin fallback unless BPS_AUTH_FALLBACK=deny', () => {
    expect(parseAuthFallback(undefined)).toBe('local-admin');
    expect(parseAuthFallback('local-admin')).toBe('local-admin');
    expect(parseAuthFallback('deny')).toBe('deny');
    for (const value of ['', 'allow', 'DENY']) {
      expect(() => parseAuthFallback(value), value).toThrow(/BPS_AUTH_FALLBACK/);
    }
  });

  it('changes nothing when no flag is set, with or without a database', () => {
    const db = openDatabase();
    try {
      expect(configureApiTokens({}, undefined)).toEqual({});
      expect(configureApiTokens({}, new SqliteApiTokenRepository(db))).toEqual({});
    } finally {
      db.close();
    }
  });

  it('refuses to start with tokens but no database, or deny without tokens', () => {
    const db = openDatabase();
    try {
      expect(() => configureApiTokens({ BPS_API_TOKENS: '1' }, undefined)).toThrow(/BPS_DATABASE/);
      expect(() => configureApiTokens({ BPS_AUTH_FALLBACK: 'deny' }, new SqliteApiTokenRepository(db))).toThrow(/BPS_API_TOKENS=1/);
      expect(() => configureApiTokens({ BPS_API_TOKENS: 'on' }, new SqliteApiTokenRepository(db))).toThrow(/BPS_API_TOKENS/);
    } finally {
      db.close();
    }
  });

  it('enables the routes and the verifier with BPS_API_TOKENS=1 and a database', async () => {
    let harness: Harness | undefined;
    try {
      for (const [env, anonymous] of [
        [{ BPS_API_TOKENS: '1' }, 200],
        [{ BPS_API_TOKENS: '1', BPS_AUTH_FALLBACK: 'deny' }, 401],
      ] as const) {
        harness = createHarness((tokens, now) => {
          const config = configureApiTokens(env, tokens, now);
          expect(config.enabled?.apiTokens.tokens).toBe(tokens);
          if (config.enabled === undefined) throw new Error('API tokens are not enabled');
          return config.enabled.authenticate;
        });
        const secret = adminToken(harness);

        const withToken = await harness.app.inject({ method: 'GET', url: '/api-tokens', headers: bearer(secret) });
        const without = await harness.app.inject({ method: 'GET', url: '/trash' });

        expect(withToken.statusCode).toBe(200);
        expect(without.statusCode).toBe(anonymous);
        await harness.app.close();
        harness.db.close();
        harness = undefined;
      }
    } finally {
      await harness?.app.close();
      harness?.db.close();
    }
  });
});
