/* eslint-disable no-restricted-globals -- contract tests exercise the raw HTTP API, not the client. */
import Ajv2020 from 'ajv/dist/2020';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockDb } from '../mock/db';
import { DEVICE_IDS, fixtureId, HOT_FOLDER_IDS, PLUGIN_IDS } from '../mock/fixtures';
import openapi from '../mock/openapi.json';
import { JOB_SORTS, JOB_STATUSES, type CloudEvent, type Device, type HotFolder, type Job, type JobPage, type Plugin, type Problem, type Transitions } from '../src/api/types';
import { BASE_URL, installMockServer, useMockDb } from './helpers';

/**
 * Contract tests for the mock API against mock/openapi.json (Spec 002 acceptance 2): every
 * operation is called, every documented status code is produced, and every JSON body validates
 * against the schema documented for that status and content type.
 */

interface MediaType {
  schema?: unknown;
}
interface ResponseObject {
  $ref?: string;
  content?: Record<string, MediaType>;
}
interface Operation {
  operationId: string;
  responses: Record<string, ResponseObject>;
}
interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
  components: { responses: Record<string, ResponseObject>; schemas: Record<string, unknown> };
}

const doc = openapi as unknown as OpenApiDoc;
const DOC_ID = 'https://bps.invalid/openapi.json';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
/** Documented responses the mock cannot produce. */
const NOT_PRODUCIBLE = new Set([
  // The preview image needs a RenderEngine (M5); until then the reserved contract answers 501.
  'getJobPreview 200',
]);

/** Points schema references at the component schemas registered under DOC_ID. */
function rewriteRefs<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replaceAll('"#/components/schemas/', `"${DOC_ID}#/$defs/`)) as T;
}

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ $id: DOC_ID, $defs: rewriteRefs(doc.components.schemas) });

