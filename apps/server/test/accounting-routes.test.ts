import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor, DeviceAccountingReport, Job } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import type { AccountingReport } from '../src/accounting-routes.js';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { fakeClock, sequentialIds } from './helpers.js';

const CREATED_AT = '2026-03-01T08:00:00.000Z';
const NOW = '2026-03-05T08:00:00.000Z';
const FROM = '2026-03-01T00:00:00Z';
const TO = '2026-03-03T00:00:00Z';
const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };

interface Fixture {
  readonly app: FastifyInstance;
  readonly jobs: MemoryJobRepository;
  readonly first: Job;
  readonly second: Job;
}

function createArchive(jobs: MemoryJobRepository): ArchiveService {
  const time = fakeClock(NOW);
  const outbox = new MemoryOutbox();
  const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
  return new ArchiveService({
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
}

async function createJob(service: JobService, name: string): Promise<Job> {
  return service.create({
    name,
    sources: [{ name: `${name}.pdf`, bytes: new Uint8Array([1, 2, 3]) }],
    ticket: { intent: { quantity: 1 }, process: {} },
  });
}

function accountingUrl(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}/accounting-id`;
}

function reportUrl(query: Record<string, string>): string {
  return `/reports/accounting?${new URLSearchParams(query).toString()}`;
}

describe('accounting ID routes (Spec 017d)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Two jobs; `reports` lists the device accounting reports; media is mounted so `/openapi.json` is served. */
  async function createFixture(
    options: { reports?: (fixture: Pick<Fixture, 'first' | 'second'>) => readonly DeviceAccountingReport[]; viewer?: boolean } = {},
  ): Promise<Fixture> {
    const jobs = new MemoryJobRepository();
    const created = fakeClock(CREATED_AT);
    const bus = new EventBus(new MemoryOutbox(), { clock: created.clock, newId: sequentialIds('evt') });
    const service = new JobService({ jobs, blobs: new MemoryStorage(), bus, clock: created.clock, newId: sequentialIds('job') });
    const first = await createJob(service, 'first');
    const second = await createJob(service, 'second');
    const time = fakeClock(NOW);
    const media = new MediaService({ stores: memoryMediaStores(), bus, jobs: new MemoryJobRepository(), clock: time.clock, newId: sequentialIds('m') });
    const { reports } = options;
    const server = buildServer({
      archive: createArchive(jobs),
      media,
      accounting: {
        jobs,
        clock: time.clock,
        ...(reports ? { reports: { list: async () => reports({ first, second }) } } : {}),
      },
      ...(options.viewer ? { authenticate: () => VIEWER } : {}),
    });
    app = server;
    return { app: server, jobs, first, second };
  }

  it('sets a trimmed accounting ID on the job ticket and stores it', async () => {
    const { app: server, jobs, first } = await createFixture();

    const response = await server.inject({ method: 'PUT', url: accountingUrl(first.id), payload: { accountingId: '  CC-100/a  ' } });

    expect(response.statusCode).toBe(200);
    const { job } = response.json<{ job: Job }>();
    expect(job.id).toBe(first.id);
    expect(job.ticket).toEqual({ ...first.ticket, accountingId: 'CC-100/a' });
    expect(job.updatedAt).toBe(NOW);
    expect((await jobs.get(first.id))?.ticket.accountingId).toBe('CC-100/a');
  });

  it('clears the accounting ID with null', async () => {
    const { app: server, jobs, first } = await createFixture();
    await server.inject({ method: 'PUT', url: accountingUrl(first.id), payload: { accountingId: 'CC-100' } });

    const response = await server.inject({ method: 'PUT', url: accountingUrl(first.id), payload: { accountingId: null } });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ job: Job }>().job.ticket).not.toHaveProperty('accountingId');
    expect((await jobs.get(first.id))?.ticket).toEqual(first.ticket);
  });

  it.each<[string, unknown]>([
    ['an empty string', { accountingId: '' }],
    ['only spaces', { accountingId: '   ' }],
    ['a value longer than 64 characters', { accountingId: 'a'.repeat(65) }],
    ['a character outside the allowed set', { accountingId: 'CC#100' }],
    ['a number', { accountingId: 100 }],
    ['a missing accountingId', {}],
    ['a body that is not an object', ['CC-100']],
  ])('answers 422 accounting_id_invalid for %s and keeps the job', async (_name, payload) => {
    const { app: server, jobs, first } = await createFixture();

    const response = await server.inject({ method: 'PUT', url: accountingUrl(first.id), payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: { code: 'accounting_id_invalid', message: expect.any(String), details: { field: 'accountingId' } },
    });
    expect(await jobs.get(first.id)).toEqual(first);
  });

  it('answers 404 for an unknown job', async () => {
    const { app: server } = await createFixture();

    const response = await server.inject({ method: 'PUT', url: accountingUrl('no-such-job'), payload: { accountingId: 'CC-100' } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'job no-such-job not found' } });
  });

  it('answers 403 to a viewer setting an accounting ID and keeps the job', async () => {
    const { app: server, jobs, first } = await createFixture({ viewer: true });

    const response = await server.inject({ method: 'PUT', url: accountingUrl(first.id), payload: { accountingId: 'CC-100' } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:write' } } });
    expect(await jobs.get(first.id)).toEqual(first);
  });

  it('groups the reports in the window by job accounting ID, null last', async () => {
    const { app: server, first, second } = await createFixture({
      reports: (jobs) => [
        {
          jobId: jobs.first.id,
          deviceId: 'device-1',
          reportedAt: '2026-03-01T10:00:00Z',
          quantities: [
            { kind: 'ink', name: 'cyan', value: 1.5, unit: 'ml' },
            { kind: 'media', name: 'roll', value: 2, unit: 'm2' },
          ],
        },
        { jobId: jobs.first.id, deviceId: 'device-2', reportedAt: '2026-03-02T10:00:00Z', quantities: [{ kind: 'ink', name: 'cyan', value: 2.5, unit: 'ml' }] },
        { jobId: jobs.second.id, deviceId: 'device-1', reportedAt: '2026-03-02T11:00:00Z', quantities: [{ kind: 'ink', name: 'cyan', value: 4, unit: 'ml' }] },
        { jobId: 'job-elsewhere', deviceId: 'device-1', reportedAt: '2026-03-02T12:00:00Z', quantities: [{ kind: 'other', name: 'time', value: 30, unit: 's' }] },
        // Outside [from, to): reported exactly at `to`.
        { jobId: jobs.first.id, deviceId: 'device-1', reportedAt: TO, quantities: [{ kind: 'ink', name: 'cyan', value: 100, unit: 'ml' }] },
      ],
    });
    await server.inject({ method: 'PUT', url: accountingUrl(first.id), payload: { accountingId: 'CC-100' } });

    const response = await server.inject({ method: 'GET', url: reportUrl({ from: FROM, to: TO }) });

    expect(response.statusCode).toBe(200);
    expect(response.json<AccountingReport>()).toEqual({
      from: FROM,
      to: TO,
      groups: [
        {
          accountingId: 'CC-100',
          jobIds: [first.id],
          quantities: [
            { kind: 'ink', name: 'cyan', value: 4, unit: 'ml' },
            { kind: 'media', name: 'roll', value: 2, unit: 'm2' },
          ],
        },
        {
          accountingId: null,
          jobIds: [second.id, 'job-elsewhere'],
          quantities: [
            { kind: 'ink', name: 'cyan', value: 4, unit: 'ml' },
            { kind: 'other', name: 'time', value: 30, unit: 's' },
          ],
        },
      ],
    });
  });

  it('answers 422 report_range_invalid for a bad window', async () => {
    const { app: server } = await createFixture({ reports: () => [] });

    const response = await server.inject({ method: 'GET', url: reportUrl({ from: TO, to: FROM }) });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: { code: 'report_range_invalid', message: expect.any(String) } });
  });

  it('does not mount the report without a report source', async () => {
    const { app: server } = await createFixture();

    const response = await server.inject({ method: 'GET', url: reportUrl({ from: FROM, to: TO }) });

    expect(response.statusCode).toBe(404);
  });

  it('documents both routes in /openapi.json', async () => {
    const { app: server } = await createFixture({ reports: () => [] });

    const document = (await server.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { operationId?: string; requestBody?: unknown; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();

    const put = document.paths['/jobs/{id}/accounting-id']?.put;
    expect(put?.operationId).toBe('setJobAccountingId');
    expect(put?.requestBody).toBeDefined();
    expect(Object.keys(put?.responses ?? {})).toEqual(expect.arrayContaining(['200', '403', '404', '422']));
    const get = document.paths['/reports/accounting']?.get;
    expect(get?.operationId).toBe('getAccountingReport');
    expect(Object.keys(get?.responses ?? {})).toEqual(expect.arrayContaining(['200', '403', '422']));
    for (const name of ['AccountingReport', 'AccountingIdGroup', 'AccountingQuantity']) {
      expect(document.components.schemas).toHaveProperty(name);
    }
  });
});
