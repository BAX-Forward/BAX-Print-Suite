import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { createSiteMembership, type Actor, type SiteMembership } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { LOCAL_ADMIN } from '../src/route-permissions.js';
import {
  configureSiteScope,
  parseSiteScopeFlag,
  SITE_SCOPE_ENV,
  storeMembershipLookup,
  type SiteMembershipLookup,
} from '../src/site-scope.js';
import { fakeClock, finish, sequentialIds, TICKET } from './helpers.js';

const NORTH_MEMBER: Actor = { id: 'north-admin', role: 'admin' };
const SOUTH_MEMBER: Actor = { id: 'south-admin', role: 'admin' };
const EVERY_SITE: Actor = { id: 'hq-admin', role: 'admin' };
const DEFAULT_MEMBER: Actor = { id: 'default-admin', role: 'admin' };
const NO_MEMBERSHIP: Actor = { id: 'nobody', role: 'admin' };

const MEMBERSHIPS: ReadonlyMap<string, SiteMembership> = new Map([
  [NORTH_MEMBER.id, createSiteMembership({ userId: NORTH_MEMBER.id, siteIds: ['north'] })],
  [SOUTH_MEMBER.id, createSiteMembership({ userId: SOUTH_MEMBER.id, siteIds: ['south'] })],
  [EVERY_SITE.id, createSiteMembership({ userId: EVERY_SITE.id, allSites: true })],
  [DEFAULT_MEMBER.id, createSiteMembership({ userId: DEFAULT_MEMBER.id, siteIds: ['default'] })],
]);

const lookup: SiteMembershipLookup = (actor) => MEMBERSHIPS.get(actor.id);

interface Harness {
  readonly app: FastifyInstance;
  /** Job ids by site; `none` has no `siteId` on its ticket. */
  readonly ids: { readonly north: string; readonly south: string; readonly none: string };
  /** The caller of the next request. */
  as(actor: Actor): void;
}

async function createHarness(options: { scoped: boolean; memberships?: SiteMembershipLookup; resolver?: boolean }): Promise<Harness> {
  const time = fakeClock('2026-03-01T08:00:00.000Z');
  const outbox = new MemoryOutbox();
  const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
  const jobs = new MemoryJobRepository();
  const blobs = new MemoryStorage();
  const newId = sequentialIds('job');
  const service = new JobService({ jobs, blobs, bus, clock: time.clock, newId });
  const archive = new ArchiveService({
    jobs,
    index: new MemoryArchiveIndex(),
    blobs,
    archive: new MemoryStorage(),
    bus,
    outbox,
    colorSetups: new StaticColorSetupResolver(),
    clock: time.clock,
    newId,
  });
  const create = async (name: string, siteId?: string): Promise<string> => {
    const job = await service.create({
      name,
      sources: [{ name: `${name}.pdf`, bytes: Buffer.from(`%PDF-1.7 ${name}`) }],
      ticket: siteId === undefined ? TICKET : { ...TICKET, siteId },
    });
    // Only a job in a terminal status can be trashed.
    await finish(service, job.id);
    return job.id;
  };
  const ids = { north: await create('north-job', 'north'), south: await create('south-job', 'south'), none: await create('legacy-job') };
  let caller: Actor = EVERY_SITE;
  const app = buildServer({
    archive,
    ...(options.resolver === false ? {} : { authenticate: () => caller }),
    ...(options.scoped ? { siteScope: { memberships: options.memberships ?? lookup, jobs } } : {}),
  });
  return {
    app,
    ids,
    as: (actor) => {
      caller = actor;
    },
  };
}

async function trashAll(h: Harness): Promise<void> {
  h.as(EVERY_SITE);
  for (const id of Object.values(h.ids)) {
    const response = await h.app.inject({ method: 'DELETE', url: `/jobs/${id}` });
    expect(response.statusCode).toBe(200);
  }
}

async function trashedIds(h: Harness, actor: Actor): Promise<string[]> {
  h.as(actor);
  const response = await h.app.inject({ method: 'GET', url: '/trash' });
  expect(response.statusCode).toBe(200);
  return response
    .json<{ items: { id: string }[] }>()
    .items.map((job) => job.id)
    .sort();
}

const historyOf = (h: Harness, id: string, headers: Record<string, string> = {}) =>
  h.app.inject({ method: 'GET', url: `/jobs/${id}/history`, headers });

