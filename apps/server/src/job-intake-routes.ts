import { open, mkdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DEFAULT_SITE_ID, parseSiteId, ulid, type Actor, type Job, type JobTicket } from '@bax-print/core';
import {
  InvalidCursorError,
  syncDirectory,
  type ActiveJobPages,
  type JobPageKey,
  type JobRepository,
} from '@bax-print/store';
import {
  HttpError,
  notFound,
  siteNotGranted,
  uploadMediaTypeUnsupported,
  uploadNotPdf,
  uploadTooLarge,
} from './errors.js';
import type { JobService } from './jobs.js';
import { doc } from './openapi.js';
import type { SiteScope } from './site-scope.js';

/** Spec 052a: `1` mounts `POST /jobs`, `GET /jobs` and `GET /jobs/:id`; unset leaves them off; any other value stops startup. */
export const JOB_INTAKE_ENV = 'BPS_JOB_INTAKE';

/** Spec 052a: optional; lowers the upload cap below the default. A higher or malformed value stops startup. */
export const JOB_INTAKE_MAX_BYTES_ENV = 'BPS_JOB_INTAKE_MAX_BYTES';

/** Spec 052a: the default and highest upload cap, 256 MiB. */
export const DEFAULT_JOB_INTAKE_MAX_BYTES = 256 * 1024 * 1024;

/** Spec 052a: optional display name of an upload; stored sanitized as metadata, never used as a file name. */
export const JOB_NAME_HEADER = 'x-bps-job-name';

/** Spec 052a: the longest display name kept from `x-bps-job-name`, in characters. */
export const JOB_NAME_MAX_LENGTH = 200;

/** Spec 052a: `GET /jobs` page sizes. A larger `limit` is capped, never an error. */
export const JOB_LIST_DEFAULT_LIMIT = 50;
export const JOB_LIST_MAX_LIMIT = 200;

/** Every upload must start with these bytes (ISO 32000 file header). */
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

const WHOLE_BYTES = /^[1-9][0-9]{0,15}$/;

type Env = Readonly<Record<string, string | undefined>>;

export interface JobIntakeConfig {
  readonly maxBytes: number;
}

export function parseJobIntakeFlag(env: Env): boolean {
  const value = env[JOB_INTAKE_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${JOB_INTAKE_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

/** The upload cap: the default without the variable; a malformed value or one above the default stops startup. */
export function parseJobIntakeMaxBytes(env: Env): number {
  const value = env[JOB_INTAKE_MAX_BYTES_ENV];
  if (value === undefined) return DEFAULT_JOB_INTAKE_MAX_BYTES;
  const bytes = WHOLE_BYTES.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(bytes) || bytes > DEFAULT_JOB_INTAKE_MAX_BYTES) {
    throw new Error(
      `${JOB_INTAKE_MAX_BYTES_ENV} must be a whole number of bytes from 1 to ${String(DEFAULT_JOB_INTAKE_MAX_BYTES)}, got ${JSON.stringify(value)}`,
    );
  }
  return bytes;
}

/** Spec 052a: the intake settings, or `undefined` with the flag unset. Both variables are checked either way. */
export function parseJobIntakeConfig(env: Env): JobIntakeConfig | undefined {
  const maxBytes = parseJobIntakeMaxBytes(env);
  return parseJobIntakeFlag(env) ? { maxBytes } : undefined;
}

/**
 * The display name from `x-bps-job-name`: the last path segment, without control or format characters,
 * trimmed and cut to `JOB_NAME_MAX_LENGTH`; `undefined` when nothing is left.
 */
export function sanitizeJobName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const segment = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = segment.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, JOB_NAME_MAX_LENGTH).trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? undefined : cleaned;
}

/** The jobs listed and read; the store package's job repositories satisfy it. */
export type JobIntakeJobs = Pick<JobRepository, 'get'> & ActiveJobPages;

export interface JobIntakeRouteOptions {
  /** The repository `service` saves into, and the one site scoping reads. */
  readonly jobs: JobIntakeJobs;
  readonly service: Pick<JobService, 'create'>;
  /** Directory below `BPS_DATA_DIR` the uploads are written to, under server-generated names. */
  readonly intakeDir: string;
  readonly maxBytes: number;
  readonly authenticate: (request: FastifyRequest) => Actor;
  readonly siteScope?: SiteScope;
  /** File id of an upload; defaults to a ULID. */
  readonly newFileId?: () => string;
}

/** The chunks of a request body, read one at a time. */
type BodyChunks = AsyncIterator<unknown>;

function chunkBytes(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new TypeError('the upload body yielded a chunk that is not bytes');
}

