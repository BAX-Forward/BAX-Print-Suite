import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  effectivePermissions,
  ForbiddenError,
  requirePermission,
  type Actor,
  type Permission,
  type PermissionRole,
} from '@bax-print/core';
import { HttpError } from './errors.js';

/**
 * Spec 024b: every route checks a core permission (spec 024a) before it does any work. The check
 * runs in `onRequest`, before the body is parsed or validated. Deny by default: a route missing
 * from `ROUTE_PERMISSIONS` answers 403 to every caller, and the route permission test fails.
 */

/** `METHOD /url` as Fastify registers the route, e.g. `GET /jobs/:id/history`. */
export type RouteKey = string;

/**
 * Routes anyone may call: the health check (when mounted), the OpenAPI document and the Spec 028d
 * login routes, which check the credentials they are sent themselves.
 */
export const PUBLIC_ROUTES: ReadonlySet<RouteKey> = new Set(['GET /health', 'GET /openapi.json', 'POST /login', 'POST /logout']);

/** The permission each route needs. `HEAD` routes need what their `GET` route needs. */
export const ROUTE_PERMISSIONS: Readonly<Record<RouteKey, Permission>> = Object.freeze({
  // Spec 005 media library, color setups, presets and profiling sessions.
  'GET /media': 'media:read',
  'POST /media': 'media:write',
  'POST /media/sync': 'media:write',
  'GET /media/:id': 'media:read',
  'PUT /media/:id': 'media:write',
  'DELETE /media/:id': 'media:delete',
  'GET /media/:id/modes': 'media:read',
  'POST /media/:id/modes': 'media:write',
  'GET /color-setups/:id/revisions': 'media:read',
  'POST /color-setups/:id/revisions': 'media:write',
  'POST /color-setups/:id/revisions/:revisionId/publish': 'media:write',
  'GET /presets': 'media:read',
  'POST /presets': 'media:write',
  'GET /presets/:id': 'media:read',
  'PUT /presets/:id': 'media:write',
  'DELETE /presets/:id': 'media:delete',
  'POST /profiling-sessions': 'media:write',
  'GET /profiling-sessions/:id': 'media:read',
  'POST /profiling-sessions/:id/steps/:stepId/complete': 'media:write',
  // Spec 007 preflight.
  'GET /preflight-checks': 'jobs:read',
  'GET /preflight-profiles': 'jobs:read',
  'GET /preflight-profiles/:id': 'jobs:read',
  'POST /preflight-profiles': 'jobs:write',
  'PUT /preflight-profiles/:id': 'jobs:write',
  'DELETE /preflight-profiles/:id': 'jobs:delete',
  'GET /jobs/:id/findings': 'jobs:read',
  'POST /jobs/:id/inspect': 'jobs:write',
  'PATCH /jobs/:id/edits': 'jobs:write',
  'POST /jobs/:id/preflight/override': 'jobs:write',
  'POST /jobs/:id/normalize': 'jobs:write',
  // Spec 019b webhooks.
  'POST /webhooks': 'webhooks:write',
  'GET /webhooks': 'webhooks:read',
  'DELETE /webhooks/:id': 'webhooks:delete',
  'GET /webhooks/:id/deliveries': 'webhooks:read',
  // Spec 029c API tokens. Core has no token permission, so they reuse the admin-only webhook permissions.
  'POST /api-tokens': 'webhooks:write',
  'GET /api-tokens': 'webhooks:read',
  'DELETE /api-tokens/:id': 'webhooks:delete',
  // Spec 007g cut jobs, 003u step and repeat, 004a proofs.
  'POST /jobs/:id/cut-job': 'jobs:write',
  'POST /jobs/:id/step-repeat': 'jobs:write',
  'POST /jobs/:id/proof': 'jobs:read',
  // Spec 034a print output.
  'POST /jobs/:id/print': 'jobs:write',
  'GET /jobs/:id/print/:outputJobId': 'jobs:read',
  'DELETE /jobs/:id/print/:outputJobId': 'jobs:write',
  // Spec 032b swatch charts: a read like the proof route; nothing is stored.
  'POST /swatch-charts': 'jobs:read',
  // Spec 036b imposition plans: a read like the swatch charts; nothing is rendered or stored.
  'POST /imposition/n-up': 'jobs:read',
  'POST /imposition/booklet': 'jobs:read',
  // Spec 036e imposed sheets: a read like the proof route; the PDF is answered, not stored.
  'POST /jobs/:id/impose': 'jobs:read',
  // Spec 003x layout templates.
  'POST /layout-templates': 'layouts:write',
  'GET /layout-templates': 'layouts:read',
  'GET /layout-templates/:id': 'layouts:read',
  'PATCH /layout-templates/:id': 'layouts:write',
  'DELETE /layout-templates/:id': 'layouts:delete',
  // Spec 004d finishing plans; the permission model has no `finishing:delete`.
  'PUT /jobs/:id/finishing': 'finishing:write',
  'GET /jobs/:id/finishing': 'finishing:read',
  'POST /jobs/:id/finishing/steps/:index/start': 'finishing:write',
  'POST /jobs/:id/finishing/steps/:index/complete': 'finishing:write',
  'POST /jobs/:id/finishing/steps/:index/skip': 'finishing:write',
  'DELETE /jobs/:id/finishing': 'finishing:write',
  'GET /finishing/incomplete': 'finishing:read',
  // Spec 023b production report.
  'GET /reports/production': 'reports:read',
  // Spec 017d accounting IDs.
  'PUT /jobs/:id/accounting-id': 'jobs:write',
  'GET /reports/accounting': 'reports:read',
  // Spec 038c white ink setting: a job change like `PATCH /jobs/:id/edits`.
  'PUT /jobs/:id/white-ink': 'jobs:write',
  'DELETE /jobs/:id/white-ink': 'jobs:write',
  // Archive, trash, legal hold and job history.
  'GET /archive': 'archive:read',
  'GET /archive/:id': 'archive:read',
  'GET /archive/:id/package': 'archive:read',
  'POST /jobs/:id/archive': 'archive:write',
  'POST /archive/:id/restore': 'archive:write',
  'POST /archive/:id/reprint': 'archive:write',
  'POST /archive/import': 'archive:write',
  'DELETE /jobs/:id': 'jobs:delete',
  'DELETE /archive/:id': 'archive:delete',
  'GET /trash': 'archive:read',
  'POST /trash/:id/restore': 'archive:write',
  'PUT /jobs/:id/legal-hold': 'archive:write',
  'GET /jobs/:id/history': 'jobs:read',
  'GET /jobs/:id/xjdf': 'jobs:read',
});

