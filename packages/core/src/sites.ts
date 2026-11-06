import { InvalidArgumentError } from './errors.js';

/**
 * Multi-site core model (spec 030a). Pure: no storage or routes. Access to
 * site-scoped records is denied unless a membership grants it.
 */

export const SITE_ID_MIN_LENGTH = 2;
export const SITE_ID_MAX_LENGTH = 32;
export const SITE_NAME_MAX_LENGTH = 128;

/** The site used by a single-site install. */
export const DEFAULT_SITE_ID = 'default';

/** Lowercase letters, digits and "-", not starting or ending with "-". */
const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface Site {
  /** Slug of 2-32 characters of [a-z0-9-], not starting or ending with "-". */
  readonly id: string;
  readonly name: string;
  /** IANA time zone name, as resolved by Intl. */
  readonly timeZone: string;
  /** ISO 8601 timestamp. */
  readonly createdAt: string;
}

export interface CreateSiteInput {
  readonly id: unknown;
  readonly name: unknown;
  readonly timeZone: unknown;
}

/** Grants a user either every site or a non-empty list of sites. */
export type SiteMembership =
  | { readonly userId: string; readonly allSites: true }
  | { readonly userId: string; readonly siteIds: readonly string[] };

export interface CreateSiteMembershipInput {
  readonly userId: unknown;
  readonly siteIds?: readonly unknown[];
  readonly allSites?: boolean;
}

/** Trims a site ID, then validates it. */
export function parseSiteId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError('siteId must be a string');
  }
  const id = value.trim();
  if (id.length < SITE_ID_MIN_LENGTH || id.length > SITE_ID_MAX_LENGTH) {
    throw new InvalidArgumentError(`siteId must be ${SITE_ID_MIN_LENGTH}-${SITE_ID_MAX_LENGTH} characters`);
  }
  if (!SITE_ID_PATTERN.test(id)) {
    throw new InvalidArgumentError('siteId may contain only a-z, 0-9 and "-", and may not start or end with "-"');
  }
  return id;
}

function parseSiteName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError('site name must be a string');
  }
  const name = value.trim();
  if (name.length === 0 || name.length > SITE_NAME_MAX_LENGTH) {
    throw new InvalidArgumentError(`site name must be 1-${SITE_NAME_MAX_LENGTH} characters`);
  }
  return name;
}

/** Validates a time zone with Intl and returns the name Intl resolves it to. */
export function parseTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError('timeZone must be a non-empty string');
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new InvalidArgumentError(`timeZone ${JSON.stringify(value)} is not a known time zone`);
  }
}

export function createSite(input: CreateSiteInput, now: Date): Site {
  if (Number.isNaN(now.getTime())) {
    throw new InvalidArgumentError('now must be a valid date');
  }
  return Object.freeze({
    id: parseSiteId(input.id),
    name: parseSiteName(input.name),
    timeZone: parseTimeZone(input.timeZone),
    createdAt: now.toISOString(),
  });
}

function parseUserId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError('userId must be a non-empty string');
  }
  return value.trim();
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Validates a membership. Site IDs are parsed, sorted and de-duplicated. */
export function createSiteMembership(input: CreateSiteMembershipInput): SiteMembership {
  const userId = parseUserId(input.userId);
  if (input.allSites === true) {
    if (input.siteIds !== undefined) {
      throw new InvalidArgumentError('a membership with allSites may not also list siteIds');
    }
    return Object.freeze({ userId, allSites: true });
  }
  if (input.siteIds === undefined || input.siteIds.length === 0) {
    throw new InvalidArgumentError('a membership needs at least one siteId or allSites');
  }
  const siteIds = [...new Set(input.siteIds.map((siteId) => parseSiteId(siteId)))].sort(compareStrings);
  return Object.freeze({ userId, siteIds: Object.freeze(siteIds) });
}

/** The membership of the local admin on a single-site install: every site. */
export function localAdminMembership(userId: string): SiteMembership {
  return createSiteMembership({ userId, allSites: true });
}

/** True only when the membership grants every site. */
export function hasAllSites(membership: SiteMembership): boolean {
  return 'allSites' in membership && membership.allSites;
}

/** True when the membership grants the site. Denies by default. */
export function canAccessSite(membership: SiteMembership, siteId: string): boolean {
  if (hasAllSites(membership)) return true;
  return 'siteIds' in membership && membership.siteIds.includes(siteId);
}

/** The items the membership may see. Items without a siteId are visible only with allSites. */
export function filterBySite<T extends { readonly siteId?: string }>(
  items: readonly T[],
  membership: SiteMembership,
): readonly T[] {
  return items.filter((item) =>
    item.siteId === undefined ? hasAllSites(membership) : canAccessSite(membership, item.siteId),
  );
}
