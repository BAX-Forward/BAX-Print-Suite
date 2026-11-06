import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Job } from '@bax-print/core';
import {
  ImposedSheetsError,
  MarkSpecError,
  MAX_PROOF_SIDES,
  MAX_SOURCE_PAGES,
  MAX_SOURCE_PDF_BYTES,
  renderImposedSheets,
  type ImposedSheetsOptions,
  type ImpositionProofPlan,
} from '@bax-print/marks';
import {
  planBooklet,
  planNUp,
  type BookletBinding,
  type BookletOptions,
  type NUpOptions,
  type NUpOrientation,
  type NUpSize,
  type SignaturePages,
} from '@bax-print/nest';
import { sanitizeKeySegment } from '@bax-print/store';
import { conflict, HttpError, invalid, jobSourceNotPdf, notFound, sourcePdfTooLarge } from './errors.js';
import { doc } from './openapi.js';
import { readSource } from './pdf-cut-extractor.js';
import type { ProofRouteDeps } from './proof-routes.js';

/**
 * Spec 036b: `1` mounts `POST /imposition/n-up` and `POST /imposition/booklet` (and, Spec 036e, `POST /jobs/:id/impose`
 * when the server has jobs and a blob path); unset leaves them off; any other value stops startup.
 */
export const IMPOSITION_ENV = 'BPS_IMPOSITION';

export function parseImpositionFlag(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[IMPOSITION_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${IMPOSITION_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

const N_UP_KEYS: ReadonlySet<string> = new Set(['sheet', 'cell', 'rows', 'cols', 'gutter', 'margin', 'orientation', 'pageCount']);
const SIZE_KEYS: ReadonlySet<string> = new Set(['width', 'height']);
const BOOKLET_KEYS: ReadonlySet<string> = new Set(['pageCount', 'signaturePages', 'creep', 'binding']);
const ORIENTATIONS: readonly NUpOrientation[] = ['upright', 'turned', 'auto'];
const SIGNATURE_PAGES: readonly SignaturePages[] = [4, 8, 16, 'single'];
const BINDINGS: readonly BookletBinding[] = ['left', 'right'];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null) return false;
  return typeof value === 'object' && Array.isArray(value) === false;
}

/** The value as a JSON object, or `undefined` for anything else (arrays and `null` included). */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function checkKnownFields(record: Readonly<Record<string, unknown>>, keys: ReadonlySet<string>, prefix: string, issues: string[]): void {
  for (const key of Object.keys(record)) {
    if (keys.has(key) === false) issues.push(`${prefix}${key}: unknown field`);
  }
}

/** Only the JSON type is checked here; the planner checks ranges, integers and limits. */
function checkNumber(value: unknown, path: string, issues: string[]): number | undefined {
  if (typeof value === 'number') return value;
  issues.push(`${path}: must be a number`);
  return undefined;
}

function optionalNumber(value: unknown, path: string, issues: string[]): number | undefined {
  return value === undefined ? undefined : checkNumber(value, path, issues);
}

function checkChoice<T extends string | number>(value: unknown, choices: readonly T[], path: string, issues: string[]): T | undefined {
  const choice = choices.find((item) => item === value);
  if (choice === undefined) issues.push(`${path}: must be one of ${choices.map((item) => JSON.stringify(item)).join(', ')}`);
  return choice;
}

function checkSize(value: unknown, path: string, issues: string[]): NUpSize | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    issues.push(`${path}: must be an object with the numbers width and height`);
    return undefined;
  }
  checkKnownFields(record, SIZE_KEYS, `${path}.`, issues);
  const width = checkNumber(record.width, `${path}.width`, issues);
  const height = checkNumber(record.height, `${path}.height`, issues);
  return width === undefined || height === undefined ? undefined : { width, height };
}

/**
 * Spec 036b: checks the shape of a `POST /imposition/n-up` body; throws a 400 `invalid_request` with
 * the issues in `details`. `planNUp` checks the values and answers `invalid_imposition_input`.
 */
export function parseNUpRequest(body: unknown, prefix = ''): NUpOptions {
  const record = asRecord(body);
  if (record === undefined) throw invalid('Send a JSON object with a sheet and a cell');
  const issues: string[] = [];
  checkKnownFields(record, N_UP_KEYS, prefix, issues);
  const sheet = checkSize(record.sheet, `${prefix}sheet`, issues);
  const cell = checkSize(record.cell, `${prefix}cell`, issues);
  const rows = optionalNumber(record.rows, `${prefix}rows`, issues);
  const cols = optionalNumber(record.cols, `${prefix}cols`, issues);
  const gutter = optionalNumber(record.gutter, `${prefix}gutter`, issues);
  const margin = optionalNumber(record.margin, `${prefix}margin`, issues);
  const pageCount = optionalNumber(record.pageCount, `${prefix}pageCount`, issues);
  const orientation =
    record.orientation === undefined ? undefined : checkChoice(record.orientation, ORIENTATIONS, `${prefix}orientation`, issues);
  if (sheet === undefined || cell === undefined || issues.length > 0) throw invalid('invalid n-up request', issues);
  return {
    sheet,
    cell,
    ...(rows === undefined ? {} : { rows }),
    ...(cols === undefined ? {} : { cols }),
    ...(gutter === undefined ? {} : { gutter }),
    ...(margin === undefined ? {} : { margin }),
    ...(orientation === undefined ? {} : { orientation }),
    ...(pageCount === undefined ? {} : { pageCount }),
  };
}