describe('site scoping (Spec 030c)', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it("lets a member load a job of the member's own site", async () => {
    h = await createHarness({ scoped: true });
    h.as(NORTH_MEMBER);

    const response = await historyOf(h, h.ids.north);

    expect(response.statusCode).toBe(200);
  });

  it("answers 404 not_found for another site's job, exactly like a missing job", async () => {
    h = await createHarness({ scoped: true });
    h.as(NORTH_MEMBER);

    const otherSite = await historyOf(h, h.ids.south);
    const legalHold = await h.app.inject({ method: 'PUT', url: `/jobs/${h.ids.south}/legal-hold`, payload: { hold: true } });
    const missing = await historyOf(h, 'no-such-job');

    expect(otherSite.statusCode).toBe(404);
    expect(otherSite.json()).toEqual({ error: { code: 'not_found', message: `Job ${h.ids.south} not found` } });
    expect(legalHold.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'not_found', message: 'Job no-such-job not found' } });
  });

  it('answers 404 to a caller without a membership, who is granted no site', async () => {
    h = await createHarness({ scoped: true });
    h.as(NO_MEMBERSHIP);

    for (const id of Object.values(h.ids)) {
      expect((await historyOf(h, id)).statusCode).toBe(404);
    }
  });

  it("does not delete another site's job", async () => {
    h = await createHarness({ scoped: true });
    h.as(SOUTH_MEMBER);

    const response = await h.app.inject({ method: 'DELETE', url: `/jobs/${h.ids.north}` });
    h.as(NORTH_MEMBER);

    expect(response.statusCode).toBe(404);
    expect((await historyOf(h, h.ids.north)).statusCode).toBe(200);
    expect(await trashedIds(h, EVERY_SITE)).toEqual([]);
  });

  it('lets an all-sites member load every job', async () => {
    h = await createHarness({ scoped: true });
    h.as(EVERY_SITE);

    for (const id of Object.values(h.ids)) {
      expect((await historyOf(h, id)).statusCode).toBe(200);
    }
  });

  it('puts a job without a siteId in the default site', async () => {
    h = await createHarness({ scoped: true });
    h.as(DEFAULT_MEMBER);

    expect((await historyOf(h, h.ids.none)).statusCode).toBe(200);
    expect((await historyOf(h, h.ids.north)).statusCode).toBe(404);
  });

  it('never takes the site from the request', async () => {
    h = await createHarness({ scoped: true });
    h.as(NORTH_MEMBER);

    const response = await h.app.inject({
      method: 'GET',
      url: `/jobs/${h.ids.south}/history?siteId=north`,
      headers: { 'x-site-id': 'north', 'x-bps-site': 'north' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('lists only the trashed jobs of granted sites', async () => {
    h = await createHarness({ scoped: true });
    await trashAll(h);

    expect(await trashedIds(h, NORTH_MEMBER)).toEqual([h.ids.north]);
    expect(await trashedIds(h, DEFAULT_MEMBER)).toEqual([h.ids.none]);
    expect(await trashedIds(h, NO_MEMBERSHIP)).toEqual([]);
    expect(await trashedIds(h, EVERY_SITE)).toEqual(Object.values(h.ids).sort());
  });

  it('gives the local admin every site even when the store has no membership for it', async () => {
    h = await createHarness({ scoped: true, resolver: false, memberships: storeMembershipLookup({ getMembership: () => undefined }) });

    for (const id of Object.values(h.ids)) {
      expect((await historyOf(h, id)).statusCode).toBe(200);
    }
  });

  it('does not treat an actor that only shares the local admin id as the local admin', async () => {
    h = await createHarness({ scoped: true, memberships: storeMembershipLookup({ getMembership: () => undefined }) });
    h.as({ id: LOCAL_ADMIN.id, role: 'admin' });

    expect((await historyOf(h, h.ids.north)).statusCode).toBe(404);
  });

  it('changes nothing when site scoping is not configured', async () => {
    h = await createHarness({ scoped: false });
    h.as(NO_MEMBERSHIP);

    for (const id of Object.values(h.ids)) {
      expect((await historyOf(h, id)).statusCode).toBe(200);
    }
    // The route's own answer: the empty history of a job that has no events.
    const missing = await historyOf(h, 'no-such-job');
    expect(missing.statusCode).toBe(200);
    expect(missing.body).toBe('');
    await trashAll(h);
    expect(await trashedIds(h, NO_MEMBERSHIP)).toEqual(Object.values(h.ids).sort());
  });
});

describe('BPS_SITE_SCOPE (Spec 030c)', () => {
  const store = { getMembership: (): SiteMembership | undefined => undefined };
  const jobs = new MemoryJobRepository();

  it('is off when unset and on only for 1', () => {
    expect(parseSiteScopeFlag(undefined)).toBe(false);
    expect(parseSiteScopeFlag('1')).toBe(true);
  });

  it.each(['', '0', 'true', 'yes', ' 1'])('rejects %j', (value) => {
    expect(() => parseSiteScopeFlag(value)).toThrow(SITE_SCOPE_ENV);
  });

  it('configures nothing without the flag, even with a database', () => {
    expect(configureSiteScope({}, store, jobs)).toBeUndefined();
  });

  it('needs a job database', () => {
    expect(() => configureSiteScope({ [SITE_SCOPE_ENV]: '1' }, undefined, jobs)).toThrow('BPS_DATABASE');
  });

  it('scopes by the store memberships with the flag and a database', () => {
    const options = configureSiteScope({ [SITE_SCOPE_ENV]: '1' }, store, jobs);

    expect(options?.jobs).toBe(jobs);
    expect(options?.memberships(LOCAL_ADMIN)).toEqual({ userId: LOCAL_ADMIN.id, allSites: true });
    expect(options?.memberships(NORTH_MEMBER)).toBeUndefined();
  });

  it('stops on an invalid flag', () => {
    expect(() => configureSiteScope({ [SITE_SCOPE_ENV]: 'on' }, store, jobs)).toThrow(SITE_SCOPE_ENV);
  });
});
