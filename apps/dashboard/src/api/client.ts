import type {
  Device,
  DeviceCreate,
  DevicePatch,
  Health,
  HotFolder,
  HotFolderCreate,
  HotFolderPatch,
  Job,
  JobEnvelope,
  JobPage,
  JobPatch,
  JobRecord,
  Plugin,
  Problem,
  Transitions,
} from './types';

/**
 * The `error` of an `{error: {code, message, details?}}` body (the server's Error schema). Only an
 * object `details` is kept: the codes the dashboard reads (upload_too_large) carry an object.
 */
interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Typed client for the public REST API (/openapi.json). This is the only module allowed to call
 * `fetch` (enforced by eslint.config.js and tests/no-direct-fetch.test.ts).
 */

const JSON_TYPE = 'application/json';

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | null;
  /** Machine-readable code from an `{error: {code, message}}` body (job endpoints, Spec 052a). */
  readonly code: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(status: number, problem: Problem | null, fallbackMessage: string, error: ErrorBody | null = null) {
    super(problem?.detail ?? problem?.title ?? error?.message ?? fallbackMessage);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.code = error?.code ?? null;
    this.details = error?.details ?? null;
  }

  /** Field-level validation errors keyed by dotted field path (first message per field). */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const error of this.problem?.errors ?? []) {
      if (!(error.field in out)) out[error.field] = error.message;
    }
    return out;
  }
}

/** GET /jobs takes only these two query parameters (Spec 052a). */
export interface JobListParams {
  cursor?: string;
  limit?: number;
}

type QueryValue = string | number | boolean | readonly string[] | undefined;

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  accept?: string;
  /** Non-2xx statuses that are returned instead of thrown. */
  allowStatus?: readonly number[];
}

export interface ApiClientOptions {
  /** Origin of the control plane. Defaults to the page origin. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function defaultBaseUrl(): string {
  return typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1';
}

function isProblem(value: unknown): value is Problem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Problem).title === 'string' &&
    typeof (value as Problem).status === 'number'
  );
}

function errorBody(value: unknown): ErrorBody | null {
  if (typeof value !== 'object' || value === null || !('error' in value)) return null;
  const error: unknown = value.error;
  if (typeof error !== 'object' || error === null) return null;
  if (!('code' in error) || typeof error.code !== 'string') return null;
  if (!('message' in error) || typeof error.message !== 'string') return null;
  const details =
    'details' in error && typeof error.details === 'object' && error.details !== null && !Array.isArray(error.details)
      ? Object.fromEntries(Object.entries(error.details))
      : undefined;
  return { code: error.code, message: error.message, ...(details ? { details } : {}) };
}

/** Reads an RFC 9457 problem or an `{error: {code, message, details?}}` body from a failed response. */
export async function toApiError(response: Response): Promise<ApiError> {
  const fallback = `Request failed with status ${response.status}`;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return new ApiError(response.status, null, fallback);
  try {
    const body: unknown = await response.json();
    if (isProblem(body)) return new ApiError(response.status, body, fallback);
    return new ApiError(response.status, null, fallback, errorBody(body));
  } catch {
    return new ApiError(response.status, null, fallback);
  }
}

const id = (value: string) => encodeURIComponent(value);

export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  function buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === '') continue;
      if (typeof value === 'object') {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async function send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: opts.accept ?? JSON_TYPE };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = JSON_TYPE;
      body = JSON.stringify(opts.body);
    }
    const response = await doFetch(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      signal: opts.signal,
    });
    if (!response.ok && !opts.allowStatus?.includes(response.status)) {
      throw await toApiError(response);
    }
    return response;
  }

  async function json<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    const response = await send(method, path, opts);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    health: (signal?: AbortSignal) => json<Health>('GET', '/health', { signal }),

    /** `{items, nextCursor}`; nextCursor is null on the last page. */
    listJobs: (params: JobListParams = {}, signal?: AbortSignal) =>
      json<JobPage>('GET', '/jobs', { signal, query: { limit: params.limit, cursor: params.cursor } }),
    getJob: async (jobId: string, signal?: AbortSignal): Promise<Job> =>
      (await json<JobEnvelope>('GET', `/jobs/${id(jobId)}`, { signal })).job,
    /** Mock only (Spec 002); the 052a server has no PATCH /jobs/:id. */
    patchJob: (jobId: string, patch: JobPatch) =>
      json<JobRecord>('PATCH', `/jobs/${id(jobId)}`, { body: patch }),
    getTransitions: (jobId: string, signal?: AbortSignal) =>
      json<Transitions>('GET', `/jobs/${id(jobId)}/transitions`, { signal }),
    printJob: (jobId: string, deviceId: string) =>
      json<JobRecord>('POST', `/jobs/${id(jobId)}/print`, { body: { deviceId } }),

    /** The stored PDF bytes (for the in-browser pdf.js preview). */
    async getJobFile(jobId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
      const response = await send('GET', `/jobs/${id(jobId)}/file`, { signal, accept: 'application/pdf' });
      return response.arrayBuffer();
    },

    /** Server-rendered preview, or `null` while the server has no render engine (501). */
    async getPreview(jobId: string, page: number, width: number, signal?: AbortSignal): Promise<Blob | null> {
      const response = await send('GET', `/jobs/${id(jobId)}/preview`, {
        signal,
        accept: 'image/*',
        query: { page, w: width },
        allowStatus: [501],
      });
      return response.status === 501 ? null : response.blob();
    },

    listHotFolders: (signal?: AbortSignal) => json<HotFolder[]>('GET', '/hotfolders', { signal }),
    createHotFolder: (input: HotFolderCreate) => json<HotFolder>('POST', '/hotfolders', { body: input }),
    patchHotFolder: (hotFolderId: string, patch: HotFolderPatch) =>
      json<HotFolder>('PATCH', `/hotfolders/${id(hotFolderId)}`, { body: patch }),
    deleteHotFolder: (hotFolderId: string) =>
      json<void>('DELETE', `/hotfolders/${id(hotFolderId)}`),

    listPlugins: (signal?: AbortSignal) => json<Plugin[]>('GET', '/plugins', { signal }),

    listDevices: (signal?: AbortSignal) => json<Device[]>('GET', '/devices', { signal }),
    createDevice: (input: DeviceCreate) => json<Device>('POST', '/devices', { body: input }),
    patchDevice: (deviceId: string, patch: DevicePatch) =>
      json<Device>('PATCH', `/devices/${id(deviceId)}`, { body: patch }),

    /** URL for the SSE stream; opened by the live-updates module via EventSource. */
    eventsUrl: () => buildUrl('/events'),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
