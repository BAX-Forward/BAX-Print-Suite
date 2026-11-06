import {
  createSite,
  createSiteMembership,
  createUserAccount,
  localAdminMembership,
  type CreateSiteInput,
  type Site,
  type SiteMembership,
  type UserAccount,
} from '@bax-print/core';
import { describe, expect, it } from 'vitest';
import {
  appliedMigrations,
  InvalidSiteRecordError,
  openDatabase,
  SiteIdTakenError,
  SqliteSiteRepository,
  SqliteUserRepository,
  UnknownSiteError,
  type Database,
} from '../src/index.js';

/** A fixed encoded hash in core's format; never verified against a password. */
const SALT = Buffer.alloc(16, 7).toString('base64url');
const KEY = Buffer.alloc(32, 9).toString('base64url');
const HASH = ['scrypt', 16, 1, 1, SALT, KEY].join('$');

const T0 = new Date('2026-03-01T09:00:00.000Z');

interface Fixture {
  readonly db: Database;
  readonly sites: SqliteSiteRepository;
  readonly users: SqliteUserRepository;
}

function openRepos(): Fixture {
  const db = openDatabase();
  return { db, sites: new SqliteSiteRepository(db), users: new SqliteUserRepository(db) };
}

function site(overrides: Partial<CreateSiteInput> = {}): Site {
  return createSite({ id: 'lisbon', name: 'Lisbon plant', timeZone: 'Europe/Lisbon', ...overrides }, T0);
}

function user(username = 'ana'): UserAccount {
  return createUserAccount({ username, displayName: 'Ana Silva', roles: ['operator'], passwordHash: HASH }, T0);
}

function membership(userId: string, siteIds: readonly string[]): SiteMembership {
  return createSiteMembership({ userId, siteIds });
}

interface RawSite {
  readonly id: string;
  readonly name: string;
  readonly time_zone: string;
  readonly created_at: string;
}

const RAW: RawSite = { id: 'porto', name: 'Porto', time_zone: 'Europe/Lisbon', created_at: T0.toISOString() };

function insertRaw(db: Database, row: RawSite): void {
  db.prepare('INSERT INTO sites (id, name, time_zone, created_at) VALUES (?, ?, ?, ?)').run(
    row.id,
    row.name,
    row.time_zone,
    row.created_at,
  );
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
  expect(error).toBeInstanceOf(InvalidSiteRecordError);
  expect(error).toMatchObject({ code: 'SITE_RECORD_INVALID' });
}

function count(db: Database, table: 'sites' | 'site_memberships'): unknown {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
}

