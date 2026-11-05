import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { ProductionReport } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import type { ProductionJob } from '../src/production-records.js';
import { fakeClock, sequentialIds } from './helpers.js';

const NOW = '2026-03-05T08:00:00.000Z';
const FROM = '2026-03-01T00:00:00Z';
const TO = '2026-03-03T00:00:00Z';
const TWO_HOURS_MS = 7_200_000;
const ONE_DAY_MS = 86_400_000;

/** Two jobs done in the window (2 h and 24 h), one failed, one still printing and one done before the window. */
const JOBS: readonly ProductionJob[] = [
  {
    id: 'job-1',
    status: 'done',
    createdAt: '2026-03-01T08:00:00.000Z',
    updatedAt: '2026-03-01T10:00:00.000Z',
    doneAt: '2026-03-01T10:00:00.000Z',
    customerRef: 'customer-a',
    deviceId: 'press-1',
  },
  {
    id: 'job-2',
    status: 'done',
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-02T09:00:00.000Z',
    doneAt: '2026-03-02T09:00:00.000Z',
    customerRef: 'customer-b',
    deviceId: 'press-1',
  },
  {
    id: 'job-3',
    status: 'failed',
    createdAt: '2026-03-02T12:00:00.000Z',
    updatedAt: '2026-03-02T13:00:00.000Z',
    customerRef: 'customer-a',
  },
  {
    id: 'job-4',
    status: 'processing',
    createdAt: '2026-03-02T15:00:00.000Z',
    updatedAt: '2026-03-02T15:30:00.000Z',
    customerRef: 'customer-b',
  },
  {
    id: 'job-5',
    status: 'done',
    createdAt: '2026-02-20T08:00:00.000Z',
    updatedAt: '2026-02-21T08:00:00.000Z',
    doneAt: '2026-02-21T08:00:00.000Z',
    customerRef: 'customer-a',
  },
];

/** Median and p90 of [2 h, 24 h] by linear interpolation. */
const MEDIAN_MS = 46_800_000;
const P90_MS = 78_480_000;

const TOTALS = {
  jobsReceived: 4,
  jobsCompleted: 2,
  jobsFailedOrCancelled: 1,
  medianTurnaroundMs: MEDIAN_MS,
  p90TurnaroundMs: P90_MS,
};

function reportUrl(query: Record<string, string>): string {
  return `/reports/production?${new URLSearchParams(query).toString()}`;
}