/** Spec 052c: the body ran past the cap without a content-length; the same answer Fastify gave in 052a. */
function bodyTooLarge(): HttpError {
  return new HttpError(413, 'invalid_request', 'Request body is too large');
}

/** Reads chunks until at least `size` bytes arrived or the body ended; the rest stays unread. */
async function readHead(chunks: BodyChunks, size: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let length = 0;
  while (length < size) {
    const next = await chunks.next();
    if (next.done === true) break;
    const chunk = chunkBytes(next.value);
    parts.push(chunk);
    length += chunk.byteLength;
  }
  return Buffer.concat(parts, length);
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset);
    offset += bytesWritten;
  }
}

/**
 * Spec 052c: streams `head` and then the rest of `chunks` to `dir/name` through `name.part`, counting
 * bytes against `maxBytes` (past it the part file is deleted and 413 thrown). The file is synced before
 * the rename and the directory after it, so the upload is whole or absent and the rename survives a crash.
 */
export async function streamFileAtomic(
  dir: string,
  name: string,
  head: Buffer,
  chunks: BodyChunks,
  maxBytes: number,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  const part = `${path}.part`;
  try {
    const handle = await open(part, 'wx', 0o600);
    try {
      let size = 0;
      let next: IteratorResult<unknown> = { done: false, value: head };
      while (next.done !== true) {
        const chunk = chunkBytes(next.value);
        size += chunk.byteLength;
        if (size > maxBytes) throw bodyTooLarge();
        await writeAll(handle, chunk);
        next = await chunks.next();
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(part, path);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  await syncDirectory(dir);
  return path;
}

function encodeCursor(key: JobPageKey): string {
  return Buffer.from(JSON.stringify([key.createdAt, key.id]), 'utf8').toString('base64url');
}

function decodeCursor(text: string): JobPageKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (!Array.isArray(parsed)) throw new InvalidCursorError();
  const [createdAt, id]: unknown[] = parsed;
  if (parsed.length !== 2 || typeof createdAt !== 'string' || typeof id !== 'string') throw new InvalidCursorError();
  return { createdAt, id };
}

function declaredLength(request: FastifyRequest): number {
  const header = request.headers['content-length'];
  const length = header === undefined ? 0 : Number(header);
  return Number.isFinite(length) ? length : 0;
}

function startsWithPdfMagic(bytes: Buffer): boolean {
  return bytes.byteLength >= PDF_MAGIC.byteLength && bytes.subarray(0, PDF_MAGIC.byteLength).equals(PDF_MAGIC);
}

const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

const UPLOAD_QUERY = {
  type: 'object',
  properties: {
    siteId: { type: 'string', description: 'Site of the new job (Spec 030a); without it the job has no `siteId` and belongs to `default`' },
  },
};

const LIST_QUERY = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      default: JOB_LIST_DEFAULT_LIMIT,
      description: `Page size; a value above ${String(JOB_LIST_MAX_LIMIT)} is capped at ${String(JOB_LIST_MAX_LIMIT)}`,
    },
    cursor: { type: 'string', minLength: 1, maxLength: 512, description: "Opaque cursor from a previous page's `nextCursor`" },
  },
};

interface ListQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * Spec 052a: opt-in job intake. `POST /jobs` takes a raw `application/pdf` body: the declared size is
 * checked against the cap before the body is read and the bytes must start with `%PDF-`. Only then is
 * the upload written under a server-generated name and the job created through the job service.
 * `GET /jobs` pages the active jobs newest first and `GET /jobs/:id` reads one; both see only the
 * caller's sites when site scoping is on.
 *
 * Spec 052c: the body is streamed to one intake file (counted against the cap, synced, renamed, its
 * directory synced) which the blob store adopts as the job's source; `GET /jobs` is a keyset query
 * with the site filter inside it.
 */
