import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MAX_PAGES, planNUp, type NUpPlan } from '@bax-print/nest';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { IMPOSITION_ENV, parseImpositionFlag } from '../src/imposition-routes.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { scopedActor } from '../src/route-permissions.js';
import { fakeClock, sequentialIds } from './helpers.js';

const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };

/** A role outside `Role`, as a resolver may hand back at runtime; it holds no permissions. */
const GUEST: Actor = Object.assign({}, VIEWER, { id: 'guest-1', role: 'guest' });

/** Two by two cells of 90 x 40 pt on a 200 x 100 pt sheet: 5 pages fill one sheet and one slot of the next. */
const N_UP = { sheet: { width: 200, height: 100 }, cell: { width: 90, height: 40 }, gutter: 10, margin: 5, pageCount: 5 };

const BOOKLET = { pageCount: 8, signaturePages: 8, binding: 'left' };

interface HarnessOptions {
  readonly imposition?: boolean;
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
  const { actor, imposition } = options;
  return buildServer({
    archive,
    media,
    ...(imposition === undefined ? {} : { imposition }),
    ...(actor ? { authenticate: () => actor } : {}),
  });
}

function postRaw(app: FastifyInstance, url: string, payload: string) {
  return app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload });
}

function post(app: FastifyInstance, url: string, payload: unknown) {
  return postRaw(app, url, JSON.stringify(payload));
}

