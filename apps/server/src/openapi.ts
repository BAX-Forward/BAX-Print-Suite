import type { FastifySchema, RouteOptions } from 'fastify';
import {
  FINISHING_STEP_KINDS,
  INK_LIMIT_METHODS,
  INK_LIMIT_PERCENT_MAX,
  INK_LIMIT_PERCENT_MIN,
  MAX_TILING_PANELS_PER_AXIS,
  PERMISSIONS,
  PLANE_CURVE_CHANNELS,
  PLANE_CURVE_METHODS,
  PLANE_CURVES_MAX_POINTS,
  PLANE_CURVES_MAX_VALUE,
  PLANE_CURVES_MIN_POINTS,
  SCREENING_BAYER_SIZES,
  SCREENING_BLUE_NOISE_SIZE_MAX,
  SCREENING_BLUE_NOISE_SIZE_MIN,
  SCREENING_ERROR_DIFFUSION_KERNELS,
  SCREENING_SEED_MAX,
  SCREENING_SEED_MIN,
  TILING_MAX_GAP_MM,
  TILING_MAX_OVERLAP_MM,
  WHITE_INK_CHOKE_PX_MAX,
  WHITE_INK_CHOKE_PX_MIN,
  WHITE_INK_DENSITY_MAX,
  WHITE_INK_DENSITY_MIN,
  WHITE_INK_SEPARATION_NAME_MAX_LENGTH,
  WHITE_INK_SEPARATION_NAME_MIN_LENGTH,
  WHITE_INK_SETTING_MODES,
  WHITE_INK_SETTING_SHAPES,
  WHITE_INK_THRESHOLD_MAX,
  WHITE_INK_THRESHOLD_MIN,
  type Permission,
} from '@bax-print/core';
import { MAX_CREEP_PT, MAX_GRID, MAX_PAGES, MAX_SHEETS } from '@bax-print/nest';
import { routePermission } from './route-permissions.js';
import { isJobRoute } from './site-scope.js';

type JsonSchema = Record<string, unknown>;

/**
 * Route documentation. The JSON schemas here are the ones Fastify validates requests with, so
 * the OpenAPI document is generated from the same schemas the code uses (ARCHITECTURE §5).
 */
export interface RouteDoc {
  operationId: string;
  summary: string;
  tags: string[];
  params?: JsonSchema;
  querystring?: JsonSchema;
  /** Query parameters the handler checks itself, so Fastify does not validate them; documented like `querystring`. */
  queryDoc?: JsonSchema;
  body?: JsonSchema;
  /** A JSON body the handler checks itself, so Fastify does not validate it; documented like `body`. */
  bodyDoc?: JsonSchema;
  /** Media types of a raw (non-JSON) request body. */
  consumes?: string[];
  /** Media type of a raw (non-JSON) response body. */
  produces?: string;
  /** Status code → description. Defaults to `200: OK`. */
  responses?: Record<string, string>;
  /** Name of the `components.schemas` entry that describes the JSON success body. */
  responseSchema?: string;
  /** Text media types the success body may take instead of JSON, chosen by the request. */
  alsoProduces?: string[];
}

/** Passes a RouteDoc to Fastify as a route schema; Fastify ignores the documentation keys. */
export function doc(route: RouteDoc): FastifySchema {
  return route as unknown as FastifySchema;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string; license: { name: string; identifier: string } };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, JsonSchema> };
}

/** The `{ error: { code, message, details? } }` envelope written by `registerErrorHandler`. */
const ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object' }] },
      },
    },
  },
};

/** A webhook subscription as the API returns it: the signing secret is write-only. */
const WEBHOOK_SUBSCRIPTION_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'url', 'eventTypes', 'active'],
  properties: {
    id: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    eventTypes: { type: 'array', items: { type: 'string' } },
    active: { type: 'boolean' },
  },
};

const WEBHOOK_DELIVERY_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['subscriptionId', 'eventId', 'attempt', 'ok', 'at'],
  properties: {
    subscriptionId: { type: 'string' },
    eventId: { type: 'string' },
    attempt: { type: 'integer', minimum: 1 },
    ok: { type: 'boolean' },
    status: { type: 'integer' },
    error: { type: 'string' },
    at: { type: 'string', format: 'date-time' },
  },
};

const CUT_CONTOUR_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'tool', 'source', 'closed', 'points', 'bbox', 'areaSigned'],
  properties: {
    id: { type: 'string' },
    tool: { type: 'string' },
    source: { type: 'object' },
    closed: { type: 'boolean' },
    points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
    bbox: { type: 'object' },
    areaSigned: { type: 'number' },
  },
};

const CUT_WARNING_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['severity', 'code', 'message'],
  properties: {
    severity: { enum: ['error', 'warning'] },
    code: { type: 'string' },
    message: { type: 'string' },
    path: { type: 'string' },
  },
};

/** `POST /jobs/:id/cut-job` (Spec 007g): the planned cut job, or `{ kind: "none" }` when the job is not cut. */
const CUT_JOB_RESULT_SCHEMA: JsonSchema = {
  oneOf: [
    { type: 'object', required: ['kind'], properties: { kind: { const: 'none' } } },
    {
      type: 'object',
      required: ['kind', 'contours', 'warnings', 'job'],
      properties: {
        kind: { const: 'job' },
        contours: { type: 'array', items: CUT_CONTOUR_SCHEMA },
        warnings: { type: 'array', items: CUT_WARNING_SCHEMA },
        job: {
          type: 'object',
          required: ['jobId', 'contours', 'toolMap', 'frame', 'options'],
          properties: {
            jobId: { type: 'string' },
            contours: { type: 'array', items: CUT_CONTOUR_SCHEMA },
            toolMap: { type: 'object' },
            frame: { type: 'object', properties: { widthPt: { type: 'number' }, heightPt: { type: 'number' } } },
            marks: { type: 'object' },
            options: { type: 'object' },
          },
        },
      },
    },
  ],
};

/**
 * `POST /jobs/:id/step-repeat` (Spec 003u): the roll layout, one trim contour per copy and the imposed PDF.
 * Spec 051b: for a tiled job, one placement and one panel outline contour per copy of each tiling panel.
 */
