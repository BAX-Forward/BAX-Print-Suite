import {
  createSiteMembership,
  InvalidArgumentError,
  parseSiteId,
  parseTimeZone,
  SITE_NAME_MAX_LENGTH,
  type Site,
  type SiteMembership,
} from '@bax-print/core';
import type { Database } from './database.js';

/**
 * Spec 030b: sites and site memberships (spec 030a) persisted in the job database (migration 7).
 * Sites and memberships are checked on write and on read, so a corrupt row never reaches a
 * caller. An all-sites membership is the `users.all_sites` flag; a site list is one
 * `site_memberships` row per site. Both cascade when the user or the site is deleted.
 */

export interface SiteRepository {
  /** Throws {@link SiteIdTakenError} or {@link InvalidSiteRecordError}. */
  create(site: Site): Site;
  /** Throws {@link InvalidSiteRecordError} if the stored row is malformed. */
  get(id: string): Site | undefined;
  /** Ordered by id. */
  list(): Site[];
  /** Also removes the site from every membership. */
  delete(id: string): boolean;
  /**
   * Replaces the membership of `userId`. False when no user has `userId`. Throws
   * {@link UnknownSiteError} for a site that does not exist, or {@link InvalidSiteRecordError}.
   */
  setMembership(userId: string, membership: SiteMembership): boolean;
  /** Undefined when the user does not exist or is granted no site. */
  getMembership(userId: string): SiteMembership | undefined;
}

export class InvalidSiteRecordError extends Error {
  readonly code = 'SITE_RECORD_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidSiteRecordError';
  }
}

export class SiteIdTakenError extends Error {
  readonly code = 'SITE_ID_TAKEN';
  readonly siteId: string;

  constructor(siteId: string) {
    super(`site id ${JSON.stringify(siteId)} is taken`);
    this.name = 'SiteIdTakenError';
    this.siteId = siteId;
  }
}

export class UnknownSiteError extends Error {
  readonly code = 'SITE_NOT_FOUND';
  readonly siteId: string;

  constructor(siteId: string) {
    super(`site ${JSON.stringify(siteId)} does not exist`);
    this.name = 'UnknownSiteError';
    this.siteId = siteId;
  }
}

/** Matches the timestamps core writes with `toISOString`. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const COLUMNS = 'id, name, time_zone, created_at';

interface SiteFields {
  readonly id: unknown;
  readonly name: unknown;
  readonly timeZone: unknown;
  readonly createdAt: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

/** The value as `parse` returns it, or undefined when core rejects it. */
function tryParse(parse: (value: unknown) => string, value: unknown): string | undefined {
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) return undefined;
    throw error;
  }
}

/** True when `value` is already a site ID as core parses it. */
function isSiteId(value: unknown): value is string {
  return typeof value === 'string' && tryParse(parseSiteId, value) === value;
}

function isSiteName(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= SITE_NAME_MAX_LENGTH
  );
}

/** True when `value` is already a time zone name as Intl resolves it. */
function isTimeZone(value: unknown): value is string {
  return typeof value === 'string' && tryParse(parseTimeZone, value) === value;
}

/** Checks every site field and rebuilds the site with only the known fields. */
function toSite(fields: SiteFields): Site {
  const { id, name, timeZone, createdAt } = fields;
  if (!isSiteId(id)) {
    throw new InvalidSiteRecordError('site id must be a valid site ID');
  }
  if (!isSiteName(name)) {
    throw new InvalidSiteRecordError(`site ${id} name must be 1-${SITE_NAME_MAX_LENGTH} trimmed characters`);
  }
  if (!isTimeZone(timeZone)) {
    throw new InvalidSiteRecordError(`site ${id} time zone must be a resolved IANA time zone name`);
  }
  if (!isTimestamp(createdAt)) {
    throw new InvalidSiteRecordError(`site ${id} createdAt must be an ISO 8601 timestamp`);
  }
  return Object.freeze({ id, name, timeZone, createdAt });
}

function rowToSite(row: unknown): Site {
  if (!isRecord(row)) {
    throw new InvalidSiteRecordError('stored site row is malformed');
  }
  return toSite({ id: row.id, name: row.name, timeZone: row.time_zone, createdAt: row.created_at });
}

