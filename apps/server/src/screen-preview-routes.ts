import type { FastifyInstance } from 'fastify';
import type { Job } from '@bax-print/core';
import { packPlane1bpp, type PackedPlane1bpp } from '@bax-print/marks';
import { composeScreening, pipelineOptionsFromJob } from '@bax-print/media';
import { notFound, screeningNotSet, screenPreviewInvalid } from './errors.js';
import { doc, SCREEN_PREVIEW_MAX_SIDE } from './openapi.js';

// Defined with the request schema in `openapi.ts`, like the swatch chart limits, so the two modules do not import each other.
export { SCREEN_PREVIEW_MAX_SIDE };

/** Spec 043a: `1` mounts `POST /jobs/:id/screen-preview`; unset leaves it off; any other value stops startup. */
export const SCREEN_PREVIEW_ENV = 'BPS_SCREEN_PREVIEW';

/** The base64 length of `bytes` bytes, padded. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Spec 043a: four base64 planes of the largest preview, plus room for the JSON around them. */
export const SCREEN_PREVIEW_BODY_LIMIT = 4 * base64Length(SCREEN_PREVIEW_MAX_SIDE * SCREEN_PREVIEW_MAX_SIDE) + 4096;

export function parseScreenPreviewFlag(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[SCREEN_PREVIEW_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${SCREEN_PREVIEW_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

/** The jobs whose screening is previewed; the store package's job repositories satisfy it. */
export interface ScreenPreviewJobStore {
  get(jobId: string): Promise<Job | null | undefined>;
}

export interface ScreenPreviewRouteOptions {
  readonly jobs: ScreenPreviewJobStore;
}

type PlaneName = 'c' | 'm' | 'y' | 'k';
const BODY_FIELDS: readonly string[] = ['width', 'height', 'c', 'm', 'y', 'k'];
const MAX_ECHOED_KEY_LENGTH = 64;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A preview request: 8-bit planes, one byte per pixel, row by row. */
export interface ScreenPreviewInput {
  readonly width: number;
  readonly height: number;
  readonly c: Uint8Array;
  readonly m: Uint8Array;
  readonly y: Uint8Array;
  readonly k: Uint8Array;
}

/** `POST /jobs/:id/screen-preview`: 1-bit packed planes, base64, `rowBytes` bytes per row. */
export interface ScreenPreviewResult {
  readonly width: number;
  readonly height: number;
  readonly rowBytes: number;
  readonly c: string;
  readonly m: string;
  readonly y: string;
  readonly k: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSide(name: string, value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= SCREEN_PREVIEW_MAX_SIDE) return value;
  throw screenPreviewInvalid(`${name} must be an integer in 1..${String(SCREEN_PREVIEW_MAX_SIDE)}`);
}

/** The plane's base64 is checked for its length and alphabet before it is decoded. */
function readPlane(name: PlaneName, value: unknown, pixels: number): Uint8Array {
  const expected = base64Length(pixels);
  if (typeof value !== 'string') throw screenPreviewInvalid(`${name} must be a base64 string`);
  if (value.length !== expected) {
    throw screenPreviewInvalid(`${name} must be ${String(expected)} base64 characters for ${String(pixels)} pixels, got ${String(value.length)}`);
  }
  if (!BASE64.test(value)) throw screenPreviewInvalid(`${name} is not valid base64`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== pixels) {
    throw screenPreviewInvalid(`${name} must decode to width * height = ${String(pixels)} bytes, got ${String(bytes.length)}`);
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Reads a `POST /jobs/:id/screen-preview` body strictly: unknown fields are rejected, and width
 * and height are checked before any plane is decoded.
 */
export function parseScreenPreviewBody(body: unknown): ScreenPreviewInput {
  if (!isRecord(body)) throw screenPreviewInvalid('send an object with width, height, c, m, y and k');
  for (const key of Object.keys(body)) {
    if (!BODY_FIELDS.includes(key)) throw screenPreviewInvalid(`unknown field "${key.slice(0, MAX_ECHOED_KEY_LENGTH)}"`);
  }
  const width = readSide('width', body.width);
  const height = readSide('height', body.height);
  const pixels = width * height;
  return {
    width,
    height,
    c: readPlane('c', body.c, pixels),
    m: readPlane('m', body.m, pixels),
    y: readPlane('y', body.y, pixels),
    k: readPlane('k', body.k, pixels),
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Spec 043a: screens the sent planes with the job's screening and ink-limit settings; nothing is stored. */
export function registerScreenPreviewRoutes(app: FastifyInstance, deps: ScreenPreviewRouteOptions): void {
  const { jobs } = deps;

  app.post<{ Params: { id: string } }>(
    '/jobs/:id/screen-preview',
    {
      bodyLimit: SCREEN_PREVIEW_BODY_LIMIT,
      schema: doc({
        operationId: 'previewJobScreening',
        summary: "Screen CMYK planes with the job's screening and ink-limit settings and answer 1-bit packed planes",
        tags: ['jobs'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        bodyDoc: { $ref: '#/components/schemas/ScreenPreviewRequest' },
        responses: {
          200: 'The screened planes, packed 1 bit per pixel',
          400: 'The body is not a valid preview request, e.g. an unknown field, a side out of range or a plane of the wrong length (`invalid_screen_preview`)',
          404: 'No job has this id (`not_found`)',
          409: 'The job has no screening setting (`screening_not_set`)',
          413: `The body is larger than ${String(SCREEN_PREVIEW_BODY_LIMIT)} bytes (\`invalid_request\`)`,
        },
        responseSchema: 'ScreenPreview',
      }),
    },
    async (request): Promise<ScreenPreviewResult> => {
      const { id } = request.params;
      const job = await jobs.get(id);
      if (!job) throw notFound('Job', id);
      const options = pipelineOptionsFromJob({ screening: job.screening, inkLimit: job.inkLimit });
      if (options.screening === undefined) throw screeningNotSet(`Job ${id} has no screening setting`);
      const input = parseScreenPreviewBody(request.body);
      const { width, height } = input;
      const planes = composeScreening({ ...input, ...options });
      const pack = (plane: Uint8Array): PackedPlane1bpp => packPlane1bpp({ width, height, plane });
      const c = pack(planes.c);
      return {
        width,
        height,
        rowBytes: c.rowBytes,
        c: toBase64(c.data),
        m: toBase64(pack(planes.m).data),
        y: toBase64(pack(planes.y).data),
        k: toBase64(pack(planes.k).data),
      };
    },
  );
}
