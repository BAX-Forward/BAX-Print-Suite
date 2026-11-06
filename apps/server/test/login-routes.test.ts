import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { createUserAccount, hashPassword, type Actor, type PermissionRole, type UserAccount } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage, openDatabase, SqliteUserRepository, type Database } from '@bax-print/store';
import type { CredentialVerifier } from '../src/actor-resolver.js';
import { buildServer, type ServerDeps } from '../src/app.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { configureLogin, parseSessionConfig, SessionConfigError } from '../src/session-config.js';
import { createSessionVerifier, loginActorResolver, MemorySessionStore } from '../src/sessions.js';
import { fakeClock, sequentialIds } from './helpers.js';

const NOW = '2026-03-01T08:00:00.000Z';
const TTL_MS = 60_000;
const PASSWORD = 'correct horse battery';
// Cheap scrypt parameters keep the tests fast; production hashes use the core defaults.
const TEST_SCRYPT = { N: 16, r: 1, p: 1 };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LOGIN_FAILED = { error: { code: 'unauthenticated', message: 'Username or password is incorrect' } };
const UNAUTHENTICATED = { error: { code: 'unauthenticated', message: 'Authentication is required' } };
const OUTSIDER: Actor = { id: 'outsider-1', role: 'admin' };

interface LoginResult {
  readonly token?: string;
  readonly expiresAt: string;
  readonly user: Record<string, unknown>;
}

interface FakeVerifier extends CredentialVerifier {
  readonly calls: readonly string[];
}

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

/** The archive, media and webhook routes with `deps` added. */
function createApp(deps: Pick<ServerDeps, 'login' | 'authenticate'>): FastifyInstance {
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
    ...deps,
  });
}

interface Harness {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly users: SqliteUserRepository;
  /** Milliseconds since the epoch the session store reads as now. */
  readonly clock: { ms: number };
}

interface HarnessOptions {
  readonly cookie?: boolean;
  /** Verifiers after the session verifier; without them the server is wired as `main.ts` wires it. */
  readonly verifiers?: readonly CredentialVerifier[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const db = openDatabase();
  const users = new SqliteUserRepository(db);
  const clock = { ms: Date.parse(NOW) };
  const sessions = new MemorySessionStore({ ttlMs: TTL_MS, now: () => new Date(clock.ms) });
  const deps = configureLogin({ enabled: true, cookie: options.cookie ?? false }, db, sessions);
  const app =
    options.verifiers === undefined
      ? createApp(deps)
      : createApp({ ...deps, authenticate: loginActorResolver(createSessionVerifier({ users, sessions }), options.verifiers) });
  return { app, db, users, clock };
}

async function addUser(users: SqliteUserRepository, username: string, roles: readonly PermissionRole[], disabled = false): Promise<UserAccount> {
  const passwordHash = await hashPassword(PASSWORD, { params: TEST_SCRYPT });
  const input = { username, displayName: username, roles, passwordHash };
  return users.create(createUserAccount(disabled ? { ...input, disabledAt: new Date(NOW) } : input, new Date(NOW)));
}

function login(app: FastifyInstance, username: string, password = PASSWORD): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/login', payload: { username, password } });
}