describe('imposition routes (Spec 036b)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each([
    ['without the flag', {}],
    ['with the flag off', { imposition: false }],
  ])('are not mounted %s', async (_name, options) => {
    app = createServer(options);

    const nUp = await post(app, '/imposition/n-up', N_UP);
    const booklet = await post(app, '/imposition/booklet', BOOKLET);

    expect(nUp.statusCode).toBe(404);
    expect(booklet.statusCode).toBe(404);
  });

  it('answers the n-up plan', async () => {
    app = createServer({ imposition: true });

    const response = await post(app, '/imposition/n-up', N_UP);

    expect(response.statusCode).toBe(200);
    const plan = response.json<NUpPlan>();
    expect(plan).toEqual(planNUp(N_UP));
    expect(plan).toMatchObject({ rows: 2, cols: 2, rotation: 0, cellsPerSheet: 4, pageCount: 5, blankCount: 3 });
    expect(plan.placements).toEqual([
      { index: 0, row: 0, col: 0, x: 5, y: 55, width: 90, height: 40, rotation: 0 },
      { index: 1, row: 0, col: 1, x: 105, y: 55, width: 90, height: 40, rotation: 0 },
      { index: 2, row: 1, col: 0, x: 5, y: 5, width: 90, height: 40, rotation: 0 },
      { index: 3, row: 1, col: 1, x: 105, y: 5, width: 90, height: 40, rotation: 0 },
    ]);
    expect(plan.sheets).toEqual([
      { index: 0, pages: [1, 2, 3, 4] },
      { index: 1, pages: [5, 'blank', 'blank', 'blank'] },
    ]);
  });

  it('answers the plan of an 8-page booklet', async () => {
    app = createServer({ imposition: true });

    const response = await post(app, '/imposition/booklet', BOOKLET);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      pageCount: 8,
      paddedPageCount: 8,
      blankCount: 0,
      pagesPerSignature: 8,
      sheetsPerSignature: 2,
      signatureCount: 1,
      binding: 'left',
      sheets: [
        { index: 0, signature: 0, position: 0, front: [8, 1], back: [2, 7], creep: 0 },
        { index: 1, signature: 0, position: 1, front: [6, 3], back: [4, 5], creep: 0 },
      ],
    });
  });

  it('allows a viewer, whose role holds jobs:read', async () => {
    app = createServer({ imposition: true, actor: VIEWER });

    expect((await post(app, '/imposition/n-up', N_UP)).statusCode).toBe(200);
    expect((await post(app, '/imposition/booklet', BOOKLET)).statusCode).toBe(200);
  });

  it.each([
    ['an unmapped role on n-up', GUEST, '/imposition/n-up'],
    ['an API token without jobs:read on booklet', scopedActor(VIEWER, ['reports:read']), '/imposition/booklet'],
  ])('denies %s with 403 forbidden before the body is checked', async (_name, actor, url) => {
    app = createServer({ imposition: true, actor });

    const response = await post(app, url, 'not a plan');

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:read' } } });
  });

  it.each([
    ['n-up zero pages', '/imposition/n-up', { ...N_UP, pageCount: 0 }, 'planNUp: pageCount must be at least 1, got 0'],
    ['booklet zero pages', '/imposition/booklet', { ...BOOKLET, pageCount: 0 }, 'planBooklet: pageCount must be at least 1, got 0'],
    [
      'n-up pages over MAX_PAGES',
      '/imposition/n-up',
      { ...N_UP, pageCount: MAX_PAGES + 1 },
      `planNUp: pageCount must be at most ${MAX_PAGES}, got ${MAX_PAGES + 1}`,
    ],
    [
      'booklet pages over MAX_PAGES',
      '/imposition/booklet',
      { ...BOOKLET, pageCount: MAX_PAGES + 1 },
      `planBooklet: pageCount must be at most ${MAX_PAGES}, got ${MAX_PAGES + 1}`,
    ],
    ['a fractional page count', '/imposition/booklet', { ...BOOKLET, pageCount: 2.5 }, 'planBooklet: pageCount must be an integer, got 2.5'],
    ['a negative gutter', '/imposition/n-up', { ...N_UP, gutter: -1 }, 'planNUp: gutter must not be negative, got -1'],
    ['a negative creep', '/imposition/booklet', { ...BOOKLET, creep: -1 }, 'planBooklet: creep must not be negative, got -1'],
    ['a zero sheet width', '/imposition/n-up', { ...N_UP, sheet: { width: 0, height: 100 } }, 'planNUp: sheet width must be positive, got 0'],
  ])('answers 400 invalid_imposition_input with the planner message for %s', async (_name, url, body, message) => {
    app = createServer({ imposition: true });

    const response = await post(app, url, body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_imposition_input', message } });
  });

  it('answers 400 invalid_imposition_input for cells that do not fit the sheet', async () => {
    app = createServer({ imposition: true });

    const response = await post(app, '/imposition/n-up', { ...N_UP, cell: { width: 300, height: 40 } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_imposition_input', message: expect.stringContaining('do not fit') } });
  });

  it('answers 400 invalid_imposition_input for a number that overflows to Infinity', async () => {
    app = createServer({ imposition: true });

    const response = await postRaw(app, '/imposition/booklet', '{"pageCount":1e400,"signaturePages":8,"binding":"left"}');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'invalid_imposition_input', message: 'planBooklet: pageCount must be an integer, got Infinity' },
    });
  });

  it.each([
    ['a NaN string page count', '/imposition/n-up', { ...N_UP, pageCount: 'NaN' }, ['pageCount: must be a number']],
    ['a numeric string gutter', '/imposition/n-up', { ...N_UP, gutter: '12' }, ['gutter: must be a number']],
    ['an Infinity string page count', '/imposition/booklet', { ...BOOKLET, pageCount: 'Infinity' }, ['pageCount: must be a number']],
    ['a null margin', '/imposition/n-up', { ...N_UP, margin: null }, ['margin: must be a number']],
    ['an unknown n-up field', '/imposition/n-up', { ...N_UP, bleed: 3 }, ['bleed: unknown field']],
    ['an unknown sheet field', '/imposition/n-up', { ...N_UP, sheet: { width: 200, height: 100, depth: 1 } }, ['sheet.depth: unknown field']],
    ['an unknown booklet field', '/imposition/booklet', { ...BOOKLET, cover: true }, ['cover: unknown field']],
    [
      'a missing cell',
      '/imposition/n-up',
      { sheet: N_UP.sheet },
      ['cell: must be an object with the numbers width and height'],
    ],
    [
      'an unknown orientation',
      '/imposition/n-up',
      { ...N_UP, orientation: 'sideways' },
      ['orientation: must be one of "upright", "turned", "auto"'],
    ],
    [
      'a signature of 12 pages',
      '/imposition/booklet',
      { ...BOOKLET, signaturePages: 12 },
      ['signaturePages: must be one of 4, 8, 16, "single"'],
    ],
    ['a missing binding', '/imposition/booklet', { pageCount: 8, signaturePages: 8 }, ['binding: must be one of "left", "right"']],
  ])('answers 400 invalid_request with the issues for %s', async (_name, url, body, details) => {
    app = createServer({ imposition: true });

    const response = await post(app, url, body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request', details } });
  });

  it.each([
    ['a JSON array on n-up', '/imposition/n-up', [N_UP]],
    ['a JSON string on booklet', '/imposition/booklet', 'eight pages'],
  ])('answers 400 invalid_request for %s', async (_name, url, body) => {
    app = createServer({ imposition: true });

    const response = await post(app, url, body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.any(String) } });
  });

  it('answers 400 invalid_request for malformed JSON', async () => {
    app = createServer({ imposition: true });

    const response = await postRaw(app, '/imposition/n-up', '{');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('documents both routes in /openapi.json', async () => {
    app = createServer({ imposition: true });

    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();

    expect(document.paths['/imposition/n-up']?.post?.operationId).toBe('planNUp');
    expect(document.paths['/imposition/booklet']?.post?.operationId).toBe('planBooklet');
    for (const path of ['/imposition/n-up', '/imposition/booklet']) {
      expect(Object.keys(document.paths[path]?.post?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '403']));
    }
    expect(Object.keys(document.components.schemas)).toEqual(expect.arrayContaining(['NUpRequest', 'NUpPlan', 'BookletRequest', 'BookletPlan']));
  });
});

describe('parseImpositionFlag (Spec 036b)', () => {
  it('is off when the variable is absent', () => {
    expect(parseImpositionFlag({})).toBe(false);
  });

  it('is on with 1', () => {
    expect(parseImpositionFlag({ [IMPOSITION_ENV]: '1' })).toBe(true);
  });

  it.each(['', '0', 'true', 'yes', ' 1', '1 '])('stops startup on %j', (value) => {
    expect(() => parseImpositionFlag({ [IMPOSITION_ENV]: value })).toThrow(IMPOSITION_ENV);
  });
});
