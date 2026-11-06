import {
  createUserAccount,
  hashPassword,
  verifyPassword,
  type CreateUserAccountInput,
  type UserAccount,
} from '@bax-print/core';
import { describe, expect, it } from 'vitest';
import {
  appliedMigrations,
  InvalidUserRecordError,
  openDatabase,
  SqliteUserRepository,
  UsernameTakenError,
  type Database,
} from '../src/index.js';

/** A fixed encoded hash in core's format; cheap, and never verified against a password. */
const SALT = Buffer.alloc(16, 7).toString('base64url');
const KEY = Buffer.alloc(32, 9).toString('base64url');
const HASH = ['scrypt', 16, 1, 1, SALT, KEY].join('$');
/** Cheap scrypt parameters for tests only. */
const TEST_PARAMS = { N: 16, r: 1, p: 1 };

const T0 = new Date('2026-03-01T09:00:00.000Z');
const T1 = new Date('2026-03-02T10:00:00.000Z');

function openRepo(): { db: Database; repo: SqliteUserRepository } {
  const db = openDatabase();
  return { db, repo: new SqliteUserRepository(db) };
}

function account(overrides: Partial<CreateUserAccountInput> = {}): UserAccount {
  return createUserAccount(
    { username: 'ana', displayName: 'Ana Silva', roles: ['operator'], passwordHash: HASH, ...overrides },
    T0,
  );
}

interface RawRow {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly roles_json: string;
  readonly password_hash: string;
  readonly created_at: string;
  readonly disabled_at: string | null;
}

const RAW: RawRow = {
  id: 'user-1',
  username: 'ana',
  display_name: 'Ana Silva',
  roles_json: '["admin","viewer"]',
  password_hash: HASH,
  created_at: T0.toISOString(),
  disabled_at: null,
};

