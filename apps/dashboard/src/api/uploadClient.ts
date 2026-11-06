import { toApiError } from './client';
import type { components } from './schema';
import type { Job } from './types';

/**
 * Spec 052b: POST /jobs (Spec 052a), the raw-PDF job upload. Only the opt-in upload button
 * (BPS_DASHBOARD_JOB_UPLOAD=1) imports this module, so it lives outside client.ts to keep the
 * flag-off bundle free of it. Like client.ts it is allowed to call `fetch` (eslint.config.js) and
 * only calls an endpoint from /openapi.json.
 */

type JobEnvelope = components['schemas']['JobEnvelope'];

export const PDF_TYPE = 'application/pdf';
export const JOB_NAME_HEADER = 'x-bps-job-name';

/** Characters a fetch header value can carry (Latin-1 without control characters). */
const HEADER_UNSAFE = /[^ -~ -ÿ]/g;
const PDF_EXTENSION = /\.pdf$/i;

export interface UploadClientOptions {
  /** Origin of the control plane. Defaults to the page origin. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** The job name sent for a file: its name without `.pdf`, made safe for a header; null when nothing is left. */
export function jobNameFromFileName(fileName: string): string | null {
  const name = fileName.replace(PDF_EXTENSION, '').replace(HEADER_UNSAFE, '_').trim();
  return name === '' ? null : name;
}

export function createUploadClient(options: UploadClientOptions = {}) {
  const baseUrl = options.baseUrl ?? (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1');
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    /** Uploads the PDF bytes as a new job; throws an ApiError carrying the `{error: {code}}` code. */
    async uploadJob(bytes: Uint8Array, name: string | null, signal?: AbortSignal): Promise<Job> {
      const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': PDF_TYPE };
      if (name !== null) headers[JOB_NAME_HEADER] = name;
      const response = await doFetch(new URL('/jobs', baseUrl).toString(), {
        method: 'POST',
        headers,
        body: bytes,
        signal,
      });
      if (!response.ok) throw await toApiError(response);
      return ((await response.json()) as JobEnvelope).job;
    },
  };
}

export type UploadClient = ReturnType<typeof createUploadClient>;