const STEP_REPEAT_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['layout', 'cutContours', 'warnings', 'imposedPdfBase64'],
  properties: {
    layout: {
      type: 'object',
      required: ['placements', 'mediaWidthPt', 'lengthUsedPt', 'utilization', 'unplaced', 'algorithm'],
      properties: {
        placements: { type: 'array', items: { type: 'object' } },
        mediaWidthPt: { type: 'number' },
        lengthUsedPt: { type: 'number' },
        utilization: { type: 'number' },
        unplaced: { type: 'array' },
        algorithm: { type: 'string' },
        elapsedMs: { type: 'number' },
        media: { type: 'object' },
        panels: { type: 'array', items: { type: 'object' } },
      },
    },
    cutContours: {
      type: 'array',
      items: CUT_CONTOUR_SCHEMA,
      description:
        'One closed trim rectangle per copy (`copy-<n>`); for a tiled job one panel outline per panel copy (`<panel item id>/copy-<n>`), in `layout.placements` order',
    },
    warnings: { type: 'array', items: { type: 'object' } },
    imposedPdfBase64: {
      type: 'string',
      contentEncoding: 'base64',
      contentMediaType: 'application/pdf',
      description: 'One page per roll panel; a tiled job draws each tiling panel as a Form XObject whose /BBox is its clip box on the source page',
    },
  },
};

const LAYOUT_TEMPLATE_SUMMARY_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  id: { type: 'string' },
  name: { type: 'string', minLength: 1, maxLength: 120 },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  rollWidthMm: { type: 'number', exclusiveMinimum: 0 },
};

/** A saved layout template (Spec 003w/003x) without its layout document, as `GET /layout-templates` lists it. */
const LAYOUT_TEMPLATE_SUMMARY_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'name', 'createdAt', 'updatedAt', 'rollWidthMm'],
  properties: LAYOUT_TEMPLATE_SUMMARY_PROPERTIES,
};

/** A saved layout template with its layout document: JSON text of an object with a `placements` array, exactly as saved. */
const LAYOUT_TEMPLATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'name', 'createdAt', 'updatedAt', 'rollWidthMm', 'layoutJson'],
  properties: { ...LAYOUT_TEMPLATE_SUMMARY_PROPERTIES, layoutJson: { type: 'string', contentMediaType: 'application/json' } },
};

const DATE_TIME: JsonSchema = { type: 'string', format: 'date-time' };
const ACTOR: JsonSchema = { type: 'string', minLength: 1 };
const refTo = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

/** One step of a finishing plan (Spec 004b); who and when are recorded as the step moves. */
const FINISHING_STEP_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['index', 'kind', 'status'],
  properties: {
    index: { type: 'integer', minimum: 0 },
    kind: { enum: [...FINISHING_STEP_KINDS] },
    label: { type: 'string', minLength: 1 },
    status: { enum: ['pending', 'in_progress', 'done', 'skipped'] },
    startedBy: ACTOR,
    startedAt: DATE_TIME,
    completedBy: ACTOR,
    completedAt: DATE_TIME,
    skippedBy: ACTOR,
    skippedAt: DATE_TIME,
    skipReason: { type: 'string', minLength: 1 },
  },
};

const FINISHING_PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['jobId', 'createdAt', 'updatedAt', 'steps'],
  properties: {
    jobId: { type: 'string', minLength: 1 },
    createdAt: DATE_TIME,
    updatedAt: DATE_TIME,
    steps: { type: 'array', minItems: 1, items: refTo('FinishingStep') },
  },
};

/** `nextStep` is the first step that is neither done nor skipped; it is absent once the plan is complete. */
const FINISHING_PROGRESS_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['total', 'pending', 'inProgress', 'done', 'skipped', 'isComplete'],
  properties: {
    total: { type: 'integer', minimum: 1 },
    pending: { type: 'integer', minimum: 0 },
    inProgress: { type: 'integer', minimum: 0 },
    done: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
    nextStep: refTo('FinishingStep'),
    isComplete: { type: 'boolean' },
  },
};

/** A finishing plan with its progress, as the Spec 004d routes answer it. */
const FINISHING_PLAN_STATE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['plan', 'progress'],
  properties: { plan: refTo('FinishingPlan'), progress: refTo('FinishingProgress') },
};

const COUNT: JsonSchema = { type: 'integer', minimum: 0 };
const TURNAROUND_MS: JsonSchema = { type: ['integer', 'null'], minimum: 0 };

/** Turnarounds are received to done over jobs completed in the window; null when there are none. */
const PRODUCTION_REPORT_TOTALS_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  jobsReceived: COUNT,
  jobsCompleted: COUNT,
  jobsFailedOrCancelled: COUNT,
  medianTurnaroundMs: TURNAROUND_MS,
  p90TurnaroundMs: TURNAROUND_MS,
};

const PRODUCTION_REPORT_TOTALS_SCHEMA: JsonSchema = {
  type: 'object',
  required: Object.keys(PRODUCTION_REPORT_TOTALS_PROPERTIES),
  properties: PRODUCTION_REPORT_TOTALS_PROPERTIES,
};

const PRODUCTION_REPORT_GROUP_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['key', ...Object.keys(PRODUCTION_REPORT_TOTALS_PROPERTIES)],
  properties: { key: { type: 'string' }, ...PRODUCTION_REPORT_TOTALS_PROPERTIES },
};

/** `GET /reports/production` (Spec 023b) with `format=json`: groups are sorted by key. */
const PRODUCTION_REPORT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['from', 'to', 'groups', 'totals'],
  properties: {
    from: DATE_TIME,
    to: DATE_TIME,
    groups: { type: 'array', items: refTo('ProductionReportGroup') },
    totals: refTo('ProductionReportTotals'),
  },
};

/** One device quantity exactly as reported (Spec 017a); units are never converted. */
const ACCOUNTING_QUANTITY_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['kind', 'name', 'value', 'unit'],
  properties: {
    kind: { enum: ['ink', 'media', 'other'] },
    name: { type: 'string', minLength: 1 },
    value: { type: 'number' },
    unit: { type: 'string', minLength: 1 },
  },
};

