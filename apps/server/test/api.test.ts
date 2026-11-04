import { beforeEach, describe, expect, it } from 'vitest';
import { IMPORTED_FROM_KEY, unpack } from '@bax-print/archive';
import type { ColorSetupRevision, Job } from '@bax-print/core';
import { packageKey } from '@bax-print/store';
import { createServerHarness, DEVICE_A, finishedJob, MEDIUM_GLOSS, MEDIUM_MATTE, ROLE_HEADER, type ServerHarness } from './helpers.js';

const REV_GLOSS = 'rev-gloss-1';
const REV_MATTE = 'rev-matte-1';

function revision(id: string, mediumId: string): ColorSetupRevision {
  return {
    id,
    colorSetupId: `setup-${DEVICE_A}-${mediumId}`,
    deviceId: DEVICE_A,
    mediumId,
    createdAt: '2026-01-05T09:00:00.000Z',
    profiles: [],
  };
}

const as = (role: string) => ({ [ROLE_HEADER]: role });

async function archivedJob(h: ServerHarness, name = 'Shop window', tags = ['spring']): Promise<string> {
  const id = await finishedJob(h, {
    name,
    customerRef: 'C-1001',
    deviceId: DEVICE_A,
    mediumId: MEDIUM_GLOSS,
    colorSetupRevisionId: REV_GLOSS,
    tags,
  });
  const response = await h.app.inject({ method: 'POST', url: `/jobs/${id}/archive` });
  expect(response.statusCode).toBe(200);
  return id;
}

function newHarness(): ServerHarness {
  const h = createServerHarness();
  h.colorSetups.addRevision(revision(REV_GLOSS, MEDIUM_GLOSS)).addRevision(revision(REV_MATTE, MEDIUM_MATTE));
  return h;
}

describe('archive routes', () => {
  let h: ServerHarness;
  beforeEach(() => {
    h = newHarness();
  });

  it('POST /jobs/:id/archive stores a package and an index row', async () => {
    const id = await finishedJob(h, { name: 'Shop window', deviceId: DEVICE_A, mediumId: MEDIUM_GLOSS, colorSetupRevisionId: REV_GLOSS });
    const response = await h.app.inject({ method: 'POST', url: `/jobs/${id}/archive` });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ job: Job }>().job).toMatchObject({ id, lifecycle: 'archived' });
    expect(await h.packages.stat(packageKey(id))).not.toBeNull();
    expect(await h.index.get(id)).toMatchObject({ jobId: id, name: 'Shop window' });
  });

  it('GET /archive searches with query-string filters and cursor paging', async () => {
    const first = await archivedJob(h, 'Spring window', ['spring', 'window']);
    const second = await archivedJob(h, 'Spring banner', ['spring']);
    await archivedJob(h, 'Menu board', ['menu']);

    const filtered = await h.app.inject({ method: 'GET', url: '/archive?customer=C-1001&tags=spring' });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json<{ items: { jobId: string }[] }>().items.map((row) => row.jobId).sort()).toEqual([first, second].sort());

    const page = await h.app.inject({ method: 'GET', url: '/archive?q=spring&limit=1' });
    const body = page.json<{ items: { jobId: string }[]; nextCursor?: string }>();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeTypeOf('string');
    const next = await h.app.inject({ method: 'GET', url: `/archive?q=spring&limit=1&cursor=${body.nextCursor}` });
    const nextBody = next.json<{ items: { jobId: string }[]; nextCursor?: string }>();
    expect([...body.items, ...nextBody.items].map((row) => row.jobId).sort()).toEqual([first, second].sort());
    expect(nextBody.nextCursor).toBeUndefined();
  });

  it('GET /archive rejects invalid parameters and cursors with 400', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/archive?limit=0' })).json()).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
    const badCursor = await h.app.inject({ method: 'GET', url: '/archive?cursor=garbage' });
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json()).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
  });

  it('GET /archive/:id and /archive/:id/package return the row and a valid package', async () => {
    const id = await archivedJob(h);
    const row = await h.app.inject({ method: 'GET', url: `/archive/${id}` });
    expect(row.json()).toMatchObject({ jobId: id, customerRef: 'C-1001', deviceId: DEVICE_A, mediumId: MEDIUM_GLOSS });

    const download = await h.app.inject({ method: 'GET', url: `/archive/${id}/package` });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${id}.bpsjob"`);
    expect(unpack(download.rawPayload).manifest.jobId).toBe(id);
  });

  it('POST /archive/:id/restore brings the job back to the active list', async () => {
    const id = await archivedJob(h);
    const response = await h.app.inject({ method: 'POST', url: `/archive/${id}/restore` });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ job: Job }>().job.lifecycle).toBe('active');
    expect(await h.index.get(id)).toBeUndefined();
  });

  it('answers 404 for unknown jobs and 409 for jobs still in production', async () => {
    const missing = await h.app.inject({ method: 'POST', url: '/jobs/job-9999/archive' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'JOB_NOT_FOUND' } });
    expect((await h.app.inject({ method: 'GET', url: '/archive/job-9999' })).statusCode).toBe(404);

    const job = await h.jobs.create({ name: 'Busy', sources: [{ name: 'a.pdf', bytes: Buffer.from('%PDF') }], ticket: { intent: { quantity: 1 }, process: {} } });
    const busy = await h.app.inject({ method: 'POST', url: `/jobs/${job.id}/archive` });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: 'INVALID_LIFECYCLE' } });
  });

  it('refuses viewers with 403', async () => {
    const id = await finishedJob(h, { name: 'Shop window' });
    const response = await h.app.inject({ method: 'POST', url: `/jobs/${id}/archive`, headers: as('viewer') });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});