function createArchive(): ArchiveService {
  const time = fakeClock(NOW);
  const outbox = new MemoryOutbox();
  const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
  return new ArchiveService({
    jobs: new MemoryJobRepository(),
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

describe('GET /reports/production (Spec 023b)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** A server whose job repository lists `jobs`; media is mounted so `/openapi.json` is served. */
  function createApp(jobs: readonly ProductionJob[] = JOBS): FastifyInstance {
    const time = fakeClock(NOW);
    const bus = new EventBus(new MemoryOutbox(), { clock: time.clock, newId: sequentialIds('evt') });
    const media = new MediaService({
      stores: memoryMediaStores(),
      bus,
      jobs: new MemoryJobRepository(),
      clock: time.clock,
      newId: sequentialIds('m'),
    });
    return buildServer({ archive: createArchive(), media, productionReport: { jobs: { list: async () => jobs } } });
  }

  it('answers the core report as JSON, grouped by customer', async () => {
    app = createApp();

    const response = await app.inject({ method: 'GET', url: reportUrl({ from: FROM, to: TO, groupBy: 'customer' }) });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json<ProductionReport>()).toEqual({
      from: FROM,
      to: TO,
      groups: [
        {
          key: 'customer-a',
          jobsReceived: 2,
          jobsCompleted: 1,
          jobsFailedOrCancelled: 1,
          medianTurnaroundMs: TWO_HOURS_MS,
          p90TurnaroundMs: TWO_HOURS_MS,
        },
        {
          key: 'customer-b',
          jobsReceived: 2,
          jobsCompleted: 1,
          jobsFailedOrCancelled: 0,
          medianTurnaroundMs: ONE_DAY_MS,
          p90TurnaroundMs: ONE_DAY_MS,
        },
      ],
      totals: TOTALS,
    });
  });

  it('answers JSON ungrouped when groupBy and format are left out', async () => {
    app = createApp();

    const response = await app.inject({ method: 'GET', url: reportUrl({ from: FROM, to: TO }) });

    expect(response.statusCode).toBe(200);
    expect(response.json<ProductionReport>()).toEqual({ from: FROM, to: TO, groups: [{ key: 'all', ...TOTALS }], totals: TOTALS });
  });

  it('answers CSV with a download filename for format=csv', async () => {
    app = createApp();

    const response = await app.inject({ method: 'GET', url: reportUrl({ from: FROM, to: TO, groupBy: 'none', format: 'csv' }) });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="production-report_2026-03-01T00-00-00Z_2026-03-03T00-00-00Z.csv"',
    );
    expect(response.body).toBe(
      [
        'group,jobs_received,jobs_completed,jobs_failed_or_cancelled,median_turnaround_ms,p90_turnaround_ms',
        `all,4,2,1,${MEDIAN_MS},${P90_MS}`,
        `total,4,2,1,${MEDIAN_MS},${P90_MS}`,
        '',
      ].join('\r\n'),
    );
  });

  it('answers an empty report for a range without jobs, as JSON and as CSV', async () => {
    app = createApp();
    const query = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };

    const json = await app.inject({ method: 'GET', url: reportUrl(query) });
    const csv = await app.inject({ method: 'GET', url: reportUrl({ ...query, format: 'csv' }) });

    expect(json.statusCode).toBe(200);
    expect(json.json()).toEqual({
      ...query,
      groups: [],
      totals: { jobsReceived: 0, jobsCompleted: 0, jobsFailedOrCancelled: 0, medianTurnaroundMs: null, p90TurnaroundMs: null },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toBe(
      'group,jobs_received,jobs_completed,jobs_failed_or_cancelled,median_turnaround_ms,p90_turnaround_ms\r\ntotal,0,0,0,,\r\n',
    );
  });

  it('answers an empty report when there are no jobs at all', async () => {
    app = createApp([]);

    const response = await app.inject({ method: 'GET', url: reportUrl({ from: FROM, to: TO, groupBy: 'day' }) });

    expect(response.statusCode).toBe(200);
    expect(response.json<ProductionReport>().groups).toEqual([]);
  });

  it.each<[string, Record<string, string>]>([
    ['a missing from', { to: TO }],
    ['a missing to', { from: FROM }],
    ['no range at all', {}],
    ['a from that is not a date-time', { from: 'yesterday', to: TO }],
    ['a to with an offset instead of Z', { from: FROM, to: '2026-03-03T00:00:00+01:00' }],
    ['an impossible calendar date', { from: '2026-02-30T00:00:00Z', to: TO }],
    ['from equal to to', { from: FROM, to: FROM }],
    ['from later than to', { from: TO, to: FROM }],
  ])('answers 422 report_range_invalid for %s', async (_name, query) => {
    app = createApp();

    const response = await app.inject({ method: 'GET', url: reportUrl(query) });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: { code: 'report_range_invalid', message: expect.any(String) } });
  });

  it('answers 422 report_range_invalid for a repeated from', async () => {
    app = createApp();

    const response = await app.inject({ method: 'GET', url: `/reports/production?from=${FROM}&from=${FROM}&to=${TO}` });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'report_range_invalid' } });
  });

  it('answers 422 report_group_by_invalid for an unknown groupBy', async () => {
    app = createApp();

    const response = await app.inject({ method: 'GET', url: reportUrl({ from: FROM, to: TO, groupBy: 'week' }) });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: { code: 'report_group_by_invalid', message: 'groupBy must be one of day, device, customer, none' },
    });
  });

  it('answers 422 report_format_invalid for an unknown format', async () => {
    app = createApp();

    const response = await app.inject({ method: 'GET', url: reportUrl({ from: FROM, to: TO, format: 'xml' }) });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: { code: 'report_format_invalid', message: 'format must be one of json, csv' } });
  });

  it('keeps the core 400 for a stored job that cannot be reported', async () => {
    app = createApp([
      { id: 'job-x', status: 'done', createdAt: '2026-03-02T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z', doneAt: '2026-03-01T00:00:00.000Z' },
    ]);

    const response = await app.inject({ method: 'GET', url: reportUrl({ from: FROM, to: TO }) });

    expect(response.statusCode).toBe(400);
    const { error } = response.json<{ error: { code: string; message: string } }>();
    expect(error.code).not.toMatch(/^report_/);
    expect(error.message).toBe('production report: records[0].finishedAt is earlier than receivedAt');
  });

  it('is not mounted without a job source', async () => {
    app = buildServer({ archive: createArchive() });

    const response = await app.inject({ method: 'GET', url: reportUrl({ from: FROM, to: TO }) });

    expect(response.statusCode).toBe(404);
  });

  it('documents the query, both media types and the errors in /openapi.json', async () => {
    app = createApp();

    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<
        string,
        Record<string, { operationId?: string; parameters?: { name: string; required: boolean }[]; responses?: Record<string, { content?: Record<string, unknown> }> }>
      >;
      components: { schemas: Record<string, unknown> };
    }>();

    const operation = document.paths['/reports/production']?.get;
    expect(operation?.operationId).toBe('getProductionReport');
    expect(operation?.parameters).toEqual([
      expect.objectContaining({ name: 'from', required: true }),
      expect.objectContaining({ name: 'to', required: true }),
      expect.objectContaining({ name: 'groupBy', required: false }),
      expect.objectContaining({ name: 'format', required: false }),
    ]);
    expect(Object.keys(operation?.responses?.['200']?.content ?? {})).toEqual(['application/json', 'text/csv']);
    expect(operation?.responses?.['200']?.content?.['application/json']).toEqual({ schema: { $ref: '#/components/schemas/ProductionReport' } });
    expect(Object.keys(operation?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '422']));
    for (const name of ['ProductionReport', 'ProductionReportGroup', 'ProductionReportTotals']) {
      expect(document.components.schemas).toHaveProperty(name);
    }
  });
});
