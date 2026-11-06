import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { parseSearchQuery, type ArchiveService } from '@bax-print/archive';
import { InvalidArgumentError, type Actor } from '@bax-print/core';
import { toJsonl } from '@bax-print/events';
import { sanitizeKeySegment, type LayoutTemplateRepository } from '@bax-print/store';
import { registerAccountingRoutes, type AccountingRouteOptions } from './accounting-routes.js';
import { registerApiTokenRoutes, type ApiTokenRouteOptions } from './api-token-routes.js';
import { registerCutRoutes, type CutExtractor, type CutJobLookup } from './cut-routes.js';
import { registerFinishingRoutes, type FinishingRouteOptions } from './finishing-routes.js';
import { registerLayoutTemplateRoutes } from './layout-template-routes.js';
import { registerLoginRoutes, type LoginRouteOptions } from './login-routes.js';
import { registerMediaRoutes } from './media-routes.js';
import type { MediaService } from './media-service.js';
import { OpenApiCollector } from './openapi.js';
import { parseImportQuery, parseLegalHoldBody, parseReprintBody } from './parse.js';
import { registerProductionReportRoutes, type ProductionReportRouteOptions } from './production-report-routes.js';
import { registerProofRoutes, type ProofRouteOptions } from './proof-routes.js';
import { guardRoutes, LOCAL_ADMIN } from './route-permissions.js';
import { registerErrorHandler, registerPreflightRoutes, type RouteDeps } from './routes.js';
import { registerStepRepeatRoutes, type StepRepeatRouteOptions } from './step-repeat-routes.js';
import { httpsServerFactory, type HttpsOptions } from './tls.js';
import { registerWebhookRoutes, type WebhookOptions } from './webhook-routes.js';

export const DEFAULT_IMPORT_BODY_LIMIT = 1024 ** 3;
export const DEFAULT_API_VERSION = '0.1.0';

/** The Spec 007 services behind the preflight routes. */
export type PreflightDeps = Omit<RouteDeps, 'authenticate'>;

export interface ServerDeps {
  readonly archive: ArchiveService;
  /** Mounts the Spec 007 preflight routes. */
  readonly preflight?: PreflightDeps;
  /** Mounts the Spec 005 media routes and `GET /openapi.json`. */
  readonly media?: MediaService;
  /**
   * Mounts the Spec 019b webhook routes and delivers every event published on `webhooks.bus` to
   * the matching subscriptions. Tests replace `send`, `now` and `schedule`.
   */
  readonly webhooks?: WebhookOptions;
  /** Mounts the Spec 007g `POST /jobs/:id/cut-job` route over these jobs. */
  readonly jobs?: CutJobLookup;
  /** Reads a job's page for `POST /jobs/:id/cut-job`; without one that route answers 501. Tests inject a fake. */
  readonly cutExtractor?: CutExtractor;
  /** With `jobs`, mounts the Spec 003u `POST /jobs/:id/step-repeat` route. Tests replace `run`. */
  readonly stepRepeat?: StepRepeatRouteOptions;
  /** With `jobs`, mounts the Spec 004a `POST /jobs/:id/proof` route. */
  readonly proof?: ProofRouteOptions;
  /** Mounts the Spec 003x `/layout-templates` routes; the store package's `SqliteLayoutTemplateRepository` satisfies it. */
  readonly layoutTemplates?: LayoutTemplateRepository;
  /** Mounts the Spec 004d finishing plan routes; the store package's `SqliteFinishingPlanRepository` satisfies `plans`. */
  readonly finishing?: FinishingRouteOptions;
  /** Mounts the Spec 023b `GET /reports/production` route over these jobs; any job repository satisfies `jobs`. */
  readonly productionReport?: ProductionReportRouteOptions;
  /**
   * Mounts the Spec 017d `PUT /jobs/:id/accounting-id` route over these jobs, and `GET /reports/accounting`
   * when `reports` provides the device accounting reports; any job repository satisfies `jobs`.
   */
  readonly accounting?: AccountingRouteOptions;
  /**
   * Mounts the Spec 029c `/api-tokens` routes; the store package's `SqliteApiTokenRepository` satisfies
   * `tokens`. Pair it with `createBearerTokenVerifier` in `authenticate` so the tokens are accepted.
   */
  readonly apiTokens?: ApiTokenRouteOptions;
  /**
   * Mounts the Spec 028d `POST /login` and `POST /logout` routes. Pair it with an `authenticate`
   * that recognizes the sessions, e.g. what `configureLogin` from `session-config.ts` returns.
   */
  readonly login?: LoginRouteOptions;
  /** `info.version` of the OpenAPI document. */
  readonly version?: string;
  /**
   * Resolves the caller. Every route but `GET /openapi.json` checks a permission of the caller's
   * role (Spec 024b, `route-permissions.ts`). Single-PC mode binds to loopback without auth
   * (ARCHITECTURE §6), so without a resolver every caller is the local admin (`LOCAL_ADMIN`) and
   * holds every permission. Server mode, reachable beyond loopback, must supply a real resolver.
   * Spec 028c: the resolver may be async, e.g. `createActorResolver` from `actor-resolver.ts`; it
   * runs once per guarded request, before the body is parsed.
   */
  readonly authenticate?: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly importBodyLimit?: number;
  readonly logger?: boolean;
  /** Spec 029d: serve over HTTPS with these options (see `loadHttpsOptions`); without them the server speaks plain HTTP. */
  readonly https?: HttpsOptions;
}