/**
 * Spec 036b: checks the shape of a `POST /imposition/booklet` body; throws a 400 `invalid_request` with
 * the issues in `details`. `planBooklet` checks the values and answers `invalid_imposition_input`.
 */
export function parseBookletRequest(body: unknown, prefix = ''): BookletOptions {
  const record = asRecord(body);
  if (record === undefined) throw invalid('Send a JSON object with a pageCount, signaturePages and binding');
  const issues: string[] = [];
  checkKnownFields(record, BOOKLET_KEYS, prefix, issues);
  const pageCount = checkNumber(record.pageCount, `${prefix}pageCount`, issues);
  const signaturePages = checkChoice(record.signaturePages, SIGNATURE_PAGES, `${prefix}signaturePages`, issues);
  const binding = checkChoice(record.binding, BINDINGS, `${prefix}binding`, issues);
  const creep = optionalNumber(record.creep, `${prefix}creep`, issues);
  if (pageCount === undefined || signaturePages === undefined || binding === undefined || issues.length > 0) {
    throw invalid('invalid booklet request', issues);
  }
  return { pageCount, signaturePages, binding, ...(creep === undefined ? {} : { creep }) };
}

const INVALID_BODY = 'The body is not a valid request: wrong JSON types or an unknown field (`invalid_request`, issues in `details`)';
const INVALID_INPUT = 'or the planner rejects a value, e.g. a count of 0, more than the page, sheet or grid limit, a negative length or cells that do not fit (`invalid_imposition_input`)';

/** Spec 036e: the largest `POST /jobs/:id/impose` body; the plan options are a few numbers. */
export const IMPOSE_BODY_LIMIT = 16 * 1024;

const IMPOSE_KEYS: ReadonlySet<string> = new Set(['kind', 'options', 'proofMarks']);
const IMPOSE_KINDS: readonly ImposeRequest['kind'][] = ['n-up', 'booklet'];

/** Spec 036e: a `POST /jobs/:id/impose` body; `options` is the Spec 036b body of that kind. */
export type ImposeRequest =
  | { readonly kind: 'n-up'; readonly options: NUpOptions; readonly proofMarks: boolean }
  | { readonly kind: 'booklet'; readonly options: BookletOptions; readonly proofMarks: boolean };

function checkBoolean(value: unknown, path: string, issues: string[]): boolean | undefined {
  if (typeof value === 'boolean') return value;
  issues.push(`${path}: must be a boolean`);
  return undefined;
}

/**
 * Spec 036e: checks the shape of a `POST /jobs/:id/impose` body; throws a 400 `invalid_request` with
 * the issues in `details`, the option issues prefixed with `options.`.
 */
export function parseImposeRequest(body: unknown): ImposeRequest {
  const record = asRecord(body);
  if (record === undefined) throw invalid('Send a JSON object with a kind and options');
  const issues: string[] = [];
  checkKnownFields(record, IMPOSE_KEYS, '', issues);
  const kind = checkChoice(record.kind, IMPOSE_KINDS, 'kind', issues);
  const proofMarks = record.proofMarks === undefined ? false : checkBoolean(record.proofMarks, 'proofMarks', issues);
  if (asRecord(record.options) === undefined) issues.push('options: must be a JSON object');
  if (kind === undefined || proofMarks === undefined || issues.length > 0) throw invalid('invalid impose request', issues);
  if (kind === 'n-up') return { kind, options: parseNUpRequest(record.options, 'options.'), proofMarks };
  return { kind, options: parseBookletRequest(record.options, 'options.'), proofMarks };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** The stored blob's size from the file system, or `undefined` when it is gone; nothing is read. */
async function blobSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

/** The job's first source PDF; its size is checked against the Spec 036d limit before it is read. */
async function readSourcePdf(job: Job, blobPath: ProofRouteDeps['blobPath']): Promise<Uint8Array> {
  const format = job.sourceFormat ?? 'pdf';
  if (format === 'pdf') {
    const [source] = job.sourceFiles;
    const size = source === undefined ? undefined : await blobSize(blobPath(source.storageKey));
    if (size === undefined) throw conflict(`Job ${job.id} has no source file to impose`);
    if (size > MAX_SOURCE_PDF_BYTES) {
      throw sourcePdfTooLarge(`source PDF is ${size} bytes, more than the limit of ${MAX_SOURCE_PDF_BYTES}`);
    }
    const bytes = await readSource(job, blobPath);
    if (bytes === undefined) throw conflict(`Job ${job.id} has no source file to impose`);
    return bytes;
  }
  throw jobSourceNotPdf(`Job ${job.id} has a ${format} source; only a PDF source can be imposed`);
}

/** The Spec 036a plan; a planner rejection answers 400 `invalid_imposition_input`. */
function planOf(request: ImposeRequest): ImpositionProofPlan {
  return request.kind === 'n-up' ? planNUp(request.options) : planBooklet(request.options);
}

/** The n-up sheet is the requested one, so the output geometry matches the plan; a booklet sheet is the 036c default. */
function renderOptionsOf(request: ImposeRequest): ImposedSheetsOptions {
  if (request.kind === 'n-up') return { sheet: request.options.sheet, proofMarks: request.proofMarks };
  return { proofMarks: request.proofMarks };
}

/** Spec 036d errors keep their codes (mapped in `errors.ts`); other option issues, e.g. a sheet above the proof limit, are the request's. */
async function render(request: ImposeRequest, plan: ImpositionProofPlan, sourcePdf: Uint8Array): Promise<Uint8Array> {
  try {
    return await renderImposedSheets(plan, sourcePdf, renderOptionsOf(request));
  } catch (error) {
    if (error instanceof ImposedSheetsError) throw error;
    if (error instanceof MarkSpecError) throw new HttpError(400, 'invalid_imposition_input', error.message, error.issues);
    throw error;
  }
}

const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } };

/** Spec 036e: `POST /jobs/:id/impose` answers the job's first source PDF imposed on the planned sheets. */
function registerImposeRoute(app: FastifyInstance, deps: ProofRouteDeps): void {
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/jobs/:id/impose',
    {
      bodyLimit: IMPOSE_BODY_LIMIT,
      schema: doc({
        operationId: 'imposeJob',
        summary: "Imposes a job's first source PDF on n-up or booklet sheets, one PDF page per sheet side",
        tags: ['imposition'],
        params: ID_PARAMS,
        bodyDoc: { $ref: '#/components/schemas/ImposeRequest' },
        produces: 'application/pdf',
        responses: {
          200: 'The imposed sheets as a PDF attachment',
          400: `${INVALID_BODY}, ${INVALID_INPUT}, or the plan places a page past the end of the source (\`plan_page_out_of_range\`)`,
          404: "Unknown job, or a job outside the caller's sites (the same answer)",
          409: 'The job has no source file (`conflict`) or its source is a raster or vector file (`job_source_not_pdf`)',
          413: `The body is larger than ${IMPOSE_BODY_LIMIT} bytes (\`invalid_request\`) or the stored source PDF is larger than ${MAX_SOURCE_PDF_BYTES} bytes (\`source_pdf_too_large\`)`,
          422: `The source PDF is encrypted (\`source_pdf_encrypted\`), unreadable (\`source_pdf_invalid\`) or has more than ${MAX_SOURCE_PAGES} pages (\`source_pdf_too_many_pages\`), or the plan has more than ${MAX_PROOF_SIDES} sheet sides (\`imposition_too_many_sides\`)`,
        },
      }),
    },
    async (request, reply) => {
      const { id } = request.params;
      // The job is loaded before the body is checked, so an unknown job is a 404 whatever the body.
      const job = await deps.jobs.get(id);
      if (job === undefined) throw notFound('Job', id);
      const impose = parseImposeRequest(request.body);
      // Planned before the source is read, so a rejected plan costs no read.
      const plan = planOf(impose);
      const sourcePdf = await readSourcePdf(job, deps.blobPath);
      const sheets = await render(impose, plan, sourcePdf);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${sanitizeKeySegment(id)}-imposed.pdf"`)
        .send(Buffer.from(sheets.buffer, sheets.byteOffset, sheets.byteLength));
    },
  );
}

/**
 * Spec 036b: `POST /imposition/n-up` and `POST /imposition/booklet` answer the Spec 036a JSON plan; nothing is rendered or stored.
 * Spec 036e: with `source`, `POST /jobs/:id/impose` renders a job's source PDF on the plan's sheets.
 */
export function registerImpositionRoutes(app: FastifyInstance, source?: ProofRouteDeps): void {
  if (source) registerImposeRoute(app, source);

  app.post<{ Body: unknown }>(
    '/imposition/n-up',
    {
      schema: doc({
        operationId: 'planNUp',
        summary: 'Plans an n-up grid of equal cells on a sheet and the pages of each sheet',
        tags: ['imposition'],
        bodyDoc: { $ref: '#/components/schemas/NUpRequest' },
        responseSchema: 'NUpPlan',
        responses: { 200: 'The n-up plan', 400: `${INVALID_BODY}, ${INVALID_INPUT}` },
      }),
    },
    async (request) => planNUp(parseNUpRequest(request.body)),
  );

  app.post<{ Body: unknown }>(
    '/imposition/booklet',
    {
      schema: doc({
        operationId: 'planBooklet',
        summary: 'Plans the saddle-stitch page order of a booklet, sheet by sheet',
        tags: ['imposition'],
        bodyDoc: { $ref: '#/components/schemas/BookletRequest' },
        responseSchema: 'BookletPlan',
        responses: { 200: 'The booklet plan', 400: `${INVALID_BODY}, ${INVALID_INPUT}` },
      }),
    },
    async (request) => planBooklet(parseBookletRequest(request.body)),
  );
}