async function tokenFor(app: FastifyInstance, username: string): Promise<string> {
  return (await login(app, username)).json<LoginResult>().token ?? '';
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

function cookieToken(header: unknown): string {
  return /^bps_session=([A-Za-z0-9_-]{43});/.exec(String(header))?.[1] ?? '';
}

describe('parseSessionConfig (Spec 028d)', () => {
  it('is off when nothing is set', () => {
    expect(parseSessionConfig({})).toEqual({ enabled: false });
    expect(parseSessionConfig({ BPS_DATABASE: 'data/jobs.db' })).toEqual({ enabled: false });
  });

  it('is on with BPS_LOGIN=1 and BPS_DATABASE, returning the token in JSON unless BPS_COOKIE=1', () => {
    expect(parseSessionConfig({ BPS_LOGIN: '1', BPS_DATABASE: 'data/jobs.db' })).toEqual({ enabled: true, cookie: false });
    expect(parseSessionConfig({ BPS_LOGIN: '1', BPS_COOKIE: '1', BPS_DATABASE: 'data/jobs.db' })).toEqual({ enabled: true, cookie: true });
  });

  it.each(['0', 'true', 'yes', '', ' 1'])('stops at startup for BPS_LOGIN=%j', (value) => {
    expect(() => parseSessionConfig({ BPS_LOGIN: value, BPS_DATABASE: 'data/jobs.db' })).toThrow(SessionConfigError);
    expect(() => parseSessionConfig({ BPS_LOGIN: value, BPS_DATABASE: 'data/jobs.db' })).toThrow(/BPS_LOGIN/);
  });

  it.each([{}, { BPS_DATABASE: '' }, { BPS_DATABASE: '  ' }])('stops at startup for BPS_LOGIN=1 without a database (%j)', (env) => {
    expect(() => parseSessionConfig({ BPS_LOGIN: '1', ...env })).toThrow(/BPS_DATABASE/);
  });

  it('stops at startup for a bad BPS_COOKIE or BPS_COOKIE without BPS_LOGIN', () => {
    expect(() => parseSessionConfig({ BPS_LOGIN: '1', BPS_COOKIE: 'on', BPS_DATABASE: 'data/jobs.db' })).toThrow(/BPS_COOKIE/);
    expect(() => parseSessionConfig({ BPS_COOKIE: '1' })).toThrow(/BPS_LOGIN/);
  });

  it('adds nothing to the server with login off', () => {
    expect(configureLogin({ enabled: false }, undefined)).toEqual({});
  });

  it('stops when login is on but no database is open', () => {
    expect(() => configureLogin({ enabled: true, cookie: false }, undefined)).toThrow(SessionConfigError);
  });
});

describe('login flag off (Spec 028d)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('mounts no login routes and keeps every caller the local admin', async () => {
    app = createApp(configureLogin(parseSessionConfig({}), undefined));

    const loginResponse = await login(app, 'admin.ann');
    const logout = await app.inject({ method: 'POST', url: '/logout' });
    const webhooks = await app.inject({ method: 'GET', url: '/webhooks' });

    expect(loginResponse.statusCode).toBe(404);
    expect(logout.statusCode).toBe(404);
    expect(webhooks.statusCode).toBe(200);
  });
});

