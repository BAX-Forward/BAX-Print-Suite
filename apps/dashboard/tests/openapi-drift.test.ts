import { describe, expect, it } from 'vitest';
import mockOpenapi from '../mock/openapi.json';
import serverOpenapi from './fixtures/server-052a-openapi.json';

/**
 * Drift guard (Spec 052b-rework): the job routes and schemas the dashboard reads from the real 052a
 * server must be structural copies of the server's own document, captured in
 * tests/fixtures/server-052a-openapi.json. When this fails, copy the server's definitions into
 * mock/openapi.json and run `pnpm --filter dashboard gen:api`.
 */

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
}

const mockDoc: OpenApiDoc = mockOpenapi;
const serverDoc: OpenApiDoc = serverOpenapi;

const SHARED_SCHEMAS = ['Job', 'JobPage', 'JobEnvelope', 'Error'];
const SHARED_OPERATIONS: [path: string, method: string][] = [
  ['/jobs', 'get'],
  ['/jobs', 'post'],
  ['/jobs/{id}', 'get'],
];
const SCHEMA_REF = /"#\/components\/schemas\/([^"]+)"/g;

/** Names of the component schemas a definition refers to. */
function schemaRefs(value: unknown): string[] {
  return [...JSON.stringify(value).matchAll(SCHEMA_REF)].map((match) => match[1] ?? '');
}

describe('mock/openapi.json matches the 052a server', () => {
  it.each(SHARED_SCHEMAS)('schema %s is identical', (name) => {
    const server = serverDoc.components.schemas[name];
    expect(server, `the server documents ${name}`).toBeDefined();
    expect(mockDoc.components.schemas[name]).toEqual(server);
  });

  it.each(SHARED_OPERATIONS)('operation %s %s is identical', (path, method) => {
    const server = serverDoc.paths[path]?.[method];
    expect(server, `the server documents ${method} ${path}`).toBeDefined();
    expect(mockDoc.paths[path]?.[method]).toEqual(server);
  });

  it('the shared operations and schemas refer only to schemas that are compared', () => {
    const definitions = [
      ...SHARED_SCHEMAS.map((name) => mockDoc.components.schemas[name]),
      ...SHARED_OPERATIONS.map(([path, method]) => mockDoc.paths[path]?.[method]),
    ];
    const refs = new Set(definitions.flatMap(schemaRefs));
    expect([...refs].filter((name) => !SHARED_SCHEMAS.includes(name))).toEqual([]);
  });
});