/** Quantities summed for one accounting ID (Spec 017c); `null` collects jobs without one. */
const ACCOUNTING_ID_GROUP_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['accountingId', 'jobIds', 'quantities'],
  properties: {
    accountingId: { type: ['string', 'null'] },
    jobIds: { type: 'array', items: { type: 'string' } },
    quantities: { type: 'array', items: refTo('AccountingQuantity') },
  },
};

/** `GET /reports/accounting` (Spec 017d): groups are sorted by accounting ID with `null` last. */
const ACCOUNTING_REPORT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['from', 'to', 'groups'],
  properties: {
    from: DATE_TIME,
    to: DATE_TIME,
    groups: { type: 'array', items: refTo('AccountingIdGroup') },
  },
};

/** An API token as the Spec 029c routes answer it: never the secret or its hash. */
const API_TOKEN_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'name', 'prefix', 'scopes', 'createdAt'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    prefix: { type: 'string', description: 'The first 8 characters of the secret after `bps_`, for display' },
    scopes: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: [...PERMISSIONS] } },
    createdAt: DATE_TIME,
    expiresAt: DATE_TIME,
    revokedAt: DATE_TIME,
  },
};

/** `POST /api-tokens` (Spec 029c): the only answer that carries the secret. */
const ISSUED_API_TOKEN_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['token', 'secret'],
  properties: {
    token: refTo('ApiToken'),
    secret: { type: 'string', pattern: '^bps_[A-Za-z0-9_-]{43}$', description: 'Send as `Authorization: Bearer <secret>`' },
  },
};

/** `POST /login` (Spec 028d): `token` is present only when the session is not handed out as a cookie. */
const LOGIN_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['user', 'expiresAt'],
  properties: {
    user: {
      type: 'object',
      required: ['id', 'username', 'displayName', 'roles', 'createdAt'],
      properties: {
        id: { type: 'string' },
        username: { type: 'string' },
        displayName: { type: 'string' },
        roles: { type: 'array', minItems: 1, items: { type: 'string' } },
        createdAt: DATE_TIME,
      },
    },
    expiresAt: DATE_TIME,
    token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
  },
};

/** `POST /jobs/:id/print` (Spec 034a): the printer plugin's id of the output job it created. */
const PRINT_SUBMISSION_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['outputJobId'],
  properties: { outputJobId: { type: 'string', minLength: 1 } },
};

/** An output job as the printer plugin reports it (Spec 034a); `state` is the plugin's word for it. */
const PRINT_OUTPUT_STATUS_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['outputJobId', 'state'],
  properties: { outputJobId: { type: 'string', minLength: 1 }, state: { type: 'string' }, message: { type: 'string' } },
};

/** Spec 032b: the most colours one `POST /swatch-charts` library may have. */
export const SWATCH_CHART_MAX_COLORS = 2000;
/** Spec 032b: the longest library or colour name, in characters; the marks package also caps a colour name at 127 UTF-8 bytes. */
export const SWATCH_NAME_MAX_CHARS = 127;

const SWATCH_NAME: JsonSchema = { type: 'string', minLength: 1, maxLength: SWATCH_NAME_MAX_CHARS };
const mmOption = (minimum: number, maximum: number, value: number): JsonSchema => ({ type: 'number', minimum, maximum, default: value });

/**
 * `POST /swatch-charts` (Spec 032b): the spot library and the Spec 032a chart options. The route
 * checks the shape and limits; the marks package checks the ranges and the page fit.
 */
const SWATCH_CHART_REQUEST_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['library'],
  additionalProperties: false,
  properties: {
    library: {
      type: 'object',
      required: ['name', 'colors'],
      properties: {
        name: { ...SWATCH_NAME, description: 'Printed in the page title; no control characters, not blank' },
        colors: {
          type: 'array',
          maxItems: SWATCH_CHART_MAX_COLORS,
          items: {
            type: 'object',
            required: ['name', 'lab'],
            properties: {
              name: { ...SWATCH_NAME, description: 'The Separation colorant name; at most 127 UTF-8 bytes, no control characters, not blank' },
              lab: {
                type: 'object',
                required: ['L', 'a', 'b'],
                properties: {
                  L: { type: 'number', minimum: 0, maximum: 100 },
                  a: { type: 'number', minimum: -128, maximum: 127 },
                  b: { type: 'number', minimum: -128, maximum: 127 },
                },
              },
              cmykFallback: {
                type: 'array',
                minItems: 4,
                maxItems: 4,
                items: { type: 'number', minimum: 0, maximum: 100 },
                description: 'C, M, Y and K percent of the DeviceCMYK alternate; all zero when absent',
              },
            },
          },
        },
      },
    },
    options: {
      type: 'object',
      description: 'The swatch rows must fit between the margins and below the title',
      properties: {
        pageWidthMm: mmOption(20, 5000, 210),
        pageHeightMm: mmOption(20, 5000, 297),
        columns: { type: 'integer', minimum: 1, maximum: 100, default: 6 },
        swatchSizeMm: mmOption(5, 1000, 25),
        gapMm: mmOption(0, 100, 5),
        marginMm: mmOption(0, 500, 10),
        showLabels: { type: 'boolean', default: true },
      },
    },
  },
};

const POINTS: JsonSchema = { type: 'number', description: 'Points (1/72 inch)' };
const POSITIVE_POINTS: JsonSchema = { ...POINTS, exclusiveMinimum: 0 };
const PAGE_SLOT: JsonSchema = { oneOf: [{ type: 'integer', minimum: 1 }, { const: 'blank' }] };
const ROTATION: JsonSchema = { enum: [0, 90] };
const N_UP_SIZE: JsonSchema = {
  type: 'object',
  required: ['width', 'height'],
  additionalProperties: false,
  properties: { width: POSITIVE_POINTS, height: POSITIVE_POINTS },
};

/**
 * `POST /imposition/n-up` (Spec 036b): the Spec 036a `planNUp` options. The route checks the JSON
 * types and unknown fields; the planner checks the ranges, the limits and the fit.
 */
