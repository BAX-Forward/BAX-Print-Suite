import {
  API_TOKEN_PREFIX,
  createUserAccount,
  issueApiToken,
  revokeApiToken,
  verifyApiToken,
  type ApiTokenRecord,
  type IssueApiTokenInput,
  type IssuedApiToken,
  type UserAccount,
} from '@bax-print/core';
import { describe, expect, it } from 'vitest';
import {
  ApiTokenConflictError,
  ApiTokenUserNotFoundError,
  appliedMigrations,
  InvalidApiTokenRecordError,
  openDatabase,
  SqliteApiTokenRepository,
  SqliteUserRepository,
  type Database,
} from '../src/index.js';

/** A fixed encoded hash in core's format; never verified against a password. */
const SALT = Buffer.alloc(16, 7).toString('base64url');
const KEY = Buffer.alloc(32, 9).toString('base64url');
const PASSWORD_HASH = ['scrypt', 16, 1, 1, SALT, KEY].join('$');

const T0 = new Date('2026-03-01T09:00:00.000Z');
const T1 = new Date('2026-03-02T10:00:00.000Z');
const T2 = new Date('2026-03-03T11:00:00.000Z');
const T3 = new Date('2026-03-04T12:00:00.000Z');

/** Core's display prefix length: the characters after `bps_` used for lookup. */
const PREFIX_LENGTH = 8;

interface Repos {
  readonly db: Database;
  readonly tokens: SqliteApiTokenRepository;
  readonly users: SqliteUserRepository;
}

function openRepos(): Repos {
  const db = openDatabase();
  return { db, tokens: new SqliteApiTokenRepository(db), users: new SqliteUserRepository(db) };
}

function issue(overrides: Partial<IssueApiTokenInput> = {}): IssuedApiToken {
  return issueApiToken({ name: 'CI upload', scopes: ['jobs:write', 'jobs:read'], now: T0, ...overrides });
}

function user(username: string): UserAccount {
  return createUserAccount({ username, displayName: username, roles: ['operator'], passwordHash: PASSWORD_HASH }, T0);
}

/** The lookup prefix a server would cut from a presented secret. */
function prefixOf(secret: string): string {
  return secret.slice(API_TOKEN_PREFIX.length, API_TOKEN_PREFIX.length + PREFIX_LENGTH);
}