describe('reprint route', () => {
  let h: ServerHarness;
  let id: string;
  beforeEach(async () => {
    h = newHarness();
    id = await archivedJob(h);
  });

  it('creates a linked job with the original revision on the same device and medium', async () => {
    const response = await h.app.inject({ method: 'POST', url: `/archive/${id}/reprint`, payload: { copies: 5 } });
    expect(response.statusCode).toBe(201);
    const { job, warnings } = response.json<{ job: Job; warnings: string[] }>();
    expect(job).toMatchObject({ reprintOf: id, colorSetupRevisionId: REV_GLOSS, mediumId: MEDIUM_GLOSS, lifecycle: 'active' });
    expect(job.id).not.toBe(id);
    expect(job.ticket.intent.quantity).toBe(5);
    expect(warnings).toEqual([]);
  });

  it('works without a body', async () => {
    const response = await h.app.inject({ method: 'POST', url: `/archive/${id}/reprint` });
    expect(response.statusCode).toBe(201);
  });

  it('asks for a setup with 422 when the medium differs, then records the change', async () => {
    const missing = await h.app.inject({ method: 'POST', url: `/archive/${id}/reprint`, payload: { mediumId: MEDIUM_MATTE } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ error: { code: 'COLOR_SETUP_REQUIRED' } });

    const mismatch = await h.app.inject({
      method: 'POST',
      url: `/archive/${id}/reprint`,
      payload: { mediumId: MEDIUM_MATTE, colorSetupRevisionId: REV_GLOSS },
    });
    expect(mismatch.json()).toMatchObject({ error: { code: 'COLOR_SETUP_MISMATCH' } });

    const picked = await h.app.inject({
      method: 'POST',
      url: `/archive/${id}/reprint`,
      payload: { mediumId: MEDIUM_MATTE, colorSetupRevisionId: REV_MATTE },
    });
    expect(picked.statusCode).toBe(201);
    const { job, warnings } = picked.json<{ job: Job; warnings: string[] }>();
    expect(job).toMatchObject({ mediumId: MEDIUM_MATTE, colorSetupRevisionId: REV_MATTE });
    expect(warnings).toHaveLength(1);
    expect(h.outbox.list({ jobId: job.id, types: ['reprint.setup.changed'] })).toHaveLength(1);
  });

  it('validates the body with 400', async () => {
    for (const payload of [{ copies: 'two' }, { copies: 1.5 }, { useCurrentHead: 'yes' }, { mediumId: '' }, [1]]) {
      const response = await h.app.inject({ method: 'POST', url: `/archive/${id}/reprint`, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const zeroCopies = await h.app.inject({ method: 'POST', url: `/archive/${id}/reprint`, payload: { copies: 0 } });
    expect(zeroCopies.statusCode).toBe(400);
    expect(zeroCopies.json()).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
  });
});

describe('import route', () => {
  let source: ServerHarness;
  let target: ServerHarness;
  let bytes: Buffer;
  beforeEach(async () => {
    source = newHarness();
    target = newHarness();
    const id = await archivedJob(source);
    bytes = (await source.app.inject({ method: 'GET', url: `/archive/${id}/package` })).rawPayload;
  });

  const post = (h: ServerHarness, payload: Buffer, query = '') =>
    h.app.inject({
      method: 'POST',
      url: `/archive/import${query}`,
      payload,
      headers: { 'content-type': 'application/octet-stream' },
    });

  it('imports a package from another installation as a new archived job', async () => {
    const response = await post(target, bytes);
    expect(response.statusCode).toBe(201);
    const { job } = response.json<{ job: Job }>();
    expect(job).toMatchObject({ lifecycle: 'archived', deviceId: DEVICE_A, mediumId: MEDIUM_GLOSS, colorSetupRevisionId: REV_GLOSS });
    expect(job.metadata[IMPORTED_FROM_KEY]).toBe('job-0001');
    expect(await target.index.get(job.id)).toMatchObject({ jobId: job.id });
  });

  it('remaps media from query parameters and drops the color setup that no longer applies', async () => {
    const response = await post(target, bytes, `?medium.${MEDIUM_GLOSS}=${MEDIUM_MATTE}`);
    expect(response.statusCode).toBe(201);
    const { job, warnings } = response.json<{ job: Job; warnings: string[] }>();
    expect(job.mediumId).toBe(MEDIUM_MATTE);
    expect(job.colorSetupRevisionId).toBeUndefined();
    expect(warnings.some((w) => w.includes(REV_GLOSS))).toBe(true);
  });

  it('rejects a tampered package with 422 and a non-binary body with 400', async () => {
    const tampered = Buffer.from(bytes);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    const bad = await post(target, tampered);
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: { code: 'PACKAGE_INTEGRITY' } });

    const json = await target.app.inject({ method: 'POST', url: '/archive/import', payload: { not: 'a package' } });
    expect(json.statusCode).toBe(400);
    expect(await target.repository.list({})).toEqual([]);
  });
});

describe('trash and legal hold routes', () => {
  let h: ServerHarness;
  let id: string;
  beforeEach(async () => {
    h = newHarness();
    id = await archivedJob(h);
  });

  it('DELETE moves a job to the trash, GET /trash lists it, and restore puts it back', async () => {
    const deleted = await h.app.inject({ method: 'DELETE', url: `/archive/${id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<{ job: Job }>().job.lifecycle).toBe('trashed');

    const trash = await h.app.inject({ method: 'GET', url: '/trash' });
    expect(trash.json<{ items: Job[] }>().items.map((job) => job.id)).toEqual([id]);

    const restored = await h.app.inject({ method: 'POST', url: `/trash/${id}/restore` });
    expect(restored.json<{ job: Job }>().job.lifecycle).toBe('archived');
    expect(await h.index.get(id)).toMatchObject({ jobId: id });
  });

  it('DELETE /jobs/:id trashes an active finished job', async () => {
    const active = await finishedJob(h, { name: 'Active' });
    const response = await h.app.inject({ method: 'DELETE', url: `/jobs/${active}` });
    expect(response.json<{ job: Job }>().job).toMatchObject({ id: active, lifecycle: 'trashed' });
  });

  it('a legal hold blocks deletion until an admin removes it', async () => {
    const hold = await h.app.inject({ method: 'PUT', url: `/jobs/${id}/legal-hold`, payload: { hold: true }, headers: as('operator') });
    expect(hold.json<{ job: Job }>().job.legalHold).toBe(true);

    const blocked = await h.app.inject({ method: 'DELETE', url: `/archive/${id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: 'LEGAL_HOLD' } });

    const byOperator = await h.app.inject({ method: 'PUT', url: `/jobs/${id}/legal-hold`, payload: { hold: false }, headers: as('operator') });
    expect(byOperator.statusCode).toBe(403);

    const byAdmin = await h.app.inject({ method: 'PUT', url: `/jobs/${id}/legal-hold`, payload: { hold: false }, headers: as('admin') });
    expect(byAdmin.json<{ job: Job }>().job.legalHold).toBe(false);
    expect((await h.app.inject({ method: 'DELETE', url: `/archive/${id}` })).statusCode).toBe(200);
  });

  it('validates the legal-hold body', async () => {
    const response = await h.app.inject({ method: 'PUT', url: `/jobs/${id}/legal-hold`, payload: { hold: 'yes' } });
    expect(response.statusCode).toBe(400);
  });
});

describe('XJDF export route', () => {
  it('returns the ticket as XML', async () => {
    const h = newHarness();
    const id = await archivedJob(h);
    const response = await h.app.inject({ method: 'GET', url: `/jobs/${id}/xjdf` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(response.body).toContain('<XJDF');
  });
});
