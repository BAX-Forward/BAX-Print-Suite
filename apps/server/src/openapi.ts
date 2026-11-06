import type { FastifySchema, RouteOptions } from 'fastify';
import { FINISHING_STEP_KINDS, PERMISSIONS, type Permission } from '@bax-print/core';
import { routePermission } from './route-permissions.js';

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

/** `POST /jobs/:id/step-repeat` (Spec 003u): the roll layout, one trim contour per copy and the imposed PDF. */
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
    cutContours: { type: 'array', items: CUT_CONTOUR_SCHEMA },
    warnings: { type: 'array', items: { type: 'object' } },
    imposedPdfBase64: { type: 'string', contentEncoding: 'base64', contentMediaType: 'application/pdf' },
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

function operation(route: RouteDoc, permission?: Permission): Record<string, unknown> {
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
  for (const [status, description] of Object.entries(withForbidden(route.responses, permission))) {
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
  'Without a configured actor resolver every caller is treated as the local admin, which holds every permission.',
  'The server binds 127.0.0.1 by default; do not expose it beyond loopback without a resolver.',
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
      entry[lower] = operation(schema as RouteDoc, routePermission(lower, route.url));
    }
  }
}
