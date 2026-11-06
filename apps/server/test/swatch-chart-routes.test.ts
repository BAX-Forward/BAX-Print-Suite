import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { SWATCH_CHART_MAX_COLORS } from '../src/openapi.js';
import { scopedActor } from '../src/route-permissions.js';
import { parseSwatchChartsFlag, SWATCH_CHARTS_ENV } from '../src/swatch-chart-routes.js';
import { fakeClock, sequentialIds } from './helpers.js';

const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };

/** A role outside `Role`, as a resolver may hand back at runtime; it holds no permissions. */
const GUEST: Actor = Object.assign({}, VIEWER, { id: 'guest-1', role: 'guest' });

const LIBRARY = {
  name: 'House spots',
  colors: [
    { name: 'House Red', lab: { L: 48, a: 68, b: 48 }, cmykFallback: [0, 90, 80, 0] },
    { name: 'CutContour', lab: { L: 50, a: 80, b: -60 } },
  ],
};

interface HarnessOptions {
  readonly swatchCharts?: boolean;
  readonly actor?: Actor;
}

/** A server with the media routes, so `GET /openapi.json` is mounted too. */
function createServer(options: HarnessOptions = {}): FastifyInstance {
  const time = fakeClock('2026-03-01T08:00:00.000Z');
  const outbox = new MemoryOutbox();
  const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
  const jobs = new MemoryJobRepository();
  const archive = new ArchiveService({
    jobs,
    index: new MemoryArchiveIndex(),
    blobs: new MemoryStorage(),
    archive: new MemoryStorage(),
    bus,
    outbox,
    colorSetups: new StaticColorSetupResolver(),
    clock: time.clock,
    newId: sequentialIds('pkg'),
  });
  const media = new MediaService({ stores: memoryMediaStores(), bus, jobs, clock: time.clock, newId: sequentialIds('m') });
  const { actor, swatchCharts } = options;
  return buildServer({
    archive,
    media,
    ...(swatchCharts === undefined ? {} : { swatchCharts }),
    ...(actor ? { authenticate: () => actor } : {}),
  });
}

function postChart(app: FastifyInstance, payload: unknown) {
  return app.inject({ method: 'POST', url: '/swatch-charts', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
}

function manyColors(count: number) {
  return Array.from({ length: count }, (_, i) => ({ name: `Spot ${i}`, lab: { L: 50, a: 0, b: 0 } }));
}

describe('POST /swatch-charts (Spec 032b)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each([
    ['without the flag', {}],
    ['with the flag off', { swatchCharts: false }],
  ])('is not mounted %s', async (_name, options) => {
    app = createServer(options);

    const response = await postChart(app, { library: LIBRARY });

    expect(response.statusCode).toBe(404);
  });

  it('answers the swatch chart PDF to the local admin', async () => {
    app = createServer({ swatchCharts: true });

    const response = await postChart(app, { library: LIBRARY, options: { columns: 2, showLabels: false } });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pdf = await PDFDocument.load(response.rawPayload);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('House spots');
  });

  it('allows a viewer, whose role holds jobs:read', async () => {
    app = createServer({ swatchCharts: true, actor: VIEWER });

    const response = await postChart(app, { library: LIBRARY });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['an unmapped role', GUEST],
    ['an API token without jobs:read', scopedActor(VIEWER, ['reports:read'])],
  ])('denies %s with 403 forbidden before the body is checked', async (_name, actor) => {
    app = createServer({ swatchCharts: true, actor });

    const response = await postChart(app, { library: 'not a library' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:read' } } });
  });

  it.each([
    ['a JSON array', [LIBRARY]],
    ['a missing library', { options: {} }],
    ['an unknown field', { library: LIBRARY, extra: true }],
    ['a blank library name', { library: { ...LIBRARY, name: '' } }],
    ['colors that are not an array', { library: { name: 'Lib', colors: {} } }],
    ['a colour name of 128 characters', { library: { name: 'Lib', colors: [{ name: 'x'.repeat(128), lab: { L: 50, a: 0, b: 0 } }] } }],
    ['a colour without Lab', { library: { name: 'Lib', colors: [{ name: 'Red' }] } }],
    ['a Lab value given as text', { library: { name: 'Lib', colors: [{ name: 'Red', lab: { L: '50', a: 0, b: 0 } }] } }],
    ['a CMYK fallback of 3 numbers', { library: { name: 'Lib', colors: [{ name: 'Red', lab: { L: 50, a: 0, b: 0 }, cmykFallback: [0, 0, 0] }] } }],
    ['an L out of range', { library: { name: 'Lib', colors: [{ name: 'Red', lab: { L: 101, a: 0, b: 0 } }] } }],
    ['a CMYK percentage over 100', { library: { name: 'Lib', colors: [{ name: 'Red', lab: { L: 50, a: 0, b: 0 }, cmykFallback: [0, 0, 0, 120] }] } }],
    ['a control character in a colour name', { library: { name: 'Lib', colors: [{ name: 'Red\u0007', lab: { L: 50, a: 0, b: 0 } }] } }],
    ['columns of 0', { library: LIBRARY, options: { columns: 0 } }],
    ['columns that do not fit the page', { library: LIBRARY, options: { columns: 20 } }],
    ['options that are not an object', { library: LIBRARY, options: 'wide' }],
  ])('answers 400 invalid_request for %s', async (_name, body) => {
    app = createServer({ swatchCharts: true });

    const response = await postChart(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.any(String) } });
  });

  it('names the problems in details', async () => {
    app = createServer({ swatchCharts: true });

    const response = await postChart(app, { library: { name: 'Lib', colors: [{ name: '', lab: { L: 50, a: 0, b: 0 } }] }, extra: 1 });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'invalid swatch chart request',
        details: ['extra: unknown field', 'library.colors.0.name: must be a string of 1 to 127 characters'],
      },
    });
  });

  it('answers 400 for malformed JSON', async () => {
    app = createServer({ swatchCharts: true });

    const response = await app.inject({ method: 'POST', url: '/swatch-charts', headers: { 'content-type': 'application/json' }, payload: '{' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it(`answers 400 for more than ${SWATCH_CHART_MAX_COLORS} colors`, async () => {
    app = createServer({ swatchCharts: true });

    const response = await postChart(app, { library: { name: 'Big', colors: manyColors(SWATCH_CHART_MAX_COLORS + 1) } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'invalid swatch chart request',
        details: [`library.colors: at most ${SWATCH_CHART_MAX_COLORS} colors, got ${SWATCH_CHART_MAX_COLORS + 1}`],
      },
    });
  });

  it('documents the route in /openapi.json', async () => {
    app = createServer({ swatchCharts: true });

    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();

    const operation = document.paths['/swatch-charts']?.post;
    expect(operation?.operationId).toBe('renderSwatchChart');
    expect(Object.keys(operation?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '403']));
    expect(document.components.schemas).toHaveProperty('SwatchChartRequest');
  });
});

describe('parseSwatchChartsFlag (Spec 032b)', () => {
  it('is off when the variable is absent', () => {
    expect(parseSwatchChartsFlag({})).toBe(false);
  });

  it('is on with 1', () => {
    expect(parseSwatchChartsFlag({ [SWATCH_CHARTS_ENV]: '1' })).toBe(true);
  });

  it.each(['', '0', 'true', 'yes', ' 1'])('stops startup on %j', (value) => {
    expect(() => parseSwatchChartsFlag({ [SWATCH_CHARTS_ENV]: value })).toThrow(SWATCH_CHARTS_ENV);
  });
});