const N_UP_REQUEST_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['sheet', 'cell'],
  additionalProperties: false,
  properties: {
    sheet: N_UP_SIZE,
    cell: { ...N_UP_SIZE, description: 'The cell size before rotation' },
    rows: { type: 'integer', minimum: 1, maximum: MAX_GRID, description: 'Omitted: as many as fit' },
    cols: { type: 'integer', minimum: 1, maximum: MAX_GRID, description: 'Omitted: as many as fit' },
    gutter: { ...POINTS, minimum: 0, default: 0, description: 'Gap between neighboring cells; at most the smaller sheet side' },
    margin: { ...POINTS, minimum: 0, default: 0, description: 'Same on all four sheet edges; must leave a usable area' },
    orientation: { enum: ['upright', 'turned', 'auto'], default: 'upright' },
    pageCount: { type: 'integer', minimum: 1, maximum: MAX_PAGES, description: `Omitted: the plan has no sheets; at most ${MAX_SHEETS} sheets` },
  },
};

const N_UP_PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['rows', 'cols', 'rotation', 'cellsPerSheet', 'pageCount', 'blankCount', 'placements', 'sheets'],
  properties: {
    rows: { type: 'integer', minimum: 1 },
    cols: { type: 'integer', minimum: 1 },
    rotation: ROTATION,
    cellsPerSheet: { type: 'integer', minimum: 1 },
    pageCount: COUNT,
    blankCount: COUNT,
    placements: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'row', 'col', 'x', 'y', 'width', 'height', 'rotation'],
        description: 'Row 0 is at the top; x and y are the bottom-left of the footprint (y up)',
        properties: { index: COUNT, row: COUNT, col: COUNT, x: POINTS, y: POINTS, width: POINTS, height: POINTS, rotation: ROTATION },
      },
    },
    sheets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'pages'],
        properties: { index: COUNT, pages: { type: 'array', items: PAGE_SLOT, description: '`pages[k]` goes into `placements[k]`' } },
      },
    },
  },
};

/** `POST /imposition/booklet` (Spec 036b): the Spec 036a `planBooklet` options, checked like the n-up ones. */
const BOOKLET_REQUEST_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['pageCount', 'signaturePages', 'binding'],
  additionalProperties: false,
  properties: {
    pageCount: { type: 'integer', minimum: 1, maximum: MAX_PAGES, description: `At most ${MAX_SHEETS} sheets of 4 pages` },
    signaturePages: { enum: [4, 8, 16, 'single'], description: '"single": every sheet nested in one signature' },
    binding: { enum: ['left', 'right'] },
    creep: {
      ...POINTS,
      minimum: 0,
      maximum: MAX_CREEP_PT,
      default: 0,
      description: 'Per sheet, growing inward; the innermost sheet offset must not exceed 10 mm either',
    },
  },
};

/** `POST /jobs/:id/impose` (Spec 036e): the plan options of one kind, checked like the Spec 036b bodies. */
const IMPOSE_REQUEST_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['kind', 'options'],
  additionalProperties: false,
  properties: {
    kind: { enum: ['n-up', 'booklet'] },
    options: {
      oneOf: [refTo('NUpRequest'), refTo('BookletRequest')],
      description: 'The `POST /imposition/n-up` body for `n-up`, the `POST /imposition/booklet` body for `booklet`',
    },
    proofMarks: { type: 'boolean', default: false, description: 'Draws the Spec 036c proof marks and labels over the content' },
  },
};

const BOOKLET_SIDE: JsonSchema = { type: 'array', items: PAGE_SLOT, minItems: 2, maxItems: 2, description: 'Left then right' };

const BOOKLET_PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['pageCount', 'paddedPageCount', 'blankCount', 'pagesPerSignature', 'sheetsPerSignature', 'signatureCount', 'binding', 'sheets'],
  properties: {
    pageCount: { type: 'integer', minimum: 1 },
    paddedPageCount: { type: 'integer', minimum: 4 },
    blankCount: COUNT,
    pagesPerSignature: { type: 'integer', minimum: 4 },
    sheetsPerSignature: { type: 'integer', minimum: 1 },
    signatureCount: { type: 'integer', minimum: 1 },
    binding: { enum: ['left', 'right'] },
    sheets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'signature', 'position', 'front', 'back', 'creep'],
        properties: { index: COUNT, signature: COUNT, position: COUNT, front: BOOKLET_SIDE, back: BOOKLET_SIDE, creep: { ...POINTS, minimum: 0 } },
      },
    },
  },
};

/** `PUT /jobs/:id/white-ink` (Spec 038c): the Spec 038b white ink setting, checked strictly by core `parseWhiteInkSetting`. */
const WHITE_INK_SETTING_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['mode'],
  additionalProperties: false,
  properties: {
    mode: { enum: [...WHITE_INK_SETTING_MODES] },
    threshold: { type: 'integer', minimum: WHITE_INK_THRESHOLD_MIN, maximum: WHITE_INK_THRESHOLD_MAX },
    chokePx: { type: 'integer', minimum: WHITE_INK_CHOKE_PX_MIN, maximum: WHITE_INK_CHOKE_PX_MAX },
    shape: { enum: [...WHITE_INK_SETTING_SHAPES] },
    density: { type: 'integer', minimum: WHITE_INK_DENSITY_MIN, maximum: WHITE_INK_DENSITY_MAX, description: 'Percent' },
    invert: { type: 'boolean' },
    separationName: {
      type: 'string',
      minLength: WHITE_INK_SEPARATION_NAME_MIN_LENGTH,
      maxLength: WHITE_INK_SEPARATION_NAME_MAX_LENGTH,
      pattern: '^[\\x20-\\x7e]+$',
      description: 'Printable ASCII, not blank',
    },
  },
};

/** Spec 038c: the `{ job }` the white ink routes answer; only the fields this route group documents are listed. */
const WHITE_INK_JOB_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['job'],
  properties: {
    job: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        updatedAt: { type: 'string', format: 'date-time' },
        whiteInk: {
          ...refTo('WhiteInkSetting'),
          description: 'Optional; absent means white ink is off. A stored value that is not a valid setting reads back absent',
        },
      },
    },
  },
};

