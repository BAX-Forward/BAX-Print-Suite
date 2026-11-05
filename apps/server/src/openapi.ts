import type { FastifySchema, RouteOptions } from 'fastify';

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
  body?: JsonSchema;
  /** Media types of a raw (non-JSON) request body. */
  consumes?: string[];
  /** Media type of a raw (non-JSON) response body. */
  produces?: string;
  /** Status code → description. Defaults to `200: OK`. */
  responses?: Record<string, string>;
  /** Name of the `components.schemas` entry that describes the JSON success body. */
  responseSchema?: string;
}

/** Passes a RouteDoc to Fastify as a route schema; Fastify ignores the documentation keys. */
export function doc(route: RouteDoc): FastifySchema {
  return route as unknown as FastifySchema;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; license: { name: string; identifier: string } };
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

function operation(route: RouteDoc): Record<string, unknown> {
  const op: Record<string, unknown> = {
    operationId: route.operationId,
    summary: route.summary,
    tags: route.tags,
  };
  const params = [...parameters(route.params, 'path'), ...parameters(route.querystring, 'query')];
  if (params.length > 0) op.parameters = params;
  if (route.body) {
    op.requestBody = { required: true, content: { 'application/json': { schema: route.body } } };
  } else if (route.consumes) {
    op.requestBody = {
      required: true,
      content: Object.fromEntries(route.consumes.map((type) => [type, { schema: { type: 'string', format: 'binary' } }])),
    };
  }
  const responses: Record<string, unknown> = {};
  for (const [status, description] of Object.entries(route.responses ?? { 200: 'OK' })) {
    const ok = Number(status) < 300 && Number(status) !== 204;
    if (!ok) {
      responses[status] = { description };
    } else if (route.produces) {
      responses[status] = { description, content: { [route.produces]: { schema: { type: 'string', format: 'binary' } } } };
    } else {
      const schema = route.responseSchema ? { $ref: `#/components/schemas/${route.responseSchema}` } : {};
      responses[status] = { description, content: { 'application/json': { schema } } };
    }
  }
  responses.default = {
    description: 'Error',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
  op.responses = responses;
  return op;
}

/** Collects documented routes through Fastify's `onRoute` hook. */
export class OpenApiCollector {
  readonly document: OpenApiDocument;

  constructor(version: string) {
    this.document = {
      openapi: '3.1.0',
      info: {
        title: 'BAX Print Suite media library and profiling API',
        version,
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
      entry[lower] = operation(schema as RouteDoc);
    }
  }
}
