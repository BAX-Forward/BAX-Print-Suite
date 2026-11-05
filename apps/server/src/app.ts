import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { parseSearchQuery, type ArchiveService } from '@bax-print/archive';
import { InvalidArgumentError, type Actor } from '@bax-print/core';
import { toJsonl } from '@bax-print/events';
import { sanitizeKeySegment } from '@bax-print/store';
import { registerCutRoutes, type CutExtractor, type CutJobLookup } from './cut-routes.js';
import { registerMediaRoutes } from './media-routes.js';
import type { MediaService } from './media-service.js';
import { OpenApiCollector } from './openapi.js';
import { parseImportQuery, parseLegalHoldBody, parseReprintBody } from './parse.js';
import { registerErrorHandler, registerPreflightRoutes, type RouteDeps } from './routes.js';
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
  /** `info.version` of the OpenAPI document. */
  readonly version?: string;
  /**
   * Resolves the caller. Single-PC mode binds to loopback without auth (ARCHITECTURE §6),
   * so the default treats the local caller as admin. Server mode must supply a real authenticator.
   */
  readonly authenticate?: (request: FastifyRequest) => Actor;
  readonly importBodyLimit?: number;
  readonly logger?: boolean;
}

const LOCAL_ADMIN: Actor = { id: 'local', role: 'admin' };

/**
 * One Fastify instance for the archive, preflight and media routes. Every route answers errors
 * with `{ error: { code, message, details? } }` from the one handler in `registerErrorHandler`.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  const actorOf = (request: FastifyRequest): Actor => (deps.authenticate ?? (() => LOCAL_ADMIN))(request);
  const importBodyLimit = deps.importBodyLimit ?? DEFAULT_IMPORT_BODY_LIMIT;
  const { archive } = deps;

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: importBodyLimit }, (_request, body, done) => {
    done(null, body);
  });

  registerErrorHandler(app);

  // Registered first so its `onRoute` hook documents the media routes.
  if (deps.media) {
    registerMediaRoutes(app, { media: deps.media, openapi: new OpenApiCollector(deps.version ?? DEFAULT_API_VERSION) });
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