/** `PUT /jobs/:id/screening` (Spec 039c): the Spec 039b screening setting, checked strictly by core `parseScreeningSetting`. */
const SCREENING_SETTING_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['kind', 'size'],
      additionalProperties: false,
      properties: {
        kind: { const: 'bayer' },
        size: { enum: [...SCREENING_BAYER_SIZES] },
      },
    },
    {
      type: 'object',
      required: ['kind', 'size', 'seed'],
      additionalProperties: false,
      properties: {
        kind: { const: 'blue-noise' },
        size: { type: 'integer', minimum: SCREENING_BLUE_NOISE_SIZE_MIN, maximum: SCREENING_BLUE_NOISE_SIZE_MAX },
        seed: { type: 'integer', minimum: SCREENING_SEED_MIN, maximum: SCREENING_SEED_MAX, description: 'Unsigned 32-bit integer' },
      },
    },
    {
      type: 'object',
      description: 'Spec 045c: error diffusion of each plane; it has no tile, so no size or seed',
      required: ['kind', 'kernel'],
      additionalProperties: false,
      properties: {
        kind: { const: 'error-diffusion' },
        kernel: { enum: [...SCREENING_ERROR_DIFFUSION_KERNELS] },
        serpentine: { type: 'boolean', description: 'Optional; absent means every row is scanned left to right' },
      },
    },
  ],
};

/** Spec 039c: the `{ job }` the screening routes answer; only the fields this route group documents are listed. */
const SCREENING_JOB_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['job'],
  properties: {
    job: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        updatedAt: { type: 'string', format: 'date-time' },
        screening: {
          ...refTo('ScreeningSetting'),
          description: 'Optional; absent means no screening is requested. A stored value that is not a valid setting reads back absent',
        },
      },
    },
  },
};

/** `PUT /jobs/:id/ink-limit` (Spec 040c): the Spec 040b ink-limit setting, checked strictly by core `parseInkLimitSetting`. */
const INK_LIMIT_SETTING_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['limitPercent', 'method'],
  additionalProperties: false,
  properties: {
    limitPercent: {
      type: 'integer',
      minimum: INK_LIMIT_PERCENT_MIN,
      maximum: INK_LIMIT_PERCENT_MAX,
      description: 'Total area coverage limit in percent',
    },
    method: { enum: [...INK_LIMIT_METHODS] },
  },
};

/** Spec 040c: the `{ job }` the ink-limit routes answer; only the fields this route group documents are listed. */
const INK_LIMIT_JOB_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['job'],
  properties: {
    job: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        updatedAt: { type: 'string', format: 'date-time' },
        inkLimit: {
          ...refTo('InkLimitSetting'),
          description: 'Optional; absent means no ink limit is requested. A stored value that is not a valid setting reads back absent',
        },
      },
    },
  },
};

/** Spec 044d: one 8-bit level of a plane curve point. */
const PLANE_CURVE_LEVEL: JsonSchema = { type: 'integer', minimum: 0, maximum: PLANE_CURVES_MAX_VALUE };

/** Spec 044b: one channel's curve. The ordering rules are checked by core and stated in the description. */
const PLANE_CURVE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['points', 'method'],
  additionalProperties: false,
  properties: {
    points: {
      type: 'array',
      minItems: PLANE_CURVES_MIN_POINTS,
      maxItems: PLANE_CURVES_MAX_POINTS,
      description: `Inputs strictly increase, the first is 0 and the last ${String(PLANE_CURVES_MAX_VALUE)}; outputs never decrease`,
      items: {
        type: 'object',
        required: ['in', 'out'],
        additionalProperties: false,
        properties: { in: PLANE_CURVE_LEVEL, out: PLANE_CURVE_LEVEL },
      },
    },
    method: { enum: [...PLANE_CURVE_METHODS] },
  },
};

/** `PUT /jobs/:id/plane-curves` (Spec 044d): the Spec 044b plane-curves setting, checked strictly by core `parsePlaneCurvesSetting`. */
const PLANE_CURVES_SETTING_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  description: 'At least one channel; `{}` is rejected. A missing channel leaves that plane unchanged',
  properties: Object.fromEntries(PLANE_CURVE_CHANNELS.map((channel) => [channel, PLANE_CURVE_SCHEMA])),
};

/** Spec 044d: the `{ job }` the plane-curves routes answer; only the fields this route group documents are listed. */
const PLANE_CURVES_JOB_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['job'],
  properties: {
    job: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        updatedAt: { type: 'string', format: 'date-time' },
        planeCurves: {
          ...refTo('PlaneCurvesSetting'),
          description: 'Optional; absent means no curves are requested. A stored value that is not a valid setting reads back absent',
        },
      },
    },
  },
};

/** Spec 050a: a panel count along one axis of the tiling grid. */
const TILING_PANEL_COUNT: JsonSchema = { type: 'integer', minimum: 1, maximum: MAX_TILING_PANELS_PER_AXIS };

/** `PUT /jobs/:id/tiling` (Spec 050a): the tiling setting, checked strictly by core `parseTilingSetting`. */
const TILING_SETTING_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['grid'],
  additionalProperties: false,
  description: '`{}` is rejected. Without `seam`, every seam overlaps by the tile default of 25 mm',
  properties: {
    grid: {
      type: 'object',
      required: ['columns', 'rows'],
      additionalProperties: false,
      properties: { columns: TILING_PANEL_COUNT, rows: TILING_PANEL_COUNT },
    },
    seam: {
      oneOf: [
        { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { const: 'butt' } } },
        {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: {
            kind: { const: 'overlap' },
            overlapMm: {
              type: 'number',
              minimum: 0,
              maximum: TILING_MAX_OVERLAP_MM,
              description: 'Millimetres each neighbour prints past the seam; absent means the tile default of 25 mm',
            },
          },
        },
        {
          type: 'object',
          required: ['kind', 'gapMm'],
          additionalProperties: false,
          properties: {
            kind: { const: 'gap' },
            gapMm: {
              type: 'number',
              exclusiveMinimum: 0,
              maximum: TILING_MAX_GAP_MM,
              description: 'Width in millimetres of the unprinted strip centred on the seam',
            },
          },
        },
      ],
    },
  },
};

/** Spec 050a: the `{ job }` the tiling routes answer; only the fields this route group documents are listed. */
const TILING_JOB_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['job'],
  properties: {
    job: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        updatedAt: { type: 'string', format: 'date-time' },
        tiling: {
          ...refTo('TilingSetting'),
          description: 'Optional; absent means the job is not tiled. A stored value that is not a valid setting reads back absent',
        },
      },
    },
  },
};

/** Spec 043a: the longest side of a `POST /jobs/:id/screen-preview` image, in pixels. */
export const SCREEN_PREVIEW_MAX_SIDE = 1024;