const LOOPBACK_IPV4 = /^127(\.\d{1,3}){3}$/;

/** True for `localhost`, `127.0.0.0/8` and `::1`, with or without IPv6 brackets or the IPv4-mapped prefix. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (bare === 'localhost' || bare === '::1') return true;
  return LOOPBACK_IPV4.test(bare.replace(/^::ffff:/, ''));
}

/**
 * Spec 024b: the startup warning for a server that treats every caller as the local admin
 * while it listens beyond loopback, or `undefined` when there is nothing to warn about.
 */
export function localAdminWarning(deps: Pick<ServerDeps, 'authenticate'>, host: string): string | undefined {
  if (deps.authenticate || isLoopbackHost(host)) return undefined;
  return `BPS_HOST ${host} is not a loopback address and no actor resolver is configured: every caller is treated as the local admin`;
}

/**
 * One Fastify instance for the archive, preflight and media routes. Every route answers errors
 * with `{ error: { code, message, details? } }` from the one handler in `registerErrorHandler`,
 * and every route but the OpenAPI document checks its permission first (Spec 024b).
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    ...(deps.https === undefined ? {} : { serverFactory: httpsServerFactory(deps.https) }),
  });
  const authenticate = deps.authenticate ?? ((): Actor => LOCAL_ADMIN);
  // Spec 028c: the guard resolves the actor once, so handlers read it synchronously.
  const actors = new WeakMap<FastifyRequest, Actor>();
  const resolveActor = async (request: FastifyRequest): Promise<Actor> => {
    const actor = await authenticate(request);
    actors.set(request, actor);
    return actor;
  };
  const actorOf = (request: FastifyRequest): Actor => {
    const actor = actors.get(request);
    // Only a route outside the guard could get here; answer 500 rather than guess an actor.
    if (actor === undefined) throw new Error(`no actor was resolved for ${request.method} ${request.url}`);
    return actor;
  };
  const importBodyLimit = deps.importBodyLimit ?? DEFAULT_IMPORT_BODY_LIMIT;
  const { archive } = deps;

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: importBodyLimit }, (_request, body, done) => {
    done(null, body);
  });

  registerErrorHandler(app);
  // Before any route, so every route is guarded.
  guardRoutes(app, resolveActor);

  // Registered first so its `onRoute` hook documents the media routes.
  if (deps.media) {
    registerMediaRoutes(app, { media: deps.media, openapi: new OpenApiCollector(deps.version ?? DEFAULT_API_VERSION) });
  }

  if (deps.login) {
    registerLoginRoutes(app, deps.login);
  }

  if (deps.preflight) {
    registerPreflightRoutes(app, { ...deps.preflight, authenticate: actorOf });
  }

  if (deps.webhooks) {
    registerWebhookRoutes(app, { ...deps.webhooks, authenticate: actorOf });
  }

  if (deps.jobs) {
    registerCutRoutes(app, { jobs: deps.jobs, ...(deps.cutExtractor ? { extractor: deps.cutExtractor } : {}) });
  }

  if (deps.jobs && deps.stepRepeat) {
    registerStepRepeatRoutes(app, { jobs: deps.jobs, ...deps.stepRepeat });
  }

  if (deps.jobs && deps.proof) {
    registerProofRoutes(app, { jobs: deps.jobs, ...deps.proof });
  }

  if (deps.layoutTemplates) {
    registerLayoutTemplateRoutes(app, { templates: deps.layoutTemplates });
  }

  if (deps.finishing) {
    registerFinishingRoutes(app, { ...deps.finishing, authenticate: actorOf });
  }

  if (deps.productionReport) {
    registerProductionReportRoutes(app, deps.productionReport);
  }

  if (deps.accounting) {
    registerAccountingRoutes(app, deps.accounting);
  }

  if (deps.apiTokens) {
    registerApiTokenRoutes(app, { ...deps.apiTokens, authenticate: actorOf });
  }

  app.get('/archive', async (request) => archive.search(parseSearchQuery(request.query as Record<string, unknown>)));

  app.get<{ Params: { id: string } }>('/archive/:id', async (request) => archive.getIndexRow(request.params.id));

  app.get<{ Params: { id: string } }>('/archive/:id/package', async (request, reply) => {
    const bytes = await archive.getPackage(request.params.id);
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${sanitizeKeySegment(request.params.id)}.bpsjob"`)
      .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/archive', async (request) =>
    archive.archive(request.params.id, actorOf(request)),
  );

  app.post<{ Params: { id: string } }>('/archive/:id/restore', async (request) => ({
    job: await archive.restore(request.params.id, actorOf(request)),
  }));

  app.post<{ Params: { id: string } }>('/archive/:id/reprint', async (request, reply) => {
    const result = await archive.reprint(request.params.id, parseReprintBody(request.body), actorOf(request));
    return reply.status(201).send(result);
  });

  app.post('/archive/import', { bodyLimit: importBodyLimit }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) {
      throw new InvalidArgumentError('send the .bpsjob package as application/octet-stream');
    }
    const result = await archive.importPackage(request.body, parseImportQuery(request.query), actorOf(request));
    return reply.status(201).send(result);
  });

  const trash = async (request: FastifyRequest<{ Params: { id: string } }>) => ({
    job: await archive.trash(request.params.id, actorOf(request)),
  });
  app.delete<{ Params: { id: string } }>('/jobs/:id', trash);
  app.delete<{ Params: { id: string } }>('/archive/:id', trash);

  app.get('/trash', async () => ({ items: await archive.listTrash() }));

  app.post<{ Params: { id: string } }>('/trash/:id/restore', async (request) => ({
    job: await archive.restoreFromTrash(request.params.id, actorOf(request)),
  }));

  app.put<{ Params: { id: string } }>('/jobs/:id/legal-hold', async (request) => ({
    job: await archive.setLegalHold(request.params.id, parseLegalHoldBody(request.body), actorOf(request)),
  }));

  app.get<{ Params: { id: string } }>('/jobs/:id/history', async (request, reply) =>
    reply.header('content-type', 'application/x-ndjson').send(toJsonl(archive.history(request.params.id))),
  );

  app.get<{ Params: { id: string } }>('/jobs/:id/xjdf', async (request, reply) =>
    reply.header('content-type', 'application/xml; charset=utf-8').send(await archive.exportXjdf(request.params.id)),
  );

  return app;
}
