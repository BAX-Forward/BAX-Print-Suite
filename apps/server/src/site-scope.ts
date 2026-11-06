import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  canAccessSite,
  DEFAULT_SITE_ID,
  filterBySite,
  hasAllSites,
  localAdminMembership,
  type Actor,
  type SiteMembership,
} from '@bax-print/core';
import { notFound } from './errors.js';
import { LOCAL_ADMIN } from './route-permissions.js';

/**
 * Spec 030c: opt-in site scoping of the job routes. With `ServerDeps.siteScope` every route under
 * `/jobs/:id` checks that the caller's site membership grants the job's site (its ticket `siteId`,
 * or `DEFAULT_SITE_ID` without one) before the handler runs, and answers 404 `not_found` otherwise,
 * so a caller cannot tell another site's job from a missing one. The job list routes
 * (`GET /archive`, `GET /trash`) drop the jobs of other sites with `filterBySite`. The site comes
 * from the stored job only, never from the request. Without `siteScope` nothing changes.
 */

export const SITE_SCOPE_ENV = 'BPS_SITE_SCOPE';

/** The caller's membership; `undefined` grants no site. */
export type SiteMembershipLookup = (actor: Actor) => SiteMembership | undefined | Promise<SiteMembership | undefined>;

/** The ticket field site scoping reads. */
export interface SiteScopedJob {
  readonly ticket: { readonly siteId?: string };
}

/** Loads a job by id; any job repository satisfies it. */
export interface SiteScopedJobLookup {
  get(id: string): SiteScopedJob | undefined | Promise<SiteScopedJob | undefined>;
}

export interface SiteScopeOptions {
  readonly memberships: SiteMembershipLookup;
  readonly jobs: SiteScopedJobLookup;
}

/** The store package's `SqliteSiteRepository` satisfies it. */
export interface SiteMembershipStore {
  getMembership(userId: string): SiteMembership | undefined;
}

export type SiteScopeEnv = Readonly<Record<string, string | undefined>>;

/** Absent is off and `1` is on; any other value is a configuration error, never a guess. */
export function parseSiteScopeFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${SITE_SCOPE_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

/**
 * Memberships from the job database. The local admin (the actor callers resolve to without a
 * credential) always has every site; it is matched by identity, so no user record can claim it.
 */
export function storeMembershipLookup(store: SiteMembershipStore): SiteMembershipLookup {
  const localAdmin = localAdminMembership(LOCAL_ADMIN.id);
  return (actor) => (actor === LOCAL_ADMIN ? localAdmin : store.getMembership(actor.id));
}

/**
 * Reads BPS_SITE_SCOPE from `env`. `store` is the job database's site repository, or `undefined`
 * without BPS_DATABASE. Throws for an invalid flag and for site scoping without a database.
 */
export function configureSiteScope(
  env: SiteScopeEnv,
  store: SiteMembershipStore | undefined,
  jobs: SiteScopedJobLookup,
): SiteScopeOptions | undefined {
  if (!parseSiteScopeFlag(env[SITE_SCOPE_ENV])) return undefined;
  if (store === undefined) throw new Error(`${SITE_SCOPE_ENV}=1 needs a job database (set BPS_DATABASE)`);
  return { memberships: storeMembershipLookup(store), jobs };
}

/** The site a job belongs to: its ticket `siteId`, or the single-site default. */
export function siteOfJob(job: SiteScopedJob): string {
  return job.ticket.siteId ?? DEFAULT_SITE_ID;
}

/** True for `/jobs/:id` and every route below it. */
export function isJobRoute(url: string): boolean {
  return url === '/jobs/:id' || url.startsWith('/jobs/:id/');
}

function jobIdParam(request: FastifyRequest): string | undefined {
  const params: unknown = request.params;
  if (typeof params !== 'object' || params === null || !('id' in params)) return undefined;
  return typeof params.id === 'string' ? params.id : undefined;
}

export interface SiteScope {
  /** The jobs of `items` the caller's membership grants; `jobIdOf` names each item's job. */
  filterJobs<T>(request: FastifyRequest, items: readonly T[], jobIdOf: (item: T) => string): Promise<T[]>;
  /** Spec 052a: true when the caller's membership grants `siteId`, e.g. the site a new job is created in. */
  grants(request: FastifyRequest, siteId: string): Promise<boolean>;
}

/**
 * Checks every `/jobs/:id` route registered after this call. Call it after `guardRoutes`, so the
 * caller is resolved and authorized first, and before registering any route.
 */
export function scopeJobRoutes(
  app: FastifyInstance,
  options: SiteScopeOptions,
  actorOf: (request: FastifyRequest) => Actor,
): SiteScope {
  const membershipOf = async (request: FastifyRequest): Promise<SiteMembership | undefined> =>
    options.memberships(actorOf(request));

  app.addHook('onRequest', async (request) => {
    if (request.is404 || !isJobRoute(request.routeOptions.url ?? '')) return;
    const id = jobIdParam(request) ?? '';
    const membership = await membershipOf(request);
    if (membership === undefined) throw notFound('Job', id);
    const job = await options.jobs.get(id);
    // A caller with every site sees the route's own answer for a missing job; anyone else the same 404 as for another site's job.
    if (job === undefined) {
      if (hasAllSites(membership)) return;
      throw notFound('Job', id);
    }
    if (!canAccessSite(membership, siteOfJob(job))) throw notFound('Job', id);
  });

  return {
    async filterJobs<T>(request: FastifyRequest, items: readonly T[], jobIdOf: (item: T) => string): Promise<T[]> {
      const membership = await membershipOf(request);
      if (membership === undefined) return [];
      if (hasAllSites(membership)) return [...items];
      const sited = await Promise.all(
        items.map(async (item): Promise<{ readonly item: T; readonly siteId?: string }> => {
          const job = await options.jobs.get(jobIdOf(item));
          // A job that is no longer stored has no known site, so only an all-sites caller sees it.
          return job === undefined ? { item } : { item, siteId: siteOfJob(job) };
        }),
      );
      return filterBySite(sited, membership).map(({ item }) => item);
    },
    async grants(request: FastifyRequest, siteId: string): Promise<boolean> {
      const membership = await membershipOf(request);
      return membership !== undefined && canAccessSite(membership, siteId);
    },
  };
}
