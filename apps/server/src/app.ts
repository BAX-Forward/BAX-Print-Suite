import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  ColorSetupMismatchError,
  ColorSetupNotFoundError,
  ColorSetupRequiredError,
  JobNotFoundError,
  PackageIntegrityError,
  parseSearchQuery,
  RemapRequiredError,
  type ArchiveService,
} from '@bax-print/archive';
import {
  BpsError,
  ForbiddenError,
  IllegalTransitionError,
  InvalidArgumentError,
  InvalidLifecycleError,
  LegalHoldError,
  type Actor,
} from '@bax-print/core';
import { toJsonl } from '@bax-print/events';
import { InvalidCursorError, sanitizeKeySegment } from '@bax-print/store';
import { parseImportQuery, parseLegalHoldBody, parseReprintBody } from './parse.js';

export const DEFAULT_IMPORT_BODY_LIMIT = 1024 ** 3;

export interface ServerDeps {
  readonly archive: ArchiveService;
  /**
   * Resolves the caller. Single-PC mode binds to loopback without auth (ARCHITECTURE §6),
   * so the default treats the local caller as admin. Server mode must supply a real authenticator.
   */
  readonly authenticate?: (request: FastifyRequest) => Actor;
  readonly importBodyLimit?: number;
  readonly logger?: boolean;
}

const LOCAL_ADMIN: Actor = { id: 'local', role: 'admin' };

const STATUS_BY_ERROR: readonly [new (...args: never[]) => BpsError, number][] = [
  [JobNotFoundError, 404],
  [ForbiddenError, 403],
  [InvalidLifecycleError, 409],
  [LegalHoldError, 409],
  [IllegalTransitionError, 409],
  [ColorSetupRequiredError, 422],
  [ColorSetupMismatchError, 422],
  [ColorSetupNotFoundError, 422],
  [PackageIntegrityError, 422],
  [RemapRequiredError, 422],
  [InvalidArgumentError, 400],
  [InvalidCursorError, 400],
];

function statusFor(error: unknown): number {
  for (const [type, status] of STATUS_BY_ERROR) {
    if (error instanceof type) return status;
  }
  if (error instanceof BpsError) return 400;
  if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  return 500;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  const actorOf = (request: FastifyRequest): Actor => (deps.authenticate ?? (() => LOCAL_ADMIN))(request);
  const importBodyLimit = deps.importBodyLimit ?? DEFAULT_IMPORT_BODY_LIMIT;
  const { archive } = deps;

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: importBodyLimit }, (_request, body, done) => {
    done(null, body);
  });

  app.setErrorHandler((error, request, reply) => {
    const status = statusFor(error);
    if (status >= 500) request.log.error(error);
    const body: Record<string, unknown> = {
      error: error instanceof BpsError ? error.code : (error.code ?? 'ERROR'),
      message: status >= 500 ? 'internal server error' : error.message,
    };
    if (error instanceof RemapRequiredError) {
      body.unknownDevices = error.unknownDevices;
      body.unknownMedia = error.unknownMedia;
    }
    return reply.status(status).send(body);
  });

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
