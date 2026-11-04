import { describe, expect, it } from 'vitest';
import { TICKET } from './helpers.js';
import { createMediaHarness, type MediaHarness } from './media-helpers.js';

async function presetWithPublishedRevision(h: MediaHarness): Promise<string> {
  await h.app.inject({ method: 'POST', url: '/media', payload: { id: 'vinyl-gloss', name: 'Gloss vinyl' } });
  await h.app.inject({ method: 'POST', url: '/presets', payload: { id: 'gloss-std', name: 'Gloss', mediumId: 'vinyl-gloss', colorSetupId: 'cs-1' } });
  const revision = (await h.app.inject({ method: 'POST', url: '/color-setups/cs-1/revisions', payload: { settings: { inkLimit: 280 } } })).json();
  await h.app.inject({ method: 'POST', url: `/color-setups/cs-1/revisions/${revision.id}/publish` });
  return revision.id as string;
}

async function jobWithPreset(h: MediaHarness): Promise<string> {
  const job = await h.jobs.create({
    name: 'banner',
    presetId: 'gloss-std',
    mediumId: 'vinyl-gloss',
    sources: [{ name: 'banner.pdf', bytes: Buffer.from('%PDF-1.7 banner') }],
    ticket: TICKET,
  });
  return job.id;
}

describe('integration 4: a rendered job keeps its color setup revision', () => {
  it('stores the published revision at render and ignores later publishes', async () => {
    const h = createMediaHarness();
    const firstRevision = await presetWithPublishedRevision(h);
    const jobId = await jobWithPreset(h);
    expect((await h.repository.get(jobId))?.colorSetupRevisionId).toBeUndefined();

    const rendered = await h.media.pinColorSetupForRender(jobId);
    expect(rendered.colorSetupRevisionId).toBe(firstRevision);
    expect((await h.repository.get(jobId))?.colorSetupRevisionId).toBe(firstRevision);

    h.time.advance(60_000);
    const next = (await h.app.inject({ method: 'POST', url: '/color-setups/cs-1/revisions', payload: { settings: { inkLimit: 250 } } })).json();
    const published = await h.app.inject({ method: 'POST', url: `/color-setups/cs-1/revisions/${next.id}/publish` });
    expect(published.json()).toMatchObject({ id: next.id, status: 'published' });

    expect((await h.repository.get(jobId))?.colorSetupRevisionId).toBe(firstRevision);
    const rerendered = await h.media.pinColorSetupForRender(jobId);
    expect(rerendered.colorSetupRevisionId).toBe(firstRevision);

    const newJob = await h.media.pinColorSetupForRender(await jobWithPreset(h));
    expect(newJob.colorSetupRevisionId).toBe(next.id);
  });

  it('refuses to render when the preset has no published revision', async () => {
    const h = createMediaHarness();
    await h.app.inject({ method: 'POST', url: '/media', payload: { id: 'vinyl-gloss', name: 'Gloss vinyl' } });
    await h.app.inject({ method: 'POST', url: '/presets', payload: { id: 'gloss-std', name: 'Gloss', mediumId: 'vinyl-gloss', colorSetupId: 'cs-1' } });
    const jobId = await jobWithPreset(h);
    await expect(h.media.pinColorSetupForRender(jobId)).rejects.toMatchObject({ statusCode: 409, code: 'conflict' });
  });
});