function expectSchema(name: string, value: unknown): void {
  const validate = ajv.compile({ $ref: `${DOC_ID}#/$defs/${name}` });
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

function operation(path: string, method: string): Operation {
  const op = doc.paths[path]?.[method] as Operation | undefined;
  if (!op) throw new Error(`${method.toUpperCase()} ${path} is not in openapi.json`);
  return op;
}

const exercised = new Set<string>();

/**
 * Checks status, content type and body against the documented response. Returns the parsed body
 * for JSON responses; other bodies are left unread for the caller.
 */
async function expectContract(response: Response, path: string, method: string, status: number): Promise<unknown> {
  const op = operation(path, method);
  expect(response.status, `${op.operationId}`).toBe(status);
  let documented = op.responses[String(status)];
  expect(documented, `${op.operationId} documents ${status}`).toBeDefined();
  if (documented.$ref) {
    const name = documented.$ref.split('/').pop() ?? '';
    documented = doc.components.responses[name];
  }
  exercised.add(`${op.operationId} ${status}`);

  if (!documented.content) {
    expect(await response.text()).toBe('');
    return undefined;
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  const media = documented.content[contentType];
  expect(media, `${op.operationId} ${status} documents ${contentType}`).toBeDefined();
  if (!contentType.includes('json')) return undefined;

  const body: unknown = await response.json();
  const validate = ajv.compile(rewriteRefs(media.schema as object));
  expect(validate(body), `${op.operationId} ${status}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return body;
}

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function fieldsOf(problem: unknown): string[] {
  return ((problem as Problem).errors ?? []).map((error) => error.field);
}

const READY_JOB = fixtureId(7); // brochure-a4-3pages, 3 pages
const HELD_JOB = fixtureId(10);
const DONE_JOB = fixtureId(1);
const MISSING = 'does-not-exist';

installMockServer();
let db: MockDb;
beforeEach(() => {
  db = useMockDb();
});

describe('shared enums', () => {
  it('JOB_STATUSES and JOB_SORTS mirror openapi.json', () => {
    const schemas = doc.components.schemas as Record<string, { enum: string[] }>;
    expect([...JOB_STATUSES]).toEqual(schemas.JobStatus.enum);
    expect([...JOB_SORTS]).toEqual(schemas.JobSort.enum);
  });
});

describe('GET /health and /openapi.json', () => {
  it('reports health', async () => {
    await expectContract(await call('GET', '/health'), '/health', 'get', 200);
  });

  it('serves the document the mock implements', async () => {
    expect(await expectContract(await call('GET', '/openapi.json'), '/openapi.json', 'get', 200)).toEqual(openapi);
  });
});

describe('GET /jobs', () => {
  const list = async (query: string) =>
    (await expectContract(await call('GET', `/jobs${query}`), '/jobs', 'get', 200)) as JobPage;

  it('lists all fixture jobs newest first by default', async () => {
    const page = await list('');
    expect(page.items).toHaveLength(14);
    expect(page.items[0].id).toBe(fixtureId(14));
    expect(page.nextCursor).toBeNull();
  });

  it('filters by repeated status parameters', async () => {
    const page = await list('?status=failed&status=cancelled');
    expect(page.items).toHaveLength(3);
    expect(page.items.every((job) => job.status === 'failed' || job.status === 'cancelled')).toBe(true);
  });

  it('filters by name (case-insensitive), hot folder and device', async () => {
    const byName = await list('?q=BANNER');
    expect(byName.items.map((job) => job.name).sort()).toEqual(['banner-3000x1000-sale', 'mesh-banner-fence']);

    const scoped = await list(`?hotFolderId=${HOT_FOLDER_IDS.banners}&deviceId=${DEVICE_IDS.rollA}`);
    expect(scoped.items.length).toBeGreaterThan(0);
    expect(scoped.items.every((job) => job.hotFolderId === HOT_FOLDER_IDS.banners && job.deviceId === DEVICE_IDS.rollA)).toBe(true);
  });

  it('sorts by priority and name', async () => {
    const priorities = (await list('?sort=-priority')).items.map((job) => job.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    const names = (await list('?sort=name')).items.map((job) => job.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
  });

  it('pages with an opaque cursor until nextCursor is null', async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: JobPage = await list(`?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      ids.push(...page.items.map((job) => job.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(ids).size).toBe(14);
  });

  it('rejects invalid query parameters with 400', async () => {
    for (const query of ['?sort=size', '?limit=0', '?status=lost', '?cursor=not-a-cursor']) {
      const problem = await expectContract(await call('GET', `/jobs${query}`), '/jobs', 'get', 400);
      expect(fieldsOf(problem).length).toBeGreaterThan(0);
    }
  });
});

describe('GET/PATCH /jobs/:id', () => {
  it('returns a job or 404', async () => {
    const job = (await expectContract(await call('GET', `/jobs/${READY_JOB}`), '/jobs/{id}', 'get', 200)) as Job;
    expect(job.pages).toHaveLength(3);
    await expectContract(await call('GET', `/jobs/${MISSING}`), '/jobs/{id}', 'get', 404);
  });

  it('changes priority and status', async () => {
    const path = `/jobs/${READY_JOB}`;
    const updated = (await expectContract(await call('PATCH', path, { priority: 90, status: 'held' }), '/jobs/{id}', 'patch', 200)) as Job;
    expect(updated).toMatchObject({ priority: 90, status: 'held' });
    expect(updated.audit?.map((entry) => entry.type)).toEqual(expect.arrayContaining(['priority.changed', 'status.changed']));
  });

  it('validates the patch body with 400', async () => {
    for (const body of [{ priority: 101 }, { priority: 1.5 }, {}, { name: 'renamed' }, { status: 'lost' }]) {
      await expectContract(await call('PATCH', `/jobs/${READY_JOB}`, body), '/jobs/{id}', 'patch', 400);
    }
  });

  it('rejects transitions the state machine forbids with 409', async () => {
    await expectContract(await call('PATCH', `/jobs/${DONE_JOB}`, { status: 'queued' }), '/jobs/{id}', 'patch', 409);
    await expectContract(await call('PATCH', `/jobs/${MISSING}`, { priority: 1 }), '/jobs/{id}', 'patch', 404);
  });
});

describe('GET /jobs/:id/transitions', () => {
  it('lists what the current status allows', async () => {
    const held = (await expectContract(await call('GET', `/jobs/${HELD_JOB}/transitions`), '/jobs/{id}/transitions', 'get', 200)) as Transitions;
    expect(held.status).toBe('held');
    expect(held.allowed).toContain('queued');
    expect(held.allowed).not.toContain('held');

    const done = (await expectContract(await call('GET', `/jobs/${DONE_JOB}/transitions`), '/jobs/{id}/transitions', 'get', 200)) as Transitions;
    expect(done.allowed).toEqual([]);

    await expectContract(await call('GET', `/jobs/${MISSING}/transitions`), '/jobs/{id}/transitions', 'get', 404);
  });
});

describe('GET /jobs/:id/file', () => {
  it('streams the stored PDF inline', async () => {
    const response = await call('GET', `/jobs/${READY_JOB}/file`);
    await expectContract(response, '/jobs/{id}/file', 'get', 200);
    expect(response.headers.get('content-disposition')).toMatch(/^inline;/);
    const text = new TextDecoder().decode(await response.arrayBuffer());
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toContain('/Count 3');
    await expectContract(await call('GET', `/jobs/${MISSING}/file`), '/jobs/{id}/file', 'get', 404);
  });
});

describe('GET /jobs/:id/preview (reserved)', () => {
  it('answers 501 no-render-engine for valid requests', async () => {
    const body = await expectContract(await call('GET', `/jobs/${READY_JOB}/preview?page=3&w=320`), '/jobs/{id}/preview', 'get', 501);
    expect(body).toEqual({ reason: 'no-render-engine' });
  });

  it('validates parameters and the job', async () => {
    for (const query of ['?page=0', '?page=4', '?w=5000']) {
      await expectContract(await call('GET', `/jobs/${READY_JOB}/preview${query}`), '/jobs/{id}/preview', 'get', 400);
    }
    await expectContract(await call('GET', `/jobs/${MISSING}/preview`), '/jobs/{id}/preview', 'get', 404);
  });
});

describe('POST /jobs/:id/print', () => {
  it('accepts the job and delivers it to the device target folder', async () => {
    const accepted = (await expectContract(
      await call('POST', `/jobs/${READY_JOB}/print`, { deviceId: DEVICE_IDS.rollA }),
      '/jobs/{id}/print',
      'post',
      202,
    )) as Job;
    expect(accepted).toMatchObject({ status: 'processing', deviceId: DEVICE_IDS.rollA });

    await vi.waitFor(() => expect(db.getJob(READY_JOB).status).toBe('sent_to_device'));
    const delivered = (await expectContract(await call('GET', `/jobs/${READY_JOB}`), '/jobs/{id}', 'get', 200)) as Job;
    const output = delivered.steps.find((step) => step.stage === 'output');
    expect(output?.status).toBe('completed');
    expect(output?.result?.deliveredPath).toBe(`/srv/rip/in/roll-a/brochure-a4-3pages_${READY_JOB}.pdf`);
    expect(delivered.audit?.some((entry) => entry.type === 'delivery')).toBe(true);
  });

  it('validates the device, the job state and the job', async () => {
    for (const body of [{}, { deviceId: 'dev-missing' }]) {
      await expectContract(await call('POST', `/jobs/${READY_JOB}/print`, body), '/jobs/{id}/print', 'post', 400);
    }
    await expectContract(await call('POST', `/jobs/${DONE_JOB}/print`, { deviceId: DEVICE_IDS.rollA }), '/jobs/{id}/print', 'post', 409);
    await expectContract(await call('POST', `/jobs/${MISSING}/print`, { deviceId: DEVICE_IDS.rollA }), '/jobs/{id}/print', 'post', 404);
  });
});

describe('/hotfolders', () => {
  it('lists hot folders', async () => {
    const folders = (await expectContract(await call('GET', '/hotfolders'), '/hotfolders', 'get', 200)) as HotFolder[];
    expect(folders.map((folder) => folder.id)).toEqual(Object.values(HOT_FOLDER_IDS));
  });

  it('adds POSIX and Windows paths with defaults', async () => {
    const posix = (await expectContract(
      await call('POST', '/hotfolders', { path: '/srv/print/hot/new/', settings: { defaultPriority: 70 } }),
      '/hotfolders',
      'post',
      201,
    )) as HotFolder;
    expect(posix).toMatchObject({ name: 'new', path: '/srv/print/hot/new', enabled: true });
    expect(posix.settings).toMatchObject({ defaultPriority: 70, filePatterns: ['*.pdf'], dedupe: true });

    await expectContract(await call('POST', '/hotfolders', { path: 'D:\\Hot\\Wraps', name: 'Wraps' }), '/hotfolders', 'post', 201);
  });

  it('reports path problems as field errors', async () => {
    for (const path of ['relative/folder', '/srv/print/hot/../etc', '/srv/print/hot/banners', '']) {
      const problem = await expectContract(await call('POST', '/hotfolders', { path }), '/hotfolders', 'post', 400);
      expect(fieldsOf(problem)).toContain('path');
    }
    const problem = await expectContract(
      await call('POST', '/hotfolders', { path: '/srv/print/hot/x', settings: { filePatterns: [] } }),
      '/hotfolders',
      'post',
      400,
    );
    expect(fieldsOf(problem)).toContain('settings.filePatterns');
  });

  it('disables a folder, which stops ingestion', async () => {
    const path = `/hotfolders/${HOT_FOLDER_IDS.posters}`;
    const folder = (await expectContract(await call('PATCH', path, { enabled: false }), '/hotfolders/{id}', 'patch', 200)) as HotFolder;
    expect(folder.enabled).toBe(false);
    expect(db.ingest({ hotFolderId: HOT_FOLDER_IDS.posters })).toBeNull();

    await expectContract(await call('PATCH', path, { settings: { defaultPriority: 500 } }), '/hotfolders/{id}', 'patch', 400);
    await expectContract(await call('PATCH', `/hotfolders/${MISSING}`, { enabled: true }), '/hotfolders/{id}', 'patch', 404);
  });

  it('removes a folder with 204 and keeps its jobs', async () => {
    const path = `/hotfolders/${HOT_FOLDER_IDS.archive}`;
    await expectContract(await call('DELETE', path), '/hotfolders/{id}', 'delete', 204);
    await expectContract(await call('DELETE', path), '/hotfolders/{id}', 'delete', 404);
    const folders = (await expectContract(await call('GET', '/hotfolders'), '/hotfolders', 'get', 200)) as HotFolder[];
    expect(folders.some((folder) => folder.id === HOT_FOLDER_IDS.archive)).toBe(false);
  });
});

describe('GET /plugins', () => {
  it('lists the handoff driver with document capability and config schema', async () => {
    const plugins = (await expectContract(await call('GET', '/plugins'), '/plugins', 'get', 200)) as Plugin[];
    const handoff = plugins.find((plugin) => plugin.id === PLUGIN_IDS.handoff);
    expect(handoff?.capabilities).toMatchObject({ accepts: ['document'], documentTypes: ['application/pdf'] });
    expect(handoff?.configSchema).toMatchObject({ required: ['targetDir'] });
  });
});

describe('/devices', () => {
  it('lists devices', async () => {
    const devices = (await expectContract(await call('GET', '/devices'), '/devices', 'get', 200)) as Device[];
    expect(devices.map((device) => device.id)).toEqual([DEVICE_IDS.rollA]);
  });

  it('adds a handoff device and applies the schema defaults', async () => {
    const device = (await expectContract(
      await call('POST', '/devices', { name: 'Roll B', kind: 'printer', pluginId: PLUGIN_IDS.handoff, config: { targetDir: '/srv/rip/in/b' } }),
      '/devices',
      'post',
      201,
    )) as Device;
    expect(device.config).toEqual({
      targetDir: '/srv/rip/in/b',
      fileNamePattern: '{jobName}_{jobId}.pdf',
      conflict: 'suffix',
      writeTicketSidecar: false,
      verifyAfterCopy: true,
    });
    expect(device).toMatchObject({ autoDispatch: false, maxConcurrency: 1, status: { state: 'ready' } });
  });

  it('validates the driver and its config with field errors', async () => {
    const cases: [unknown, string][] = [
      [{ name: 'B', kind: 'printer', pluginId: PLUGIN_IDS.handoff }, 'config.targetDir'],
      [{ name: 'B', kind: 'printer', pluginId: PLUGIN_IDS.handoff, config: { targetDir: 'relative' } }, 'config.targetDir'],
      [{ name: 'B', kind: 'printer', pluginId: PLUGIN_IDS.handoff, config: { targetDir: '/x', conflict: 'merge' } }, 'config.conflict'],
      [{ name: 'B', kind: 'printer', pluginId: PLUGIN_IDS.inspector }, 'pluginId'],
      [{ name: ' ', kind: 'printer', pluginId: PLUGIN_IDS.mock }, 'name'],
    ];
    for (const [body, field] of cases) {
      const problem = await expectContract(await call('POST', '/devices', body), '/devices', 'post', 400);
      expect(fieldsOf(problem)).toContain(field);
    }
  });

  it('updates config, re-probes status and emits device.status', async () => {
    const seen: CloudEvent[] = [];
    db.events.subscribe((event) => seen.push(event));
    const path = `/devices/${DEVICE_IDS.rollA}`;
    const device = (await expectContract(
      await call('PATCH', path, { config: { targetDir: '/srv/rip/readonly/a' } }),
      '/devices/{id}',
      'patch',
      200,
    )) as Device;
    expect(device.status.state).toBe('offline');
    expect(seen.map((event) => event.type)).toContain('device.status');

    await expectContract(await call('PATCH', path, { maxConcurrency: 0 }), '/devices/{id}', 'patch', 400);
    await expectContract(await call('PATCH', `/devices/${MISSING}`, { autoDispatch: true }), '/devices/{id}', 'patch', 404);
  });
});

describe('GET /events', () => {
  it('streams CloudEvents with the SSE event name set to the type', async () => {
    const response = await call('GET', '/events');
    await expectContract(response, '/events', 'get', 200);
    const stream = response.body;
    if (!stream) throw new Error('No event stream body');
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const frameFor = (type: string) => text.split('\n\n').slice(0, -1).find((frame) => frame.includes(`event: ${type}`));
    const readUntil = async (done: () => boolean) => {
      while (!done()) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Event stream ended early');
        text += decoder.decode(chunk.value, { stream: true });
      }
    };

    await readUntil(() => text.includes(': connected'));
    db.patchJob(HELD_JOB, { status: 'queued' });
    await readUntil(() => frameFor('job.status.changed') !== undefined);
    // MSW keeps an unread clone (a tee branch) of every mocked response, and cancelling one tee
    // branch only settles once both are cancelled, so this promise never resolves; don't await it.
    void reader.cancel();

    const dataLine = frameFor('job.status.changed')?.split('\n').find((line) => line.startsWith('data: ')) ?? '';
    const event = JSON.parse(dataLine.slice('data: '.length)) as CloudEvent;
    expectSchema('CloudEvent', event);
    expectSchema('JobStatusChangedData', event.data);
    expect(event.data).toMatchObject({ jobId: HELD_JOB, from: 'held', to: 'queued' });
  });
});

describe('coverage', () => {
  it('exercised every operation and documented status code', () => {
    const documented: string[] = [];
    for (const item of Object.values(doc.paths)) {
      for (const method of HTTP_METHODS) {
        const op = item[method] as Operation | undefined;
        if (!op) continue;
        for (const status of Object.keys(op.responses)) documented.push(`${op.operationId} ${status}`);
      }
    }
    const missing = documented.filter((key) => !exercised.has(key) && !NOT_PRODUCIBLE.has(key));
    expect(missing).toEqual([]);
  });
});
