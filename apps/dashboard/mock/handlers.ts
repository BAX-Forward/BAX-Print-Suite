import { http, HttpResponse, type PathParams } from 'msw';
import { MockProblem, sanitizeFileName, type MockDb } from './db';
import { toSseFrame } from './events';
import openapi from './openapi.json';

/**
 * MSW handlers implementing every operation in mock/openapi.json on top of the in-memory store.
 * The same handlers serve the browser (`pnpm --filter dashboard dev:mock`) and the Vitest suite.
 */

const JSON_TYPE = 'application/json';
const PROBLEM_TYPE = 'application/problem+json';
const MIN_PREVIEW_PX = 16;
const MAX_PREVIEW_PX = 2048;

function json(body: unknown, status = 200): HttpResponse {
  return new HttpResponse(JSON.stringify(body), { status, headers: { 'Content-Type': JSON_TYPE } });
}

function problemResponse(problem: MockProblem): HttpResponse {
  return new HttpResponse(JSON.stringify(problem.toProblem()), {
    status: problem.status,
    headers: { 'Content-Type': PROBLEM_TYPE },
  });
}

interface ResolverInfo {
  request: Request;
  params: PathParams;
}

type Resolver = (info: ResolverInfo) => HttpResponse | Promise<HttpResponse>;

/** Turns MockProblem errors from the store into RFC 9457 responses. */
function guard(resolve: Resolver) {
  return async (info: ResolverInfo): Promise<HttpResponse> => {
    try {
      return await resolve(info);
    } catch (error) {
      if (error instanceof MockProblem) return problemResponse(error);
      throw error;
    }
  };
}

function param(params: PathParams, name: string): string {
  const value = params[name];
  return typeof value === 'string' ? value : (value?.[0] ?? '');
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new MockProblem(400, 'Bad Request', 'The request body must be valid JSON.');
  }
}

function previewParams(url: URL, pageCount: number): void {
  const errors = [];
  const page = Number(url.searchParams.get('page') ?? '1');
  const width = Number(url.searchParams.get('w') ?? '320');
  if (!Number.isInteger(page) || page < 1 || page > Math.max(1, pageCount)) {
    errors.push({ field: 'page', message: `Enter a page number from 1 to ${Math.max(1, pageCount)}.` });
  }
  if (!Number.isInteger(width) || width < MIN_PREVIEW_PX || width > MAX_PREVIEW_PX) {
    errors.push({ field: 'w', message: `Enter a width from ${MIN_PREVIEW_PX} to ${MAX_PREVIEW_PX}.` });
  }
  if (errors.length) throw new MockProblem(400, 'Bad Request', 'Invalid preview parameters.', errors);
}

function eventStream(db: MockDb): HttpResponse {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      unsubscribe = db.events.subscribe((event) => {
        try {
          controller.enqueue(encoder.encode(toSseFrame(event)));
        } catch {
          unsubscribe();
        }
      });
    },
    cancel() {
      unsubscribe();
    },
  });
  return new HttpResponse(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

export function createHandlers(db: MockDb, baseUrl: string) {
  const at = (path: string) => `${baseUrl.replace(/\/$/, '')}${path}`;

  return [
    http.get(at('/health'), guard(() => json(db.health()))),
    http.get(at('/openapi.json'), guard(() => json(openapi))),

    http.get(at('/jobs'), guard(({ request }) => json(db.listJobs(new URL(request.url).searchParams)))),
    http.get(at('/jobs/:id'), guard(({ params }) => json(db.getJob(param(params, 'id'))))),
    http.patch(
      at('/jobs/:id'),
      guard(async ({ request, params }) => json(db.patchJob(param(params, 'id'), await readJson(request)))),
    ),
    http.get(at('/jobs/:id/transitions'), guard(({ params }) => json(db.getTransitions(param(params, 'id'))))),
    http.get(
      at('/jobs/:id/file'),
      guard(({ params }) => {
        const id = param(params, 'id');
        const job = db.getJob(id);
        const bytes = db.jobFile(id);
        return new HttpResponse(bytes, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': String(bytes.byteLength),
            'Content-Disposition': `inline; filename="${sanitizeFileName(job.name)}.pdf"`,
          },
        });
      }),
    ),
    http.get(
      at('/jobs/:id/preview'),
      guard(({ request, params }) => {
        const job = db.getJob(param(params, 'id'));
        previewParams(new URL(request.url), job.pageCount);
        // Reserved contract: no RenderEngine before M5, so clients render with pdf.js.
        return json({ reason: 'no-render-engine' }, 501);
      }),
    ),
    http.post(
      at('/jobs/:id/print'),
      guard(async ({ request, params }) => json(db.printJob(param(params, 'id'), await readJson(request)), 202)),
    ),

    http.get(at('/hotfolders'), guard(() => json(db.listHotFolders()))),
    http.post(at('/hotfolders'), guard(async ({ request }) => json(db.createHotFolder(await readJson(request)), 201))),
    http.patch(
      at('/hotfolders/:id'),
      guard(async ({ request, params }) => json(db.patchHotFolder(param(params, 'id'), await readJson(request)))),
    ),
    http.delete(
      at('/hotfolders/:id'),
      guard(({ params }) => {
        db.deleteHotFolder(param(params, 'id'));
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    http.get(at('/plugins'), guard(() => json(db.listPlugins()))),

    http.get(at('/devices'), guard(() => json(db.listDevices()))),
    http.post(at('/devices'), guard(async ({ request }) => json(db.createDevice(await readJson(request)), 201))),
    http.patch(
      at('/devices/:id'),
      guard(async ({ request, params }) => json(db.patchDevice(param(params, 'id'), await readJson(request)))),
    ),

    http.get(at('/events'), () => eventStream(db)),
  ];
}