const PREVIEW_SIDE: JsonSchema = { type: 'integer', minimum: 1, maximum: SCREEN_PREVIEW_MAX_SIDE };

/** One 8-bit plane, one byte per pixel row by row; 255 = 100 %. */
const PREVIEW_PLANE: JsonSchema = {
  type: 'string',
  contentEncoding: 'base64',
  description: 'Padded base64 of exactly width * height bytes, so 4 * ceil(width * height / 3) characters',
};

/** `POST /jobs/:id/screen-preview` (Spec 043a): CMYK planes, checked strictly by the route; width and height before any plane is decoded. */
const SCREEN_PREVIEW_REQUEST_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['width', 'height', 'c', 'm', 'y', 'k'],
  additionalProperties: false,
  properties: {
    width: PREVIEW_SIDE,
    height: PREVIEW_SIDE,
    format: {
      enum: ['packed', 'pbm'],
      default: 'packed',
      description: 'Spec 043b: how each screened plane is answered. Absent or `packed`: the Spec 043a packed planes with `rowBytes`; `pbm`: each plane is a raw PBM (`P4`) file',
    },
    c: PREVIEW_PLANE,
    m: PREVIEW_PLANE,
    y: PREVIEW_PLANE,
    k: PREVIEW_PLANE,
  },
};

/** One screened plane packed 1 bit per pixel: most significant bit first, bit 1 = ink, unused low bits of a row's last byte 0. */
const PACKED_PLANE: JsonSchema = { type: 'string', contentEncoding: 'base64', description: 'Base64 of rowBytes * height bytes' };

/** Spec 043b: one screened plane as a raw PBM file; the packed rows follow its header unchanged, bit 1 = black = ink. */
const PBM_PLANE: JsonSchema = {
  type: 'string',
  contentEncoding: 'base64',
  contentMediaType: 'image/x-portable-bitmap',
  description: 'Base64 of a raw PBM: the header `P4\\n<width> <height>\\n`, then ceil(width / 8) * height bytes of packed rows',
};

/**
 * Spec 043a/043b: the job's screening (and ink limit, if set) applied to the request planes. The packed
 * shape is the Spec 043a answer, unchanged and without `format`. The PBM shape drops `rowBytes`, since
 * each PBM header carries the size, and names its `format` so a client can tell the two apart.
 */
const SCREEN_PREVIEW_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      description: 'Absent or `format: "packed"` in the request',
      required: ['width', 'height', 'rowBytes', 'c', 'm', 'y', 'k'],
      properties: {
        width: PREVIEW_SIDE,
        height: PREVIEW_SIDE,
        rowBytes: { type: 'integer', minimum: 1, description: 'ceil(width / 8)' },
        c: PACKED_PLANE,
        m: PACKED_PLANE,
        y: PACKED_PLANE,
        k: PACKED_PLANE,
      },
    },
    {
      type: 'object',
      description: '`format: "pbm"` in the request',
      required: ['width', 'height', 'format', 'c', 'm', 'y', 'k'],
      properties: {
        width: PREVIEW_SIDE,
        height: PREVIEW_SIDE,
        format: { const: 'pbm' },
        c: PBM_PLANE,
        m: PBM_PLANE,
        y: PBM_PLANE,
        k: PBM_PLANE,
      },
    },
  ],
};

/** Spec 052a: a job as `POST /jobs`, `GET /jobs` and `GET /jobs/:id` answer it; the optional settings are omitted here. */
const JOB_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'name', 'status', 'priority', 'sourceFiles', 'artifacts', 'ticket', 'tags', 'metadata', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string', description: 'The sanitized `x-bps-job-name` of an upload, else its server-generated file name' },
    status: { type: 'string' },
    sourceFormat: { type: 'string' },
    priority: { type: 'integer', minimum: 0, maximum: 100 },
    sourceFiles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'sha256', 'sizeBytes', 'storageKey'],
        properties: { name: { type: 'string' }, sha256: { type: 'string' }, sizeBytes: { type: 'integer', minimum: 0 }, storageKey: { type: 'string' } },
      },
    },
    artifacts: { type: 'array', items: { type: 'object' } },
    ticket: { type: 'object', properties: { siteId: { type: 'string' } } },
    tags: { type: 'array', items: { type: 'string' } },
    metadata: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Spec 052a: an upload records `intakeFile` (its server-generated file name) and, when sent, `displayName`',
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    lifecycle: { type: 'string' },
    legalHold: { type: 'boolean' },
  },
};

/** Spec 052a: one page of `GET /jobs`. */
const JOB_PAGE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', items: refTo('Job') },
    nextCursor: { type: ['string', 'null'], description: 'Pass as `cursor` for the next page; null on the last page' },
  },
};

/** Spec 052a: the body of `GET /health`. */
const HEALTH_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['status'],
  properties: { status: { const: 'ok' } },
};

const itemsOf = (name: string): JsonSchema => ({
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array', items: { $ref: `#/components/schemas/${name}` } } },
});

