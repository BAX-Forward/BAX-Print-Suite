import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SITE_ID,
  InvalidArgumentError,
  canAccessSite,
  createSite,
  createSiteMembership,
  filterBySite,
  hasAllSites,
  localAdminMembership,
  parseSiteId,
  parseTimeZone,
  type CreateSiteInput,
  type CreateSiteMembershipInput,
  type SiteMembership,
} from '../src/index.js';

interface SiteScoped {
  readonly name: string;
  readonly siteId?: string;
}

const NOW = new Date('2026-11-05T09:30:00.000Z');

describe('parseSiteId', () => {
  it.each(['ab', 'north-hall', 'site-2', '0a', 'a'.repeat(32), DEFAULT_SITE_ID])('accepts %j', (id) => {
    expect(parseSiteId(id)).toBe(id);
  });

  it('trims surrounding whitespace', () => {
    expect(parseSiteId('  east  ')).toBe('east');
  });

  it.each<[unknown, string]>([
    ['', 'empty'],
    ['a', 'too short'],
    ['a'.repeat(33), 'too long'],
    ['-ab', 'leading dash'],
    ['ab-', 'trailing dash'],
    ['--', 'only dashes'],
    ['North', 'uppercase'],
    ['north hall', 'space'],
    ['north_hall', 'underscore'],
    ['nörd', 'non-ASCII'],
    [12, 'number'],
    [null, 'null'],
    [undefined, 'undefined'],
  ])('rejects %j (%s)', (input) => {
    expect(() => parseSiteId(input)).toThrow(InvalidArgumentError);
  });
});

describe('parseTimeZone', () => {
  it.each(['UTC', 'Europe/Berlin', 'America/New_York'])('accepts %j', (zone) => {
    expect(parseTimeZone(zone)).toBe(zone);
  });

  it.each<[unknown, string]>([
    ['', 'empty'],
    ['   ', 'blank'],
    ['Mars/Olympus_Mons', 'unknown zone'],
    ['not a zone', 'garbage'],
    [3, 'number'],
  ])('rejects %j (%s)', (input) => {
    expect(() => parseTimeZone(input)).toThrow(InvalidArgumentError);
  });
});

describe('createSite', () => {
  it('builds a frozen site with normalized fields', () => {
    const site = createSite({ id: ' north-hall ', name: '  North Hall  ', timeZone: 'Europe/Berlin' }, NOW);
    expect(site).toEqual({
      id: 'north-hall',
      name: 'North Hall',
      timeZone: 'Europe/Berlin',
      createdAt: '2026-11-05T09:30:00.000Z',
    });
    expect(Object.isFrozen(site)).toBe(true);
  });

  it.each<[CreateSiteInput, string]>([
    [{ id: 'a', name: 'A', timeZone: 'UTC' }, 'bad id'],
    [{ id: 'ab', name: '   ', timeZone: 'UTC' }, 'blank name'],
    [{ id: 'ab', name: 'x'.repeat(129), timeZone: 'UTC' }, 'long name'],
    [{ id: 'ab', name: 4, timeZone: 'UTC' }, 'name not a string'],
    [{ id: 'ab', name: 'A', timeZone: 'Nowhere/Land' }, 'bad time zone'],
  ])('rejects %j (%s)', (input) => {
    expect(() => createSite(input, NOW)).toThrow(InvalidArgumentError);
  });

  it('rejects an invalid date', () => {
    expect(() => createSite({ id: 'ab', name: 'A', timeZone: 'UTC' }, new Date(Number.NaN))).toThrow(
      InvalidArgumentError,
    );
  });
});

