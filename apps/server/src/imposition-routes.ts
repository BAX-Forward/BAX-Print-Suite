import type { FastifyInstance } from 'fastify';
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
import { invalid } from './errors.js';
import { doc } from './openapi.js';

/** Spec 036b: `1` mounts `POST /imposition/n-up` and `POST /imposition/booklet`; unset leaves them off; any other value stops startup. */
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
export function parseNUpRequest(body: unknown): NUpOptions {
  const record = asRecord(body);
  if (record === undefined) throw invalid('Send a JSON object with a sheet and a cell');
  const issues: string[] = [];
  checkKnownFields(record, N_UP_KEYS, '', issues);
  const sheet = checkSize(record.sheet, 'sheet', issues);
  const cell = checkSize(record.cell, 'cell', issues);
  const rows = optionalNumber(record.rows, 'rows', issues);
  const cols = optionalNumber(record.cols, 'cols', issues);
  const gutter = optionalNumber(record.gutter, 'gutter', issues);
  const margin = optionalNumber(record.margin, 'margin', issues);
  const pageCount = optionalNumber(record.pageCount, 'pageCount', issues);
  const orientation = record.orientation === undefined ? undefined : checkChoice(record.orientation, ORIENTATIONS, 'orientation', issues);
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
export function parseBookletRequest(body: unknown): BookletOptions {
  const record = asRecord(body);
  if (record === undefined) throw invalid('Send a JSON object with a pageCount, signaturePages and binding');
  const issues: string[] = [];
  checkKnownFields(record, BOOKLET_KEYS, '', issues);
  const pageCount = checkNumber(record.pageCount, 'pageCount', issues);
  const signaturePages = checkChoice(record.signaturePages, SIGNATURE_PAGES, 'signaturePages', issues);
  const binding = checkChoice(record.binding, BINDINGS, 'binding', issues);
  const creep = optionalNumber(record.creep, 'creep', issues);
  if (pageCount === undefined || signaturePages === undefined || binding === undefined || issues.length > 0) {
    throw invalid('invalid booklet request', issues);
  }
  return { pageCount, signaturePages, binding, ...(creep === undefined ? {} : { creep }) };
}

const INVALID_BODY = 'The body is not a valid request: wrong JSON types or an unknown field (`invalid_request`, issues in `details`)';
const INVALID_INPUT = 'or the planner rejects a value, e.g. a count of 0, more than the page, sheet or grid limit, a negative length or cells that do not fit (`invalid_imposition_input`)';

/** Spec 036b: `POST /imposition/n-up` and `POST /imposition/booklet` answer the Spec 036a JSON plan; nothing is rendered or stored. */
export function registerImpositionRoutes(app: FastifyInstance): void {
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