const COMPONENT_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  Error: ERROR_SCHEMA,
  WebhookSubscription: WEBHOOK_SUBSCRIPTION_SCHEMA,
  WebhookSubscriptionList: itemsOf('WebhookSubscription'),
  WebhookDelivery: WEBHOOK_DELIVERY_SCHEMA,
  WebhookDeliveryList: itemsOf('WebhookDelivery'),
  CutJobResult: CUT_JOB_RESULT_SCHEMA,
  StepRepeatResult: STEP_REPEAT_RESULT_SCHEMA,
  LayoutTemplate: LAYOUT_TEMPLATE_SCHEMA,
  LayoutTemplateSummary: LAYOUT_TEMPLATE_SUMMARY_SCHEMA,
  LayoutTemplateSummaryList: itemsOf('LayoutTemplateSummary'),
  FinishingStep: FINISHING_STEP_SCHEMA,
  FinishingPlan: FINISHING_PLAN_SCHEMA,
  FinishingProgress: FINISHING_PROGRESS_SCHEMA,
  FinishingPlanState: FINISHING_PLAN_STATE_SCHEMA,
  FinishingPlanStateList: itemsOf('FinishingPlanState'),
  ProductionReportTotals: PRODUCTION_REPORT_TOTALS_SCHEMA,
  ProductionReportGroup: PRODUCTION_REPORT_GROUP_SCHEMA,
  ProductionReport: PRODUCTION_REPORT_SCHEMA,
  AccountingQuantity: ACCOUNTING_QUANTITY_SCHEMA,
  AccountingIdGroup: ACCOUNTING_ID_GROUP_SCHEMA,
  AccountingReport: ACCOUNTING_REPORT_SCHEMA,
  ApiToken: API_TOKEN_SCHEMA,
  ApiTokenList: itemsOf('ApiToken'),
  ApiTokenEnvelope: { type: 'object', required: ['token'], properties: { token: refTo('ApiToken') } },
  IssuedApiToken: ISSUED_API_TOKEN_SCHEMA,
  LoginResult: LOGIN_RESULT_SCHEMA,
  SwatchChartRequest: SWATCH_CHART_REQUEST_SCHEMA,
  NUpRequest: N_UP_REQUEST_SCHEMA,
  NUpPlan: N_UP_PLAN_SCHEMA,
  BookletRequest: BOOKLET_REQUEST_SCHEMA,
  BookletPlan: BOOKLET_PLAN_SCHEMA,
  ImposeRequest: IMPOSE_REQUEST_SCHEMA,
  PrintSubmission: PRINT_SUBMISSION_SCHEMA,
  PrintOutputStatus: PRINT_OUTPUT_STATUS_SCHEMA,
  WhiteInkSetting: WHITE_INK_SETTING_SCHEMA,
  WhiteInkJob: WHITE_INK_JOB_SCHEMA,
  ScreeningSetting: SCREENING_SETTING_SCHEMA,
  ScreeningJob: SCREENING_JOB_SCHEMA,
  InkLimitSetting: INK_LIMIT_SETTING_SCHEMA,
  InkLimitJob: INK_LIMIT_JOB_SCHEMA,
  PlaneCurvesSetting: PLANE_CURVES_SETTING_SCHEMA,
  PlaneCurvesJob: PLANE_CURVES_JOB_SCHEMA,
  TilingSetting: TILING_SETTING_SCHEMA,
  TilingJob: TILING_JOB_SCHEMA,
  ScreenPreviewRequest: SCREEN_PREVIEW_REQUEST_SCHEMA,
  ScreenPreview: SCREEN_PREVIEW_SCHEMA,
  Job: JOB_SCHEMA,
  JobEnvelope: { type: 'object', required: ['job'], properties: { job: refTo('Job') } },
  JobPage: JOB_PAGE_SCHEMA,
  Health: HEALTH_SCHEMA,
};

function parameters(schema: JsonSchema | undefined, location: 'path' | 'query'): unknown[] {
  if (!schema) return [];
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    required: location === 'path' || required.has(name),
    schema: property,
  }));
}

/** Spec 028c: the 401 of a route that needs a permission, unless the route documents its own. */
const UNAUTHENTICATED_DESCRIPTION =
  'No credential verifier recognized the caller and the actor resolver denies anonymous callers (`unauthenticated`)';

/**
 * Spec 024b: the 403 of a route that needs `permission`, unless the route documents its own.
 * Spec 028c: and its 401, which a resolver with the `deny` fallback answers.
 */
function withForbidden(responses: Record<string, string> | undefined, permission: Permission | undefined): Record<string, string> {
  const declared = responses ?? { 200: 'OK' };
  if (permission === undefined) return declared;
  return {
    ...(declared['401'] === undefined ? { 401: UNAUTHENTICATED_DESCRIPTION } : {}),
    ...(declared['403'] === undefined
      ? { 403: `The caller's role, or an API token's scopes, lack the \`${permission}\` permission (\`forbidden\`, \`details.permission\` names it)` }
      : {}),
    ...declared,
  };
}

/** Spec 030c: the 404 a `/jobs/:id` route answers for another site's job when site scoping is enabled. */
const SITE_SCOPE_NOT_FOUND_DESCRIPTION =
  "With site scoping enabled, a job of a site the caller's membership does not grant answers like a missing job (`not_found`)";

function withSiteScope(responses: Record<string, string>, url: string): Record<string, string> {
  if (!isJobRoute(url)) return responses;
  const declared = responses['404'];
  return { ...responses, 404: declared === undefined ? SITE_SCOPE_NOT_FOUND_DESCRIPTION : `${declared}. ${SITE_SCOPE_NOT_FOUND_DESCRIPTION}` };
}