describe('login routes (Spec 028d)', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.app.close();
    h?.db.close();
    h = undefined;
  });

  it('returns the token once in JSON, accepts it as a bearer token and revokes it on logout', async () => {
    h = createHarness();
    const account = await addUser(h.users, 'viewer.vic', ['viewer']);

    const response = await login(h.app, 'Viewer.Vic');
    const body = response.json<LoginResult>();
    const token = body.token ?? '';

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(token).toMatch(TOKEN);
    expect(body.expiresAt).toBe(new Date(Date.parse(NOW) + TTL_MS).toISOString());
    expect(body.user).toEqual({
      id: account.id,
      username: 'viewer.vic',
      displayName: 'viewer.vic',
      roles: ['viewer'],
      createdAt: NOW,
    });
    expect(response.body).not.toContain('scrypt');

    expect((await h.app.inject({ method: 'GET', url: '/trash', headers: bearer(token) })).statusCode).toBe(200);

    const logout = await h.app.inject({ method: 'POST', url: '/logout', headers: bearer(token) });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toBeUndefined();

    const after = await h.app.inject({ method: 'GET', url: '/trash', headers: bearer(token) });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual(UNAUTHENTICATED);
    expect((await h.app.inject({ method: 'POST', url: '/logout', headers: bearer(token) })).statusCode).toBe(401);
  });

  it('issues a new token per login and logout revokes only the current one', async () => {
    h = createHarness();
    await addUser(h.users, 'operator.oz', ['operator']);
    const first = await tokenFor(h.app, 'operator.oz');
    const second = await tokenFor(h.app, 'operator.oz');

    await h.app.inject({ method: 'POST', url: '/logout', headers: bearer(first) });

    expect(first).not.toBe(second);
    expect((await h.app.inject({ method: 'GET', url: '/trash', headers: bearer(first) })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/trash', headers: bearer(second) })).statusCode).toBe(200);
  });

  it('answers logout without a live session with 401', async () => {
    h = createHarness();

    const response = await h.app.inject({ method: 'POST', url: '/logout', headers: bearer('A'.repeat(43)) });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHENTICATED);
  });

  it('takes the actor from the roles of the user record', async () => {
    h = createHarness();
    await addUser(h.users, 'viewer.vic', ['viewer']);
    await addUser(h.users, 'designer.dee', ['designer']);
    await addUser(h.users, 'admin.ann', ['admin', 'viewer']);
    const viewer = await tokenFor(h.app, 'viewer.vic');
    const designer = await tokenFor(h.app, 'designer.dee');
    const admin = await tokenFor(h.app, 'admin.ann');

    expect((await h.app.inject({ method: 'GET', url: '/trash', headers: bearer(viewer) })).statusCode).toBe(200);
    const denied = await h.app.inject({ method: 'GET', url: '/webhooks', headers: bearer(viewer) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'webhooks:read' } } });
    // Core maps the designer account role down to the viewer actor role.
    expect((await h.app.inject({ method: 'GET', url: '/webhooks', headers: bearer(designer) })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/webhooks', headers: bearer(admin) })).statusCode).toBe(200);
  });

  it('answers a bad password, an unknown or invalid username and a disabled user with the same 401', async () => {
    h = createHarness();
    await addUser(h.users, 'operator.oz', ['operator']);
    await addUser(h.users, 'disabled.dan', ['admin'], true);

    const responses = [
      await login(h.app, 'operator.oz', 'wrong password here'),
      await login(h.app, 'nobody.here'),
      await login(h.app, 'x'),
      await login(h.app, 'disabled.dan'),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(LOGIN_FAILED);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('answers a body that is not { username, password } with 400', async () => {
    h = createHarness();

    const missing = await h.app.inject({ method: 'POST', url: '/login', payload: { username: 'operator.oz' } });
    const wrongType = await h.app.inject({ method: 'POST', url: '/login', payload: { username: 'operator.oz', password: 42 } });

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(wrongType.statusCode).toBe(400);
  });

  it('stops honoring a session once its user is disabled or deleted', async () => {
    h = createHarness();
    const operator = await addUser(h.users, 'operator.oz', ['operator']);
    const viewer = await addUser(h.users, 'viewer.vic', ['viewer']);
    const operatorToken = await tokenFor(h.app, 'operator.oz');
    const viewerToken = await tokenFor(h.app, 'viewer.vic');

    h.users.setDisabled(operator.id, new Date(NOW));
    h.users.delete(viewer.id);

    expect((await h.app.inject({ method: 'GET', url: '/trash', headers: bearer(operatorToken) })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/trash', headers: bearer(viewerToken) })).statusCode).toBe(401);
    // The session was revoked, so enabling the account again does not bring it back.
    h.users.setDisabled(operator.id, null);
    expect((await h.app.inject({ method: 'GET', url: '/trash', headers: bearer(operatorToken) })).statusCode).toBe(401);
  });

  it('stops honoring a session once it expires', async () => {
    h = createHarness();
    await addUser(h.users, 'viewer.vic', ['viewer']);
    const token = await tokenFor(h.app, 'viewer.vic');

    h.clock.ms += TTL_MS - 1;
    expect((await h.app.inject({ method: 'GET', url: '/trash', headers: bearer(token) })).statusCode).toBe(200);
    h.clock.ms += 1;
    expect((await h.app.inject({ method: 'GET', url: '/trash', headers: bearer(token) })).statusCode).toBe(401);
  });

  it('sets the token only as an HttpOnly Secure SameSite=Lax cookie with BPS_COOKIE=1', async () => {
    h = createHarness({ cookie: true });
    await addUser(h.users, 'viewer.vic', ['viewer']);

    const response = await login(h.app, 'viewer.vic');
    const setCookie = String(response.headers['set-cookie']);
    const token = cookieToken(setCookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('token');
    expect(response.body).not.toContain(token);
    expect(token).toMatch(TOKEN);
    expect(setCookie.split('; ').slice(1).sort()).toEqual(['HttpOnly', `Max-Age=${TTL_MS / 1000}`, 'Path=/', 'SameSite=Lax', 'Secure']);

    const cookie = `theme=dark; bps_session=${token}`;
    expect((await h.app.inject({ method: 'GET', url: '/trash', headers: { cookie } })).statusCode).toBe(200);

    const logout = await h.app.inject({ method: 'POST', url: '/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toBe('bps_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax');
    expect((await h.app.inject({ method: 'GET', url: '/trash', headers: { cookie } })).statusCode).toBe(401);
  });

  it('asks the session verifier first and the other verifiers only when it misses', async () => {
    const other = fakeVerifier(OUTSIDER);
    h = createHarness({ verifiers: [other] });
    await addUser(h.users, 'viewer.vic', ['viewer']);
    const token = await tokenFor(h.app, 'viewer.vic');

    const bySession = await h.app.inject({ method: 'GET', url: '/webhooks', headers: bearer(token) });
    expect(bySession.statusCode).toBe(403);
    expect(other.calls).toEqual([]);

    const byOther = await h.app.inject({ method: 'GET', url: '/webhooks' });
    expect(byOther.statusCode).toBe(200);
    expect(other.calls).toEqual(['GET /webhooks']);
  });

  it('never trusts identity headers, forged tokens or forged cookies', async () => {
    h = createHarness();
    await addUser(h.users, 'viewer.vic', ['viewer']);
    const token = await tokenFor(h.app, 'viewer.vic');
    const identity = {
      'x-bps-user': 'admin',
      'x-bps-role': 'admin',
      'x-forwarded-user': 'admin',
      'x-remote-user': 'admin',
      'remote-user': 'admin',
    };

    const forged = [
      identity,
      { authorization: 'Bearer admin' },
      { authorization: `Basic ${Buffer.from(`viewer.vic:${PASSWORD}`).toString('base64')}` },
      { authorization: `Bearer ${'A'.repeat(43)}` },
      { cookie: 'bps_session=admin' },
      { cookie: `bps_session=${'A'.repeat(43)}; role=admin` },
    ];
    for (const headers of forged) {
      const response = await h.app.inject({ method: 'GET', url: '/trash', headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(401);
    }

    // A real viewer session plus identity headers is still a viewer.
    const escalation = await h.app.inject({ method: 'GET', url: '/webhooks', headers: { ...identity, ...bearer(token) } });
    expect(escalation.statusCode).toBe(403);
  });

  it('documents /login and /logout in the OpenAPI document', async () => {
    h = createHarness();

    const response = await h.app.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(200);
    const document = response.json<{
      info: { description: string };
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
      components: { schemas: Record<string, unknown> };
    }>();
    expect(document.info.description).toContain('BPS_LOGIN=1');
    expect(document.paths['/login']?.post?.responses['200']).toBeDefined();
    expect(document.paths['/login']?.post?.responses['401']?.description).toContain('unauthenticated');
    expect(document.paths['/logout']?.post?.responses['204']).toBeDefined();
    expect(document.paths['/logout']?.post?.responses['401']).toBeDefined();
    expect(document.components.schemas).toHaveProperty('LoginResult');
  });
});