export function registerJobIntakeRoutes(app: FastifyInstance, deps: JobIntakeRouteOptions): void {
  const { jobs, service, intakeDir, maxBytes, authenticate, siteScope } = deps;
  const newFileId = deps.newFileId ?? (() => ulid(Date.now()));

  const upload = async (request: FastifyRequest<{ Querystring: { siteId?: string } }>): Promise<Job> => {
    const body = request.body;
    if (!(body instanceof Readable)) throw uploadMediaTypeUnsupported();
    const chunks: BodyChunks = body[Symbol.asyncIterator]();
    // Spec 052c: only the first bytes are read before the checks; nothing is written until they pass.
    const head = await readHead(chunks, PDF_MAGIC.byteLength);
    if (head.byteLength > maxBytes) throw bodyTooLarge();
    if (!startsWithPdfMagic(head)) throw uploadNotPdf();
    const siteId = request.query.siteId === undefined ? undefined : parseSiteId(request.query.siteId);
    if (siteScope !== undefined) {
      const target = siteId ?? DEFAULT_SITE_ID;
      if (!(await siteScope.grants(request, target))) throw siteNotGranted(target);
    }

    const fileName = `${newFileId()}.pdf`;
    const path = await streamFileAtomic(intakeDir, fileName, head, chunks, maxBytes);
    const displayName = sanitizeJobName(request.headers[JOB_NAME_HEADER]);
    const ticket: JobTicket = { intent: { quantity: 1 }, process: {}, ...(siteId === undefined ? {} : { siteId }) };
    try {
      return await service.create(
        {
          name: displayName ?? fileName,
          // Spec 052c: the blob store adopts the intake file, so the upload is stored once.
          sources: [{ name: fileName, path }],
          ticket,
          metadata: { intakeFile: fileName, ...(displayName === undefined ? {} : { displayName }) },
        },
        authenticate(request),
      );
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  };

  // Encapsulated, so the `application/pdf` parser and its cap apply to `POST /jobs` only.
  void app.register((scope, _options, done) => {
    // Spec 052c: the body is handed on as a stream; `upload` counts its bytes against the cap.
    scope.addContentTypeParser('application/pdf', (_request, payload, parsed) => {
      parsed(null, payload);
    });
    scope.post<{ Querystring: { siteId?: string } }>(
      '/jobs',
      {
        bodyLimit: maxBytes,
        // After the permission guard, before the body is read.
        onRequest: async (request) => {
          if (declaredLength(request) > maxBytes) throw uploadTooLarge(maxBytes);
        },
        schema: doc({
          operationId: 'createJob',
          summary: `Upload a PDF as a new job. The optional \`${JOB_NAME_HEADER}\` header is kept, sanitized, as the display name only`,
          tags: ['jobs'],
          querystring: UPLOAD_QUERY,
          consumes: ['application/pdf'],
          responses: {
            201: '`{ job }`: the new job, `received`, with the upload as its only source file',
            400: 'The body does not start with `%PDF-` (`upload_not_pdf`), or `siteId` is not a valid site id (`invalid_argument`); nothing is written',
            403: "With site scoping, the caller's membership does not grant the job's site (`site_not_granted`)",
            413: `The upload is larger than the cap, ${String(maxBytes)} bytes: by content-length (\`upload_too_large\`) or, for a body without one, while it is read (\`invalid_request\`); nothing is written`,
            415: 'The body is not `application/pdf` (`upload_media_type_unsupported` or `invalid_request`)',
          },
          responseSchema: 'JobEnvelope',
        }),
      },
      async (request, reply) => reply.status(201).send({ job: await upload(request) }),
    );
    done();
  });

  app.get<{ Querystring: ListQuery }>(
    '/jobs',
    {
      schema: doc({
        operationId: 'listJobs',
        summary: 'List the active jobs, newest first, one page at a time',
        tags: ['jobs'],
        querystring: LIST_QUERY,
        responses: {
          200: "`{ items, nextCursor }`: with site scoping only the jobs of the caller's sites; `nextCursor` is null on the last page",
          400: '`limit` is not a positive integer (`invalid_request`) or `cursor` is not one this route issued',
        },
        responseSchema: 'JobPage',
      }),
    },
    async (request) => {
      const limit = Math.min(request.query.limit ?? JOB_LIST_DEFAULT_LIMIT, JOB_LIST_MAX_LIMIT);
      const after = request.query.cursor === undefined ? undefined : decodeCursor(request.query.cursor);
      const siteIds = siteScope === undefined ? undefined : await siteScope.grantedSiteIds(request);
      // Spec 052c: one row past the page tells whether another page follows.
      const page = await jobs.listActivePage({
        limit: limit + 1,
        ...(after === undefined ? {} : { after }),
        ...(siteIds === undefined ? {} : { siteIds }),
      });
      const items = page.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: page.length > limit && last !== undefined ? encodeCursor(last) : null };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/jobs/:id',
    {
      schema: doc({
        operationId: 'getJob',
        summary: 'Read one job',
        tags: ['jobs'],
        params: ID_PARAMS,
        responses: {
          200: '`{ job }`',
          404: 'No job has this id (`not_found`)',
        },
        responseSchema: 'JobEnvelope',
      }),
    },
    async (request) => {
      const job = await jobs.get(request.params.id);
      if (job === undefined) throw notFound('Job', request.params.id);
      return { job };
    },
  );
}
