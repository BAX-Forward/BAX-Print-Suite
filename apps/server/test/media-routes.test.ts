import { describe, expect, it } from 'vitest';
import { MediaEventTypes } from '../src/events.js';
import { createMediaHarness } from './media-helpers.js';

const GLOSS = { id: 'vinyl-gloss', name: 'Gloss vinyl', attributes: { widthMm: 1370 } };

describe('Spec 005 media library routes', () => {
  it('creates, lists, replaces and deletes media', async () => {
    const { app } = createMediaHarness();

    const created = await app.inject({ method: 'POST', url: '/media', payload: GLOSS });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject(GLOSS);

    expect((await app.inject({ method: 'POST', url: '/media', payload: GLOSS })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/media' })).json()).toHaveLength(1);

    const replaced = await app.inject({ method: 'PUT', url: '/media/vinyl-gloss', payload: { name: 'Gloss vinyl 2' } });
    expect(replaced.json()).toMatchObject({ id: 'vinyl-gloss', name: 'Gloss vinyl 2', attributes: {} });

    expect((await app.inject({ method: 'DELETE', url: '/media/vinyl-gloss' })).statusCode).toBe(204);
    const missing = await app.inject({ method: 'GET', url: '/media/vinyl-gloss' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'not_found', message: 'Medium vinyl-gloss not found' } });
  });

  it('rejects an invalid body with the error envelope', async () => {
    const { app } = createMediaHarness();
    const response = await app.inject({ method: 'POST', url: '/media', payload: { attributes: {} } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('syncs media and publishes media.synced', async () => {
    const h = createMediaHarness();
    await h.app.inject({ method: 'POST', url: '/media', payload: GLOSS });

    const response = await h.app.inject({
      method: 'POST',
      url: '/media/sync',
      payload: {
        source: 'device-1',
        media: [GLOSS, { id: 'vinyl-matte', name: 'Matte vinyl' }],
      },
    });
    expect(response.statusCode).toBe(200);
    const result = { source: 'device-1', created: ['vinyl-matte'], updated: [], unchanged: ['vinyl-gloss'] };
    expect(response.json()).toEqual(result);
    expect(h.published(MediaEventTypes.mediaSynced)).toEqual([
      expect.objectContaining({ type: 'media.synced', subject: 'device-1', data: result }),
    ]);
  });

  it('adds and lists output modes on a medium', async () => {
    const { app } = createMediaHarness();
    await app.inject({ method: 'POST', url: '/media', payload: GLOSS });

    const mode = await app.inject({ method: 'POST', url: '/media/vinyl-gloss/modes', payload: { id: 'quality', name: 'Quality', settings: { passes: 8 } } });
    expect(mode.statusCode).toBe(201);
    const modes = await app.inject({ method: 'GET', url: '/media/vinyl-gloss/modes' });
    expect(modes.json()).toEqual([{ id: 'quality', mediumId: 'vinyl-gloss', name: 'Quality', settings: { passes: 8 } }]);
    expect((await app.inject({ method: 'GET', url: '/media/unknown/modes' })).statusCode).toBe(404);
  });

  it('refuses to delete a medium a preset uses', async () => {
    const { app } = createMediaHarness();
    await app.inject({ method: 'POST', url: '/media', payload: GLOSS });
    await app.inject({ method: 'POST', url: '/presets', payload: { id: 'p1', name: 'Gloss', mediumId: 'vinyl-gloss', colorSetupId: 'cs-1' } });
    const response = await app.inject({ method: 'DELETE', url: '/media/vinyl-gloss' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'conflict' } });
  });
});

describe('Spec 005 color setup revision routes', () => {
  it('publishes drafts in turn and supersedes the previous revision', async () => {
    const h = createMediaHarness();
    const first = (await h.app.inject({ method: 'POST', url: '/color-setups/cs-1/revisions', payload: { settings: { inkLimit: 280 } } })).json();
    const second = (await h.app.inject({ method: 'POST', url: '/color-setups/cs-1/revisions', payload: { settings: { inkLimit: 260 } } })).json();
    expect([first.number, second.number, first.status]).toEqual([1, 2, 'draft']);

    const publishFirst = await h.app.inject({ method: 'POST', url: `/color-setups/cs-1/revisions/${first.id}/publish` });
    expect(publishFirst.json()).toMatchObject({ id: first.id, status: 'published' });
    await h.app.inject({ method: 'POST', url: `/color-setups/cs-1/revisions/${second.id}/publish` });

    const revisions = (await h.app.inject({ method: 'GET', url: '/color-setups/cs-1/revisions' })).json();
    expect(revisions.map((r: { status: string }) => r.status)).toEqual(['superseded', 'published']);

    const again = await h.app.inject({ method: 'POST', url: `/color-setups/cs-1/revisions/${first.id}/publish` });
    expect(again.statusCode).toBe(409);
    expect((await h.app.inject({ method: 'POST', url: '/color-setups/cs-1/revisions/nope/publish' })).statusCode).toBe(404);

    expect(h.published(MediaEventTypes.colorSetupPublished).map((event) => event.data)).toEqual([
      { colorSetupId: 'cs-1', revisionId: first.id, number: 1 },
      { colorSetupId: 'cs-1', revisionId: second.id, number: 2, supersedes: first.id },
    ]);
  });
});

describe('Spec 005 preset routes', () => {
  it('validates the medium and output mode a preset names', async () => {
    const { app } = createMediaHarness();
    const unknown = await app.inject({ method: 'POST', url: '/presets', payload: { name: 'X', mediumId: 'none', colorSetupId: 'cs-1' } });
    expect(unknown.statusCode).toBe(400);

    await app.inject({ method: 'POST', url: '/media', payload: GLOSS });
    const badMode = await app.inject({ method: 'POST', url: '/presets', payload: { name: 'X', mediumId: 'vinyl-gloss', outputModeId: 'none', colorSetupId: 'cs-1' } });
    expect(badMode.statusCode).toBe(400);

    const created = await app.inject({ method: 'POST', url: '/presets', payload: { id: 'p1', name: 'Gloss', mediumId: 'vinyl-gloss', colorSetupId: 'cs-1' } });
    expect(created.statusCode).toBe(201);
    const replaced = await app.inject({ method: 'PUT', url: '/presets/p1', payload: { name: 'Gloss 2', mediumId: 'vinyl-gloss', colorSetupId: 'cs-2' } });
    expect(replaced.json()).toEqual({ id: 'p1', name: 'Gloss 2', mediumId: 'vinyl-gloss', colorSetupId: 'cs-2' });
    expect((await app.inject({ method: 'GET', url: '/presets' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: '/presets/p1' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/presets/p1' })).statusCode).toBe(404);
  });
});

describe('Spec 005 profiling session routes', () => {
  it('completes steps in order and publishes profiling.step.completed', async () => {
    const h = createMediaHarness();
    await h.app.inject({ method: 'POST', url: '/media', payload: GLOSS });
    const session = (
      await h.app.inject({ method: 'POST', url: '/profiling-sessions', payload: { mediumId: 'vinyl-gloss', colorSetupId: 'cs-1', steps: ['print', 'measure'] } })
    ).json();
    expect(session).toMatchObject({ status: 'open', steps: [{ id: 'print', status: 'pending' }, { id: 'measure', status: 'pending' }] });

    const outOfOrder = await h.app.inject({ method: 'POST', url: `/profiling-sessions/${session.id}/steps/measure/complete` });
    expect(outOfOrder.statusCode).toBe(409);

    await h.app.inject({ method: 'POST', url: `/profiling-sessions/${session.id}/steps/print/complete` });
    const done = await h.app.inject({ method: 'POST', url: `/profiling-sessions/${session.id}/steps/measure/complete`, payload: { result: { patches: 4 } } });
    expect(done.json()).toMatchObject({ status: 'completed', steps: [{ status: 'completed' }, { status: 'completed', result: { patches: 4 } }] });
    expect((await h.app.inject({ method: 'GET', url: `/profiling-sessions/${session.id}` })).json().status).toBe('completed');

    expect(h.published(MediaEventTypes.profilingStepCompleted).map((event) => event.data)).toEqual([
      { sessionId: session.id, stepId: 'print', index: 0, sessionCompleted: false },
      { sessionId: session.id, stepId: 'measure', index: 1, sessionCompleted: true },
    ]);
  });
});

describe('OpenAPI document', () => {
  it('documents every Spec 005 route from the validation schemas', async () => {
    const { app } = createMediaHarness();
    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.license.identifier).toBe('Apache-2.0');
    expect(Object.keys(document.paths).sort()).toEqual([
      '/color-setups/{id}/revisions',
      '/color-setups/{id}/revisions/{revisionId}/publish',
      '/media',
      '/media/sync',
      '/media/{id}',
      '/media/{id}/modes',
      '/presets',
      '/presets/{id}',
      '/profiling-sessions',
      '/profiling-sessions/{id}',
      '/profiling-sessions/{id}/steps/{stepId}/complete',
    ]);
    expect(document.paths['/media'].post.requestBody.content['application/json'].schema.required).toEqual(['name']);
    expect(document.paths['/media/{id}'].get.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } }]);
  });
});