function insertRaw(db: Database, row: RawRow): void {
  db.prepare(
    `INSERT INTO users (id, username, display_name, roles_json, password_hash, created_at, disabled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.username, row.display_name, row.roles_json, row.password_hash, row.created_at, row.disabled_at);
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
  expect(error).toBeInstanceOf(InvalidUserRecordError);
  expect(error).toMatchObject({ code: 'USER_RECORD_INVALID' });
}

function countUsers(db: Database): unknown {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get();
}

describe('SqliteUserRepository', () => {
  it('applies the users migration', () => {
    const db = openDatabase();
    expect(appliedMigrations(db)).toEqual([1, 2, 3, 4, 5]);
    db.close();
  });

  it('creates an account and reads it back by id and username', () => {
    const { db, repo } = openRepo();
    const ana = account({ roles: ['viewer', 'admin'] });

    expect(repo.create(ana)).toEqual(ana);
    expect(repo.get(ana.id)).toEqual(ana);
    expect(repo.getByUsername('ana')).toEqual(ana);
    expect(repo.get('missing')).toBeUndefined();
    expect(repo.getByUsername('nobody')).toBeUndefined();
    db.close();
  });

  it('normalizes the username like core when looking it up', () => {
    const { db, repo } = openRepo();
    const ana = repo.create(account());

    expect(repo.getByUsername('  ANA ')).toEqual(ana);
    // Names core rejects find nothing instead of throwing.
    expect(repo.getByUsername('a')).toBeUndefined();
    expect(repo.getByUsername('ana silva')).toBeUndefined();
    db.close();
  });

  it('round-trips a disabled account', () => {
    const { db, repo } = openRepo();
    const disabled = account({ disabledAt: T1 });
    repo.create(disabled);

    expect(repo.get(disabled.id)).toEqual(disabled);
    expect(repo.get(disabled.id)?.disabledAt).toBe(T1.toISOString());
    db.close();
  });

  it('rejects a taken username and writes nothing', () => {
    const { db, repo } = openRepo();
    repo.create(account());
    const error = caught(() => repo.create(account({ username: 'ANA', displayName: 'Another Ana' })));

    expect(error).toBeInstanceOf(UsernameTakenError);
    expect(error).toMatchObject({ code: 'USERNAME_TAKEN', username: 'ana' });
    expect(countUsers(db)).toEqual({ n: 1 });
    db.close();
  });

  it.each([
    ['an invalid username', (): UserAccount => ({ ...account(), username: 'Ana Silva' })],
    ['a blank display name', (): UserAccount => ({ ...account(), displayName: ' ' })],
    ['no roles', (): UserAccount => ({ ...account(), roles: [] })],
    ['unsorted roles', (): UserAccount => ({ ...account(), roles: ['viewer', 'admin'] })],
    ['a malformed password hash', (): UserAccount => ({ ...account(), passwordHash: 'plain-text' })],
    ['a bad createdAt', (): UserAccount => ({ ...account(), createdAt: 'yesterday' })],
  ] as const)('rejects creating an account with %s and writes nothing', (_label, build) => {
    const { db, repo } = openRepo();
    expectInvalid(() => repo.create(build()));
    expect(countUsers(db)).toEqual({ n: 0 });
    db.close();
  });

  it('lists public views ordered by username, without password hashes', () => {
    const { db, repo } = openRepo();
    const zoe = repo.create(account({ username: 'zoe', displayName: 'Zoe' }));
    const ana = repo.create(account({ disabledAt: T1 }));

    const listed = repo.list();
    expect(listed.map((user) => user.username)).toEqual(['ana', 'zoe']);
    expect(listed).toEqual([
      {
        id: ana.id,
        username: 'ana',
        displayName: 'Ana Silva',
        roles: ['operator'],
        createdAt: ana.createdAt,
        disabledAt: T1.toISOString(),
      },
      { id: zoe.id, username: 'zoe', displayName: 'Zoe', roles: ['operator'], createdAt: zoe.createdAt },
    ]);
    const text = JSON.stringify(listed);
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain(HASH);
    db.close();
  });

  it('updates the password hash', async () => {
    const { db, repo } = openRepo();
    const ana = repo.create(account());
    const hash = await hashPassword('correct horse battery', { params: TEST_PARAMS });

    expect(repo.updatePasswordHash(ana.id, hash)).toBe(true);
    const stored = repo.get(ana.id);
    expect(stored?.passwordHash).toBe(hash);
    expect(await verifyPassword('correct horse battery', stored?.passwordHash)).toBe(true);
    expect(repo.updatePasswordHash('missing', hash)).toBe(false);
    db.close();
  });

  it('rejects a malformed password hash on update and keeps the old one', () => {
    const { db, repo } = openRepo();
    const ana = repo.create(account());

    expectInvalid(() => repo.updatePasswordHash(ana.id, 'plain-text'));
    expect(repo.get(ana.id)?.passwordHash).toBe(HASH);
    db.close();
  });

  it('disables and enables an account', () => {
    const { db, repo } = openRepo();
    const ana = repo.create(account());

    expect(repo.setDisabled(ana.id, T1)).toBe(true);
    expect(repo.get(ana.id)?.disabledAt).toBe(T1.toISOString());
    expect(repo.setDisabled(ana.id, null)).toBe(true);
    expect(repo.get(ana.id)).toEqual(ana);
    expect(repo.get(ana.id)).not.toHaveProperty('disabledAt');
    expect(repo.setDisabled('missing', T1)).toBe(false);
    expectInvalid(() => repo.setDisabled(ana.id, new Date(Number.NaN)));
    db.close();
  });

  it('deletes an account', () => {
    const { db, repo } = openRepo();
    const ana = repo.create(account());

    expect(repo.delete(ana.id)).toBe(true);
    expect(repo.delete(ana.id)).toBe(false);
    expect(repo.get(ana.id)).toBeUndefined();
    expect(repo.getByUsername('ana')).toBeUndefined();
    db.close();
  });

  it('reads a well-formed row written outside the repository', () => {
    const { db, repo } = openRepo();
    insertRaw(db, RAW);

    expect(repo.get('user-1')).toEqual({
      id: 'user-1',
      username: 'ana',
      displayName: 'Ana Silva',
      roles: ['admin', 'viewer'],
      passwordHash: HASH,
      createdAt: T0.toISOString(),
    });
    db.close();
  });

  it.each([
    ['an unknown role', { roles_json: '["admin","owner"]' }],
    ['no roles', { roles_json: '[]' }],
    ['roles that are not an array', { roles_json: '{"admin":true}' }],
    ['roles JSON that does not parse', { roles_json: '[admin' }],
    ['duplicate roles', { roles_json: '["admin","admin"]' }],
    ['an uppercase username', { username: 'Ana' }],
    ['a username with spaces', { username: 'ana silva' }],
    ['a too-short username', { username: 'an' }],
    ['a blank display name', { display_name: '' }],
    ['a malformed password hash', { password_hash: 'plain-text' }],
    ['a bad createdAt', { created_at: 'yesterday' }],
    ['a bad disabledAt', { disabled_at: 'later' }],
  ] as const)('rejects reading a stored row with %s', (_label, change) => {
    const { db, repo } = openRepo();
    insertRaw(db, { ...RAW, ...change });

    expectInvalid(() => repo.get('user-1'));
    expectInvalid(() => repo.list());
    db.close();
  });
});