describe('createSiteMembership', () => {
  it('sorts and de-duplicates site IDs', () => {
    const membership = createSiteMembership({ userId: 'u1', siteIds: ['west', ' east ', 'west'] });
    expect(membership).toEqual({ userId: 'u1', siteIds: ['east', 'west'] });
    expect(Object.isFrozen(membership)).toBe(true);
  });

  it('builds an all-sites membership', () => {
    expect(createSiteMembership({ userId: 'u1', allSites: true })).toEqual({ userId: 'u1', allSites: true });
  });

  it.each<[CreateSiteMembershipInput, string]>([
    [{ userId: 'u1', siteIds: [] }, 'empty siteIds'],
    [{ userId: 'u1' }, 'no siteIds and no allSites'],
    [{ userId: 'u1', allSites: false }, 'allSites false without siteIds'],
    [{ userId: 'u1', allSites: true, siteIds: ['east'] }, 'both allSites and siteIds'],
    [{ userId: 'u1', siteIds: ['East'] }, 'invalid site ID'],
    [{ userId: 'u1', siteIds: [7] }, 'site ID not a string'],
    [{ userId: '  ', siteIds: ['east'] }, 'blank userId'],
    [{ userId: 5, siteIds: ['east'] }, 'userId not a string'],
  ])('rejects %j (%s)', (input) => {
    expect(() => createSiteMembership(input)).toThrow(InvalidArgumentError);
  });
});

describe('canAccessSite', () => {
  const listed = createSiteMembership({ userId: 'u1', siteIds: ['east', 'west'] });
  const all = createSiteMembership({ userId: 'admin', allSites: true });

  it('allows listed sites only', () => {
    expect(canAccessSite(listed, 'east')).toBe(true);
    expect(canAccessSite(listed, 'west')).toBe(true);
    expect(canAccessSite(listed, 'north')).toBe(false);
    expect(canAccessSite(listed, DEFAULT_SITE_ID)).toBe(false);
  });

  it('does not match a site ID that differs in case or whitespace', () => {
    expect(canAccessSite(listed, 'East')).toBe(false);
    expect(canAccessSite(listed, ' east')).toBe(false);
  });

  it('allows every site with allSites', () => {
    expect(canAccessSite(all, 'north')).toBe(true);
    expect(canAccessSite(all, DEFAULT_SITE_ID)).toBe(true);
    expect(hasAllSites(all)).toBe(true);
    expect(hasAllSites(listed)).toBe(false);
  });

  it('denies a membership with no sites that bypassed validation', () => {
    const empty: SiteMembership = { userId: 'u2', siteIds: [] };
    expect(canAccessSite(empty, 'east')).toBe(false);
  });
});

describe('filterBySite', () => {
  const items: readonly SiteScoped[] = [
    { name: 'a', siteId: 'east' },
    { name: 'b', siteId: 'west' },
    { name: 'c', siteId: 'north' },
    { name: 'd' },
  ];

  it('keeps only items on listed sites and hides items without a site', () => {
    const membership = createSiteMembership({ userId: 'u1', siteIds: ['east', 'north'] });
    expect(filterBySite(items, membership).map((item) => item.name)).toEqual(['a', 'c']);
  });

  it('keeps every item, including those without a site, with allSites', () => {
    const membership = createSiteMembership({ userId: 'admin', allSites: true });
    expect(filterBySite(items, membership).map((item) => item.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns a new array and leaves the input unchanged', () => {
    const membership = createSiteMembership({ userId: 'u1', siteIds: ['east'] });
    const result = filterBySite(items, membership);
    expect(result).not.toBe(items);
    expect(items).toHaveLength(4);
  });
});

describe('single-site default', () => {
  it('uses "default" as the site ID, which is a valid site ID', () => {
    expect(DEFAULT_SITE_ID).toBe('default');
    expect(parseSiteId(DEFAULT_SITE_ID)).toBe(DEFAULT_SITE_ID);
  });

  it('gives the local admin every site', () => {
    const membership = localAdminMembership('admin');
    expect(membership).toEqual({ userId: 'admin', allSites: true });
    expect(canAccessSite(membership, DEFAULT_SITE_ID)).toBe(true);
    const items: readonly SiteScoped[] = [{ name: 'a' }, { name: 'b', siteId: DEFAULT_SITE_ID }];
    expect(filterBySite(items, membership)).toHaveLength(2);
  });

  it('rejects a blank user ID', () => {
    expect(() => localAdminMembership(' ')).toThrow(InvalidArgumentError);
  });
});
