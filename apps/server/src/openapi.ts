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
      responses[status] = { description, content: { 'application/json': { schema: {} } } };
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
      components: { schemas: { Error: ERROR_SCHEMA } },
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