describe('SqliteSiteRepository sites', () => {
  it('applies the sites migration and adds the all-sites flag to users', () => {
    const db = openDatabase();
    expect(appliedMigrations(db)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const columns = db.prepare('PRAGMA table_info(users)').all();
    expect(columns).toContainEqual(expect.objectContaining({ name: 'all_sites', notnull: 1, dflt_value: '0' }));
    db.close();
  });

  it('creates, reads, lists and deletes sites', () => {
    const { db, sites } = openRepos();
    const lisbon = site();
    const berlin = site({ id: 'berlin', name: 'Berlin', timeZone: 'Europe/Berlin' });

    expect(sites.create(lisbon)).toEqual(lisbon);
    sites.create(berlin);
    expect(sites.get('lisbon')).toEqual(lisbon);
    expect(sites.get('missing')).toBeUndefined();
    expect(sites.list().map((entry) => entry.id)).toEqual(['berlin', 'lisbon']);

    expect(sites.delete('lisbon')).toBe(true);
    expect(sites.delete('lisbon')).toBe(false);
    expect(sites.get('lisbon')).toBeUndefined();
    expect(sites.list()).toEqual([berlin]);
    db.close();
  });

  it('rejects a taken site id and writes nothing', () => {
    const { db, sites } = openRepos();
    sites.create(site());
    const error = caught(() => sites.create(site({ name: 'Another Lisbon' })));

    expect(error).toBeInstanceOf(SiteIdTakenError);
    expect(error).toMatchObject({ code: 'SITE_ID_TAKEN', siteId: 'lisbon' });
    expect(sites.get('lisbon')?.name).toBe('Lisbon plant');
    expect(count(db, 'sites')).toEqual({ n: 1 });
    db.close();
  });

  it.each([
    ['an uppercase id', (): Site => ({ ...site(), id: 'Lisbon' })],
    ['an untrimmed id', (): Site => ({ ...site(), id: ' lisbon' })],
    ['a blank name', (): Site => ({ ...site(), name: ' ' })],
    ['an unknown time zone', (): Site => ({ ...site(), timeZone: 'Mars/Olympus' })],
    ['a bad createdAt', (): Site => ({ ...site(), createdAt: 'yesterday' })],
  ] as const)('rejects creating a site with %s and writes nothing', (_label, build) => {
    const { db, sites } = openRepos();
    expectInvalid(() => sites.create(build()));
    expect(count(db, 'sites')).toEqual({ n: 0 });
    db.close();
  });

  it('reads a well-formed row written outside the repository', () => {
    const { db, sites } = openRepos();
    insertRaw(db, RAW);

    expect(sites.get('porto')).toEqual({
      id: 'porto',
      name: 'Porto',
      timeZone: 'Europe/Lisbon',
      createdAt: T0.toISOString(),
    });
    db.close();
  });

  it.each([
    ['an uppercase id', { id: 'PORTO' }],
    ['a too-short id', { id: 'p' }],
    ['an id ending in "-"', { id: 'porto-' }],
    ['a blank name', { name: '' }],
    ['an untrimmed name', { name: ' Porto' }],
    ['an unknown time zone', { time_zone: 'Mars/Olympus' }],
    ['a bad createdAt', { created_at: 'yesterday' }],
  ] as const)('rejects reading a stored site with %s', (_label, change) => {
    const { db, sites } = openRepos();
    const row = { ...RAW, ...change };
    insertRaw(db, row);

    expectInvalid(() => sites.get(row.id));
    expectInvalid(() => sites.list());
    db.close();
  });
});

describe('SqliteSiteRepository memberships', () => {
  it('round-trips an all-sites membership', () => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());

    expect(sites.setMembership(ana.id, localAdminMembership(ana.id))).toBe(true);
    expect(sites.getMembership(ana.id)).toEqual({ userId: ana.id, allSites: true });
    expect(db.prepare('SELECT all_sites FROM users WHERE id = ?').get(ana.id)).toEqual({ all_sites: 1 });
    expect(count(db, 'site_memberships')).toEqual({ n: 0 });
    db.close();
  });

  it('round-trips a site list, sorted', () => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());
    sites.create(site());
    sites.create(site({ id: 'berlin', name: 'Berlin', timeZone: 'Europe/Berlin' }));

    expect(sites.setMembership(ana.id, membership(ana.id, ['lisbon', 'berlin']))).toBe(true);
    expect(sites.getMembership(ana.id)).toEqual({ userId: ana.id, siteIds: ['berlin', 'lisbon'] });
    db.close();
  });

  it('replaces a membership, switching between all sites and a site list', () => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());
    sites.create(site());
    sites.create(site({ id: 'berlin', name: 'Berlin', timeZone: 'Europe/Berlin' }));

    sites.setMembership(ana.id, membership(ana.id, ['lisbon', 'berlin']));
    sites.setMembership(ana.id, localAdminMembership(ana.id));
    expect(sites.getMembership(ana.id)).toEqual({ userId: ana.id, allSites: true });
    expect(count(db, 'site_memberships')).toEqual({ n: 0 });

    sites.setMembership(ana.id, membership(ana.id, ['lisbon']));
    expect(sites.getMembership(ana.id)).toEqual({ userId: ana.id, siteIds: ['lisbon'] });
    expect(db.prepare('SELECT all_sites FROM users WHERE id = ?').get(ana.id)).toEqual({ all_sites: 0 });
    db.close();
  });

  it('has no membership for an unknown user or a user granted no site', () => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());

    expect(sites.getMembership(ana.id)).toBeUndefined();
    expect(sites.getMembership('missing')).toBeUndefined();
    expect(sites.setMembership('missing', localAdminMembership('missing'))).toBe(false);
    db.close();
  });

  it('rejects a membership naming an unknown site and keeps the old one', () => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());
    sites.create(site());
    sites.setMembership(ana.id, membership(ana.id, ['lisbon']));

    const error = caught(() => sites.setMembership(ana.id, membership(ana.id, ['lisbon', 'tokyo'])));
    expect(error).toBeInstanceOf(UnknownSiteError);
    expect(error).toMatchObject({ code: 'SITE_NOT_FOUND', siteId: 'tokyo' });
    expect(sites.getMembership(ana.id)).toEqual({ userId: ana.id, siteIds: ['lisbon'] });
    db.close();
  });

  it.each([
    ['another user', (userId: string): SiteMembership => localAdminMembership(`${userId}-other`)],
    ['no sites', (userId: string): SiteMembership => ({ userId, siteIds: [] })],
    ['an invalid site id', (userId: string): SiteMembership => ({ userId, siteIds: ['Lisbon'] })],
  ] as const)('rejects a membership with %s and writes nothing', (_label, build) => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());
    sites.create(site());

    expectInvalid(() => sites.setMembership(ana.id, build(ana.id)));
    expect(sites.getMembership(ana.id)).toBeUndefined();
    db.close();
  });

  it('cascades memberships when the user is deleted', () => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());
    const zoe = users.create(user('zoe'));
    sites.create(site());
    sites.setMembership(ana.id, membership(ana.id, ['lisbon']));
    sites.setMembership(zoe.id, membership(zoe.id, ['lisbon']));

    expect(users.delete(ana.id)).toBe(true);
    expect(sites.getMembership(ana.id)).toBeUndefined();
    expect(count(db, 'site_memberships')).toEqual({ n: 1 });
    expect(sites.getMembership(zoe.id)).toEqual({ userId: zoe.id, siteIds: ['lisbon'] });
    db.close();
  });

  it('cascades memberships when a site is deleted', () => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());
    sites.create(site());
    sites.create(site({ id: 'berlin', name: 'Berlin', timeZone: 'Europe/Berlin' }));
    sites.setMembership(ana.id, membership(ana.id, ['berlin', 'lisbon']));

    expect(sites.delete('berlin')).toBe(true);
    expect(sites.getMembership(ana.id)).toEqual({ userId: ana.id, siteIds: ['lisbon'] });
    expect(sites.delete('lisbon')).toBe(true);
    expect(sites.getMembership(ana.id)).toBeUndefined();
    expect(count(db, 'site_memberships')).toEqual({ n: 0 });
    db.close();
  });

  it('keeps an all-sites membership when a site is deleted', () => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());
    sites.create(site());
    sites.setMembership(ana.id, localAdminMembership(ana.id));

    sites.delete('lisbon');
    expect(sites.getMembership(ana.id)).toEqual({ userId: ana.id, allSites: true });
    db.close();
  });

  it('rejects reading a membership with an invalid stored site id', () => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());
    insertRaw(db, { ...RAW, id: 'Porto' });
    db.prepare('INSERT INTO site_memberships (user_id, site_id) VALUES (?, ?)').run(ana.id, 'Porto');

    expectInvalid(() => sites.getMembership(ana.id));
    db.close();
  });

  it('rejects reading an all-sites flag other than 0 or 1', () => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());
    db.prepare('UPDATE users SET all_sites = 2 WHERE id = ?').run(ana.id);

    expectInvalid(() => sites.getMembership(ana.id));
    db.close();
  });

  it('rejects reading all sites together with a site list', () => {
    const { db, sites, users } = openRepos();
    const ana = users.create(user());
    sites.create(site());
    sites.setMembership(ana.id, membership(ana.id, ['lisbon']));
    db.prepare('UPDATE users SET all_sites = 1 WHERE id = ?').run(ana.id);

    expectInvalid(() => sites.getMembership(ana.id));
    db.close();
  });
});
