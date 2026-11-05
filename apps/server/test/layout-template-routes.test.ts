import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import {
  MemoryArchiveIndex,
  MemoryJobRepository,
  MemoryStorage,
  openDatabase,
  SqliteLayoutTemplateRepository,
  type Database,
  type LayoutTemplate,
  type LayoutTemplateSummary,
} from '@bax-print/store';
import { buildServer } from '../src/app.js';
import type { SaveLayoutTemplateBody } from '../src/layout-template-routes.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { fakeClock, sequentialIds } from './helpers.js';

const NOW = '2026-03-01T08:00:00.000Z';

const LAYOUT_JSON = JSON.stringify({ placements: [{ itemId: 'art', xPt: 0, yPt: 0, rotated: false }], algorithm: 'step-repeat' });

const BODY: SaveLayoutTemplateBody = { name: 'Banner', rollWidthMm: 1370, layoutJson: LAYOUT_JSON };

interface InjectResponse {
  readonly statusCode: number;
  readonly body: string;
  json<T = unknown>(): T;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly db: Database;
}

describe('/layout-templates routes (Spec 003x)', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.app.close();
    h?.db.close();
    h = undefined;
  });

  /** A server over an in-memory job database, wired as `main.ts` wires it with `BPS_DATABASE`. */
  function createHarness(): Harness {
    const time = fakeClock(NOW);
    const outbox = new MemoryOutbox();
    const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
    const repository = new MemoryJobRepository();
    const archive = new ArchiveService({
      jobs: repository,
      index: new MemoryArchiveIndex(),
      blobs: new MemoryStorage(),
      archive: new MemoryStorage(),
      bus,
      outbox,
      colorSetups: new StaticColorSetupResolver(),
      clock: time.clock,
      newId: sequentialIds('pkg'),
    });
    const media = new MediaService({ stores: memoryMediaStores(), bus, jobs: repository, clock: time.clock, newId: sequentialIds('m') });
    const db = openDatabase();
    const layoutTemplates = new SqliteLayoutTemplateRepository(db, { now: () => new Date(NOW) });
    return { app: buildServer({ archive, media, layoutTemplates }), db };
  }

  function save(harness: Harness, body: object = BODY): Promise<InjectResponse> {
    return harness.app.inject({ method: 'POST', url: '/layout-templates', payload: body });
  }

  function rename(harness: Harness, id: string, name: string): Promise<InjectResponse> {
    return harness.app.inject({ method: 'PATCH', url: `/layout-templates/${encodeURIComponent(id)}`, payload: { name } });
  }

  function getTemplate(harness: Harness, id: string): Promise<InjectResponse> {
    return harness.app.inject({ method: 'GET', url: `/layout-templates/${encodeURIComponent(id)}` });
  }

  async function saved(harness: Harness, body: object = BODY): Promise<LayoutTemplate> {
    const response = await save(harness, body);
    expect(response.statusCode).toBe(201);
    return response.json<LayoutTemplate>();
  }

  it('saves a template and reads it back with its layout document', async () => {
    h = createHarness();

    const template = await saved(h, { ...BODY, name: '  Banner  ' });

    expect(template).toEqual({ id: expect.any(String), name: 'Banner', createdAt: NOW, updatedAt: NOW, rollWidthMm: 1370, layoutJson: LAYOUT_JSON });
    const response = await getTemplate(h, template.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(template);
  });

  it('replaces the template when an existing id is saved again', async () => {
    h = createHarness();
    const first = await saved(h, { ...BODY, id: 'tpl-1' });

    const second = await saved(h, { ...BODY, id: 'tpl-1', name: 'Banner wide', rollWidthMm: 1600 });

    expect(second).toMatchObject({ id: first.id, name: 'Banner wide', rollWidthMm: 1600 });
    const list = (await h.app.inject({ method: 'GET', url: '/layout-templates' })).json<{ items: LayoutTemplateSummary[] }>();
    expect(list.items).toHaveLength(1);
  });

  it('lists summaries by name without layout documents', async () => {
    h = createHarness();
    const sticker = await saved(h, { ...BODY, name: 'Sticker sheet', rollWidthMm: 600 });
    const banner = await saved(h, BODY);

    const response = await h.app.inject({ method: 'GET', url: '/layout-templates' });

    expect(response.statusCode).toBe(200);
    const { items } = response.json<{ items: Record<string, unknown>[] }>();
    expect(items.map((item) => item.id)).toEqual([banner.id, sticker.id]);
    expect(items[0]).toEqual({ id: banner.id, name: 'Banner', createdAt: NOW, updatedAt: NOW, rollWidthMm: 1370 });
    expect(items.every((item) => !('layoutJson' in item))).toBe(true);
  });

  it('lists an empty store as no items', async () => {
    h = createHarness();

    const response = await h.app.inject({ method: 'GET', url: '/layout-templates' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it.each([
    ['name', { ...BODY, name: '   ' }],
    ['name', { ...BODY, name: 'x'.repeat(121) }],
    ['rollWidthMm', { ...BODY, rollWidthMm: 0 }],
    ['layoutJson', { ...BODY, layoutJson: 'not json' }],
    ['layoutJson', { ...BODY, layoutJson: '{"algorithm":"step-repeat"}' }],
    ['id', { ...BODY, id: ' ' }],
  ])('answers 422 layout_template_invalid naming the %s field', async (field, body) => {
    h = createHarness();

    const response = await save(h, body);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: { code: 'layout_template_invalid', message: expect.any(String), details: { field } } });
  });

  it('answers 400 invalid_request when a required field is missing', async () => {
    h = createHarness();

    const response = await save(h, { name: 'Banner', rollWidthMm: 1370 });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_request', message: expect.any(String) } });
  });

  it('answers 409 layout_template_name_exists when another template has the trimmed name', async () => {
    h = createHarness();
    await saved(h);

    const response = await save(h, { ...BODY, name: ' Banner ' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: 'layout_template_name_exists', message: 'a layout template is already named "Banner"', details: { name: 'Banner' } },
    });
  });

  it('answers 404 not_found for an unknown template', async () => {
    h = createHarness();

    const response = await getTemplate(h, 'no-such-template');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Layout template no-such-template not found' } });
  });

  it('renames a template', async () => {
    h = createHarness();
    const template = await saved(h);

    const response = await rename(h, template.id, '  Banner 2  ');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...template, name: 'Banner 2' });
    expect((await getTemplate(h, template.id)).json<LayoutTemplate>().name).toBe('Banner 2');
  });

  it('keeps the name when a template is renamed to its own name', async () => {
    h = createHarness();
    const template = await saved(h);

    const response = await rename(h, template.id, 'Banner');

    expect(response.statusCode).toBe(200);
    expect(response.json<LayoutTemplate>().name).toBe('Banner');
  });

  it('answers 409 layout_template_name_exists when the new name is taken', async () => {
    h = createHarness();
    await saved(h);
    const sticker = await saved(h, { ...BODY, name: 'Sticker sheet' });

    const response = await rename(h, sticker.id, 'Banner');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'layout_template_name_exists', details: { name: 'Banner' } } });
    expect((await getTemplate(h, sticker.id)).json<LayoutTemplate>().name).toBe('Sticker sheet');
  });

  it('answers 422 layout_template_invalid for an empty new name', async () => {
    h = createHarness();
    const template = await saved(h);

    const response = await rename(h, template.id, ' ');

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'layout_template_invalid', details: { field: 'name' } } });
  });

  it('answers 404 not_found when renaming an unknown template, even to a taken name', async () => {
    h = createHarness();
    await saved(h);

    const response = await rename(h, 'no-such-template', 'Banner');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Layout template no-such-template not found' } });
  });

  it('deletes a template, then answers 404 for it', async () => {
    h = createHarness();
    const template = await saved(h);

    const deleted = await h.app.inject({ method: 'DELETE', url: `/layout-templates/${template.id}` });

    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    expect((await getTemplate(h, template.id)).statusCode).toBe(404);
    expect((await rename(h, template.id, 'Banner')).statusCode).toBe(404);
    const again = await h.app.inject({ method: 'DELETE', url: `/layout-templates/${template.id}` });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: { code: 'not_found', message: `Layout template ${template.id} not found` } });
  });

  it('documents every route and error in /openapi.json', async () => {
    h = createHarness();

    const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();

    const collection = document.paths['/layout-templates'];
    const item = document.paths['/layout-templates/{id}'];
    expect(collection?.post?.operationId).toBe('saveLayoutTemplate');
    expect(Object.keys(collection?.post?.responses ?? {})).toEqual(expect.arrayContaining(['201', '400', '409', '422']));
    expect(collection?.get?.operationId).toBe('listLayoutTemplates');
    expect(item?.get?.operationId).toBe('getLayoutTemplate');
    expect(Object.keys(item?.get?.responses ?? {})).toEqual(expect.arrayContaining(['200', '404']));
    expect(item?.patch?.operationId).toBe('renameLayoutTemplate');
    expect(Object.keys(item?.patch?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '404', '409', '422']));
    expect(item?.delete?.operationId).toBe('deleteLayoutTemplate');
    expect(Object.keys(item?.delete?.responses ?? {})).toEqual(expect.arrayContaining(['204', '404']));
    expect(document.components.schemas).toHaveProperty('LayoutTemplate');
    expect(document.components.schemas).toHaveProperty('LayoutTemplateSummaryList');
  });
});