/** Revalidates a membership with core; it must name `userId` exactly. */
function checkMembership(userId: string, membership: SiteMembership): SiteMembership {
  if (membership.userId !== userId) {
    throw new InvalidSiteRecordError(`membership names user ${membership.userId}, not ${userId}`);
  }
  let checked: SiteMembership;
  try {
    checked =
      'siteIds' in membership
        ? createSiteMembership({ userId, siteIds: membership.siteIds })
        : createSiteMembership({ userId, allSites: membership.allSites });
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw new InvalidSiteRecordError(`membership for user ${userId} is invalid: ${error.message}`);
    }
    throw error;
  }
  if (checked.userId !== userId) {
    throw new InvalidSiteRecordError('membership user id must be trimmed');
  }
  return checked;
}

/** The stored `all_sites` flag, which must be 0 or 1. */
function toAllSitesFlag(value: unknown, userId: string): boolean {
  const flag = typeof value === 'bigint' ? Number(value) : value;
  if (flag !== 0 && flag !== 1) {
    throw new InvalidSiteRecordError(`user ${userId} all_sites must be 0 or 1`);
  }
  return flag === 1;
}

function rowToSiteId(row: unknown, userId: string): string {
  const siteId = isRecord(row) ? row.site_id : undefined;
  if (!isSiteId(siteId)) {
    throw new InvalidSiteRecordError(`user ${userId} has a membership with an invalid site id`);
  }
  return siteId;
}

/** Runs `work` in one transaction so checks and writes cannot interleave. */
function inTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export class SqliteSiteRepository implements SiteRepository {
  /** `db` must come from `openDatabase`, which applies the migrations and enables foreign keys. */
  constructor(private readonly db: Database) {}

  create(site: Site): Site {
    const checked = toSite({ id: site.id, name: site.name, timeZone: site.timeZone, createdAt: site.createdAt });
    return inTransaction(this.db, () => {
      if (this.db.prepare('SELECT id FROM sites WHERE id = ?').get(checked.id) !== undefined) {
        throw new SiteIdTakenError(checked.id);
      }
      this.db
        .prepare(`INSERT INTO sites (${COLUMNS}) VALUES (?, ?, ?, ?)`)
        .run(checked.id, checked.name, checked.timeZone, checked.createdAt);
      return checked;
    });
  }

  get(id: string): Site | undefined {
    const row: unknown = this.db.prepare(`SELECT ${COLUMNS} FROM sites WHERE id = ?`).get(id);
    return row === undefined ? undefined : rowToSite(row);
  }

  list(): Site[] {
    const rows: unknown[] = this.db.prepare(`SELECT ${COLUMNS} FROM sites ORDER BY id`).all();
    return rows.map((row) => rowToSite(row));
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sites WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  setMembership(userId: string, membership: SiteMembership): boolean {
    const checked = checkMembership(userId, membership);
    // Core never returns an empty site list, so no rows means all sites.
    const siteIds = 'siteIds' in checked ? checked.siteIds : [];
    return inTransaction(this.db, () => {
      if (this.db.prepare('SELECT id FROM users WHERE id = ?').get(userId) === undefined) {
        return false;
      }
      const findSite = this.db.prepare('SELECT id FROM sites WHERE id = ?');
      for (const siteId of siteIds) {
        if (findSite.get(siteId) === undefined) {
          throw new UnknownSiteError(siteId);
        }
      }
      this.db.prepare('DELETE FROM site_memberships WHERE user_id = ?').run(userId);
      this.db.prepare('UPDATE users SET all_sites = ? WHERE id = ?').run(siteIds.length === 0 ? 1 : 0, userId);
      const insert = this.db.prepare('INSERT INTO site_memberships (user_id, site_id) VALUES (?, ?)');
      for (const siteId of siteIds) {
        insert.run(userId, siteId);
      }
      return true;
    });
  }

  getMembership(userId: string): SiteMembership | undefined {
    const user: unknown = this.db.prepare('SELECT all_sites FROM users WHERE id = ?').get(userId);
    if (user === undefined) {
      return undefined;
    }
    const allSites = toAllSitesFlag(isRecord(user) ? user.all_sites : undefined, userId);
    const rows: unknown[] = this.db
      .prepare('SELECT site_id FROM site_memberships WHERE user_id = ? ORDER BY site_id')
      .all(userId);
    if (allSites) {
      if (rows.length > 0) {
        throw new InvalidSiteRecordError(`user ${userId} has all sites and also a site list`);
      }
      return Object.freeze({ userId, allSites: true });
    }
    if (rows.length === 0) {
      return undefined;
    }
    const siteIds = rows.map((row) => rowToSiteId(row, userId));
    return Object.freeze({ userId, siteIds: Object.freeze(siteIds) });
  }
}