function operation(route: RouteDoc, url: string, permission?: Permission): Record<string, unknown> {
  const op: Record<string, unknown> = {
    operationId: route.operationId,
    summary: route.summary,
    tags: route.tags,
  };
  const params = [
    ...parameters(route.params, 'path'),
    ...parameters(route.querystring, 'query'),
    ...parameters(route.queryDoc, 'query'),
  ];
  if (params.length > 0) op.parameters = params;
  const body = route.body ?? route.bodyDoc;
  if (body) {
    op.requestBody = { required: true, content: { 'application/json': { schema: body } } };
  } else if (route.consumes) {
    op.requestBody = {
      required: true,
      content: Object.fromEntries(route.consumes.map((type) => [type, { schema: { type: 'string', format: 'binary' } }])),
    };
  }
  const responses: Record<string, unknown> = {};
  for (const [status, description] of Object.entries(withSiteScope(withForbidden(route.responses, permission), url))) {
    const ok = Number(status) < 300 && Number(status) !== 204;
    if (!ok) {
      responses[status] = { description };
    } else if (route.produces) {
      responses[status] = { description, content: { [route.produces]: { schema: { type: 'string', format: 'binary' } } } };
    } else {
      const schema = route.responseSchema ? { $ref: `#/components/schemas/${route.responseSchema}` } : {};
      const text = (route.alsoProduces ?? []).map((type): [string, JsonSchema] => [type, { schema: { type: 'string' } }]);
      responses[status] = { description, content: { 'application/json': { schema }, ...Object.fromEntries(text) } };
    }
  }
  responses.default = {
    description: 'Error',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
  op.responses = responses;
  return op;
}

/** Spec 024b: how callers are authorized, including the no-resolver default. Spec 028c: and the 401. */
const API_DESCRIPTION = [
  "Every route except `GET /openapi.json` needs a permission of the caller's role and answers 403 `forbidden`",
  'without it; `details.permission` names the missing permission.',
  'An actor resolver configured to deny anonymous callers answers 401 `unauthenticated` when no credential verifier recognizes the caller.',
  'Spec 029c: when API tokens are enabled, `Authorization: Bearer bps_...` authenticates as the token, whose permissions are exactly its scopes;',
  'an unknown, revoked, expired or malformed token answers 401 `unauthenticated` and never falls back. Other credentials are ignored.',
  'Managing tokens needs the admin-only `webhooks:*` permissions, and a caller may only issue scopes it holds.',
  "Spec 030c: when site scoping is enabled (`BPS_SITE_SCOPE=1`), every `/jobs/{id}` route answers 404 `not_found` for a job of a site the caller's membership does not grant,",
  'and `GET /archive` and `GET /trash` list only the jobs of granted sites; a job without a `siteId` belongs to the `default` site, and a caller without a membership sees no jobs.',
  'The site is read from the stored job, never from the request.',
  'Without a configured actor resolver every caller is treated as the local admin, which holds every permission.',
  'The server binds 127.0.0.1 by default; do not expose it beyond loopback without a resolver.',
  'With login on (`BPS_LOGIN=1`), `POST /login` starts a session and every guarded route needs its token, as the',
  '`bps_session` cookie or an `Authorization: Bearer` header; a caller without one gets 401 and there is no local admin.',
  'Spec 031c: a job records `sourceFormat` (`pdf`, `png`, `jpeg` or `tiff`), detected from the magic bytes of its first source file,',
  'and omits it when the bytes match none of them. Job creation takes any bytes; a hot folder takes in TIFF, JPEG and PNG files',
  'only when its settings have `acceptRaster: true`, and otherwise matches its `filePatterns` alone.',
  'Spec 035b: `sourceFormat` may also be `svg` or `dxf`, read from the SVG root element or the ASCII DXF section header, never from',
  'the file name; a hot folder takes in SVG and DXF files only when its settings have `acceptVector: true`. Preflight of such a job',
  'runs the vector checks (`vector-size`, `vector-markup`) on the header alone; nothing an SVG declares or references is fetched.',
  'Spec 034a: the `/jobs/{id}/print` routes exist only with `BPS_PRINT_OUTPUT=1` and a printer plugin (`BPS_PRINTER_PLUGIN`);',
  "they send the job's PDF source to it through `printer/submitDocument`. A device that takes no finished documents or not",
  'this format answers 409 `document_input_unsupported`, a document above its limit 413 `document_too_large`, and any other',
  "plugin failure 502 `printer_error`; each carries the plugin's uppercase code in `details.code`.",
  'Spec 038c: a job may carry an optional `whiteInk` setting (`WhiteInkSetting`); absent means white ink is off, and a stored value',
  'that is not a valid setting reads back absent. `PUT` and `DELETE /jobs/{id}/white-ink` set and clear it, and exist only with `BPS_WHITE_INK=1`.',
  'Spec 039c: a job may carry an optional `screening` setting (`ScreeningSetting`); absent means no screening is requested, and a stored value',
  'that is not a valid setting reads back absent. `PUT` and `DELETE /jobs/{id}/screening` set and clear it, and exist only with `BPS_SCREENING=1`.',
  'Spec 040c: a job may carry an optional `inkLimit` setting (`InkLimitSetting`); absent means no ink limit is requested, and a stored value',
  'that is not a valid setting reads back absent. `PUT` and `DELETE /jobs/{id}/ink-limit` set and clear it, and exist only with `BPS_INK_LIMIT=1`.',
  "Spec 043a: `POST /jobs/{id}/screen-preview` screens CMYK planes with the job's `screening` and `inkLimit` settings and answers them packed",
  '1 bit per pixel; nothing is stored. A job without `screening` answers 409 `screening_not_set`. It exists only with `BPS_SCREEN_PREVIEW=1`.',
  'Spec 043b: with `format: "pbm"` in the body, each plane is answered as a raw PBM (`P4`) file instead, and the answer names its `format`.',
  'Spec 044d: a job may carry an optional `planeCurves` setting (`PlaneCurvesSetting`); absent means no curves are requested, and a stored value',
  'that is not a valid setting reads back absent. `PUT` and `DELETE /jobs/{id}/plane-curves` set and clear it, and exist only with `BPS_PLANE_CURVES=1`.',
  'Spec 044e: `POST /jobs/{id}/screen-preview` applies stored `planeCurves` after the ink limit and before screening; a job without them',
  'is screened as before, and a job with curves but no `screening` still answers 409 `screening_not_set`.',
  'Spec 050a: a job may carry an optional `tiling` setting (`TilingSetting`); absent means the job is not tiled, and a stored value',
  'that is not a valid setting reads back absent. `PUT` and `DELETE /jobs/{id}/tiling` set and clear it, and exist only with `BPS_TILING=1`.',
  'Spec 052a: `POST /jobs`, `GET /jobs` and `GET /jobs/{id}` exist only with `BPS_JOB_INTAKE=1`. An upload is a raw `application/pdf` body',
  'of at most 256 MiB (lower with `BPS_JOB_INTAKE_MAX_BYTES`) that starts with `%PDF-`; it is stored under a server-generated name, never the',
  "client's. `GET /health` is public and always mounted.",
].join(' ');

/** Collects documented routes through Fastify's `onRoute` hook. */
export class OpenApiCollector {
  readonly document: OpenApiDocument;

  constructor(version: string) {
    this.document = {
      openapi: '3.1.0',
      info: {
        title: 'BAX Print Suite media library and profiling API',
        version,
        description: API_DESCRIPTION,
        license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
      },
      paths: {},
      components: { schemas: { ...COMPONENT_SCHEMAS } },
    };
  }

  add(route: RouteOptions): void {
    const schema = route.schema as unknown as Partial<RouteDoc> | undefined;
    if (!schema?.operationId) return;
    const path = route.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const lower = String(method).toLowerCase();
      if (lower === 'head') continue;
      const entry = (this.document.paths[path] ??= {});
      entry[lower] = operation(schema as RouteDoc, route.url, routePermission(lower, route.url));
    }
  }
}