const PERMISSION_BY_ROUTE: ReadonlyMap<RouteKey, Permission> = new Map(Object.entries(ROUTE_PERMISSIONS));

/** Each actor role and the permission role it holds. A role missing here holds no permissions. */
const PERMISSION_ROLE_BY_ACTOR_ROLE: ReadonlyMap<string, PermissionRole> = new Map<string, PermissionRole>([
  ['viewer', 'viewer'],
  ['operator', 'operator'],
  ['admin', 'admin'],
]);

/**
 * The actor used when `ServerDeps.authenticate` is not set. Single-PC mode binds to loopback
 * without auth (ARCHITECTURE §6), so the local caller is the admin.
 */
export const LOCAL_ADMIN: Actor = { id: 'local', role: 'admin' };

export function routeKey(method: string, url: string): RouteKey {
  const upper = method.toUpperCase();
  return `${upper === 'HEAD' ? 'GET' : upper} ${url}`;
}

export function isPublicRoute(method: string, url: string): boolean {
  return PUBLIC_ROUTES.has(routeKey(method, url));
}

/** The permission a route needs, or `undefined` when none is declared. */
export function routePermission(method: string, url: string): Permission | undefined {
  return PERMISSION_BY_ROUTE.get(routeKey(method, url));
}

/** The permission roles of an actor; an unmapped role, even one the permission model knows, has none. */
export function permissionRolesOf(actor: Actor): readonly PermissionRole[] {
  const role = PERMISSION_ROLE_BY_ACTOR_ROLE.get(actor.role);
  return role === undefined ? [] : [role];
}

/** Spec 029c: the explicit permissions of actors made by `scopedActor`, kept off the actor so they never reach history. */
const SCOPES_BY_ACTOR = new WeakMap<Actor, readonly Permission[]>();

/**
 * Spec 029c: a copy of `actor` whose permissions are exactly `scopes`, e.g. an API token's. The
 * guard checks the scopes instead of the role; a handler that checks the role itself still sees it.
 */
export function scopedActor(actor: Actor, scopes: readonly Permission[]): Actor {
  const scoped: Actor = Object.freeze({ ...actor });
  SCOPES_BY_ACTOR.set(scoped, Object.freeze([...scopes]));
  return scoped;
}

/** The explicit scopes of an actor made by `scopedActor`, or `undefined` for a role-based actor. */
export function scopesOf(actor: Actor): readonly Permission[] | undefined {
  return SCOPES_BY_ACTOR.get(actor);
}

/** Every permission the actor holds: its scopes when it has them, else those of its role. */
export function permissionsOf(actor: Actor): readonly Permission[] {
  return scopesOf(actor) ?? effectivePermissions(permissionRolesOf(actor));
}

/** Like core `requirePermission`, but an actor with explicit scopes holds only those. */
export function requireActorPermission(actor: Actor, permission: Permission, action: string): void {
  const scopes = scopesOf(actor);
  if (scopes === undefined) {
    requirePermission(permissionRolesOf(actor), permission, action);
  } else if (!scopes.includes(permission)) {
    throw new ForbiddenError(action, { permission });
  }
}

const registeredRoutes = new WeakMap<FastifyInstance, Set<RouteKey>>();

/** Every route registered on an app guarded by `guardRoutes`, `HEAD` routes folded into `GET`. */
export function routesOf(app: FastifyInstance): readonly RouteKey[] {
  return [...(registeredRoutes.get(app) ?? [])];
}

/**
 * Checks the permission of every route registered after this call against the actor
 * `actorOf` resolves. Call it before registering any route. Spec 028c: `actorOf` may be async;
 * it runs once per guarded request, and never for public routes or unknown URLs.
 */
export function guardRoutes(app: FastifyInstance, actorOf: (request: FastifyRequest) => Actor | Promise<Actor>): void {
  const routes = new Set<RouteKey>();
  registeredRoutes.set(app, routes);

  app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      routes.add(routeKey(String(method), route.url));
    }
  });

  app.addHook('onRequest', async (request) => {
    // Unknown URLs fall through to the 404 handler.
    if (request.is404) return;
    const url = request.routeOptions.url ?? '';
    if (isPublicRoute(request.method, url)) return;
    const key = routeKey(request.method, url);
    const permission = routePermission(request.method, url);
    if (permission === undefined) {
      throw new HttpError(403, 'forbidden', `No permission is declared for ${key}`);
    }
    requireActorPermission(await actorOf(request), permission, key);
  });
}