interface RawRow {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly secret_hash: string;
  readonly scopes_json: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

const RAW: RawRow = {
  id: 'token-1',
  name: 'CI upload',
  prefix: 'AbCd_-12',
  secret_hash: 'a'.repeat(64),
  scopes_json: '["jobs:read","jobs:write"]',
  created_at: T0.toISOString(),
  expires_at: null,
  revoked_at: null,
};

function insertRaw(db: Database, row: RawRow): void {
  db.prepare(
    `INSERT INTO api_tokens (id, name, prefix, secret_hash, scopes_json, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.name, row.prefix, row.secret_hash, row.scopes_json, row.created_at, row.expires_at, row.revoked_at);
}

function caught(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectInvalid(work: () => unknown): void {
  const error = caught(work);
  expect(error).toBeInstanceOf(InvalidApiTokenRecordError);
  expect(error).toMatchObject({ code: 'API_TOKEN_RECORD_INVALID' });
}

function countTokens(db: Database): unknown {
  return db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get();
}

describe('SqliteApiTokenRepository', () => {
  it('applies the api tokens migration', () => {
    const db = openDatabase();
    expect(appliedMigrations(db)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    db.close();
  });

  it('has no column for the secret', () => {
    const db = openDatabase();
    const columns = db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all('api_tokens') as unknown as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'name',
      'prefix',
      'secret_hash',
      'scopes_json',
      'created_at',
      'expires_at',
      'revoked_at',
      'user_id',
    ]);
    db.close();
  });

  it('saves an issued record, reads it back, and never stores the secret', () => {
    const { db, tokens } = openRepos();
    const { secret, record } = issue({ expiresAt: T2 });

    expect(tokens.save(record)).toEqual(record);
    expect(tokens.get(record.id)).toEqual(record);
    expect(tokens.get(record.id)?.expiresAt).toBe(T2.toISOString());
    expect(tokens.get('missing')).toBeUndefined();
    const stored = JSON.stringify(db.prepare('SELECT * FROM api_tokens').all());
    expect(stored).not.toContain(secret);
    db.close();
  });

  it('finds candidates by prefix that core verifies', () => {
    const { db, tokens } = openRepos();
    const { secret, record } = issue();
    const other = issue({ name: 'Other', now: T1 });
    tokens.save(record);
    tokens.save(other.record);

    const candidates = tokens.findByPrefix(prefixOf(secret));
    expect(candidates).toEqual([record]);
    expect(candidates.map((candidate) => verifyApiToken(secret, candidate, T1))).toEqual([{ ok: true, record }]);
    expect(candidates.map((candidate) => verifyApiToken(other.secret, candidate, T1))).toEqual([
      { ok: false, reason: 'mismatch' },
    ]);
    expect(tokens.findByPrefix('zzzzzzzz')).toEqual([]);
    db.close();
  });

  it('returns every token sharing a prefix so only the right one verifies', () => {
    const { db, tokens } = openRepos();
    const first = issue();
    const second = issue({ name: 'Second', now: T1 });
    const clash: ApiTokenRecord = { ...second.record, prefix: first.record.prefix };
    tokens.save(first.record);
    tokens.save(clash);

    const candidates = tokens.findByPrefix(first.record.prefix);
    expect(candidates).toEqual([first.record, clash]);
    const verified = candidates
      .map((candidate) => verifyApiToken(second.secret, candidate, T1))
      .filter((result) => result.ok);
    expect(verified).toEqual([{ ok: true, record: clash }]);
    db.close();
  });

  it('reports revoked and expired candidates through core', () => {
    const { db, tokens } = openRepos();
    const revoked = issue();
    const expiring = issue({ name: 'Short lived', now: T1, expiresAt: T2 });
    tokens.save(revokeApiToken(revoked.record, T1));
    tokens.save(expiring.record);

    const [revokedCandidate] = tokens.findByPrefix(prefixOf(revoked.secret));
    const [expiringCandidate] = tokens.findByPrefix(prefixOf(expiring.secret));
    expect(revokedCandidate?.revokedAt).toBe(T1.toISOString());
    expect(revokedCandidate && verifyApiToken(revoked.secret, revokedCandidate, T1)).toEqual({
      ok: false,
      reason: 'revoked',
    });
    expect(expiringCandidate && verifyApiToken(expiring.secret, expiringCandidate, T1)).toMatchObject({ ok: true });
    expect(expiringCandidate && verifyApiToken(expiring.secret, expiringCandidate, T2)).toEqual({
      ok: false,
      reason: 'expired',
    });
    db.close();
  });

  it('revokes a token once and keeps the first time', () => {
    const { db, tokens } = openRepos();
    const { secret, record } = issue();
    tokens.save(record);

    expect(tokens.revoke(record.id, T1)).toBe(true);
    expect(tokens.revoke(record.id, T2)).toBe(true);
    const stored = tokens.get(record.id);
    expect(stored).toEqual(revokeApiToken(record, T1));
    expect(stored && verifyApiToken(secret, stored, T2)).toEqual({ ok: false, reason: 'revoked' });
    expect(tokens.revoke('missing', T1)).toBe(false);
    expectInvalid(() => tokens.revoke(record.id, new Date(Number.NaN)));
    db.close();
  });

  it('deletes a token', () => {
    const { db, tokens } = openRepos();
    const { record } = issue();
    tokens.save(record);

    expect(tokens.delete(record.id)).toBe(true);
    expect(tokens.delete(record.id)).toBe(false);
    expect(tokens.get(record.id)).toBeUndefined();
    expect(tokens.findByPrefix(record.prefix)).toEqual([]);
    db.close();
  });

  it('lists all tokens and the tokens of one user, oldest first', () => {
    const { db, tokens, users } = openRepos();
    const ana = users.create(user('ana'));
    const zoe = users.create(user('zoe'));
    const late = issue({ name: 'Late', now: T2 }).record;
    const early = issue({ name: 'Early', now: T0 }).record;
    const zoeToken = issue({ name: 'Zoe', now: T1 }).record;
    const service = issue({ name: 'Service', now: T3 }).record;
    tokens.save(late, ana.id);
    tokens.save(early, ana.id);
    tokens.save(zoeToken, zoe.id);
    tokens.save(service);

    expect(tokens.listForUser(ana.id)).toEqual([early, late]);
    expect(tokens.listForUser(zoe.id)).toEqual([zoeToken]);
    expect(tokens.listForUser('nobody')).toEqual([]);
    expect(tokens.list()).toEqual([early, zoeToken, late, service]);
    db.close();
  });

  it('deletes the tokens of a user when the user is deleted', () => {
    const { db, tokens, users } = openRepos();
    const ana = users.create(user('ana'));
    const zoe = users.create(user('zoe'));
    const anaToken = issue({ name: 'Ana' }).record;
    const zoeToken = issue({ name: 'Zoe', now: T1 }).record;
    const service = issue({ name: 'Service', now: T2 }).record;
    tokens.save(anaToken, ana.id);
    tokens.save(zoeToken, zoe.id);
    tokens.save(service);

    expect(users.delete(ana.id)).toBe(true);
    expect(tokens.get(anaToken.id)).toBeUndefined();
    expect(tokens.listForUser(ana.id)).toEqual([]);
    expect(tokens.list()).toEqual([zoeToken, service]);
    db.close();
  });

  it('rejects a token for a missing user and writes nothing', () => {
    const { db, tokens } = openRepos();
    const error = caught(() => tokens.save(issue().record, 'missing'));

    expect(error).toBeInstanceOf(ApiTokenUserNotFoundError);
    expect(error).toMatchObject({ code: 'API_TOKEN_USER_NOT_FOUND', userId: 'missing' });
    expectInvalid(() => tokens.save(issue().record, ' '));
    expect(countTokens(db)).toEqual({ n: 0 });
    db.close();
  });

  it('rejects a duplicate id or secret hash and writes nothing', () => {
    const { db, tokens } = openRepos();
    const { record } = issue();
    const other = issue({ name: 'Other', now: T1 }).record;
    tokens.save(record);

    const sameId = caught(() => tokens.save({ ...other, id: record.id }));
    expect(sameId).toBeInstanceOf(ApiTokenConflictError);
    expect(sameId).toMatchObject({ code: 'API_TOKEN_CONFLICT', id: record.id });
    const sameHash = caught(() => tokens.save({ ...other, secretHash: record.secretHash }));
    expect(sameHash).toBeInstanceOf(ApiTokenConflictError);
    expect(countTokens(db)).toEqual({ n: 1 });
    db.close();
  });

  it.each([
    ['a blank id', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, id: ' ' })],
    ['a blank name', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, name: ' ' })],
    ['an untrimmed name', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, name: ' CI ' })],
    ['a too-long name', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, name: 'x'.repeat(101) })],
    ['a short prefix', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, prefix: 'abc' })],
    ['an uppercase hex hash', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, secretHash: 'A'.repeat(64) })],
    ['a short hash', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, secretHash: 'a'.repeat(63) })],
    ['no scopes', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, scopes: [] })],
    ['unsorted scopes', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, scopes: ['jobs:write', 'jobs:read'] })],
    ['duplicate scopes', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, scopes: ['jobs:read', 'jobs:read'] })],
    ['a bad createdAt', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, createdAt: 'yesterday' })],
    ['a bad expiresAt', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, expiresAt: 'soon' })],
    ['a bad revokedAt', (r: ApiTokenRecord): ApiTokenRecord => ({ ...r, revokedAt: 'later' })],
  ] as const)('rejects saving a record with %s and writes nothing', (_label, build) => {
    const { db, tokens } = openRepos();
    expectInvalid(() => tokens.save(build(issue().record)));
    expect(countTokens(db)).toEqual({ n: 0 });
    db.close();
  });

  it('reads a well-formed row written outside the repository', () => {
    const { db, tokens } = openRepos();
    insertRaw(db, { ...RAW, expires_at: T2.toISOString(), revoked_at: T1.toISOString() });

    expect(tokens.get('token-1')).toEqual({
      id: 'token-1',
      name: 'CI upload',
      prefix: 'AbCd_-12',
      secretHash: 'a'.repeat(64),
      scopes: ['jobs:read', 'jobs:write'],
      createdAt: T0.toISOString(),
      expiresAt: T2.toISOString(),
      revokedAt: T1.toISOString(),
    });
    db.close();
  });

  it.each([
    ['an unknown scope', { scopes_json: '["jobs:read","jobs:launch"]' }],
    ['no scopes', { scopes_json: '[]' }],
    ['scopes that are not an array', { scopes_json: '{"jobs:read":true}' }],
    ['scopes JSON that does not parse', { scopes_json: '[jobs:read' }],
    ['duplicate scopes', { scopes_json: '["jobs:read","jobs:read"]' }],
    ['unsorted scopes', { scopes_json: '["jobs:write","jobs:read"]' }],
    ['an uppercase hex hash', { secret_hash: 'A'.repeat(64) }],
    ['a hash that is not hex', { secret_hash: 'g'.repeat(64) }],
    ['a short hash', { secret_hash: 'a'.repeat(40) }],
    ['a prefix with invalid characters', { prefix: 'abc+/efg' }],
    ['a blank name', { name: '' }],
    ['a bad createdAt', { created_at: 'yesterday' }],
    ['a bad expiresAt', { expires_at: 'soon' }],
    ['a bad revokedAt', { revoked_at: 'later' }],
  ] as const)('rejects reading a stored row with %s', (_label, change) => {
    const { db, tokens } = openRepos();
    const row: RawRow = { ...RAW, ...change };
    insertRaw(db, row);

    expectInvalid(() => tokens.get('token-1'));
    expectInvalid(() => tokens.findByPrefix(row.prefix));
    expectInvalid(() => tokens.list());
    db.close();
  });
});
