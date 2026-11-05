import { describe, expect, it } from 'vitest';
import { toProductionRecord, toProductionRecords, type ProductionJob } from '../src/production-records.js';

const CREATED = '2026-03-01T08:00:00.000Z';
const UPDATED = '2026-03-01T09:00:00.000Z';
const DONE = '2026-03-01T08:30:00.000Z';

const job = (overrides: Partial<ProductionJob>): ProductionJob => ({
  id: 'job-1',
  status: 'received',
  createdAt: CREATED,
  updatedAt: UPDATED,
  ...overrides,
});

describe('toProductionRecord (Spec 023b)', () => {
  it('reads a done job: received at creation, finished when done, with customer and device', () => {
    const record = toProductionRecord(job({ status: 'done', doneAt: DONE, customerRef: 'customer-a', deviceId: 'press-1' }));

    expect(record).toEqual({
      jobId: 'job-1',
      status: 'done',
      receivedAt: CREATED,
      finishedAt: DONE,
      customer: 'customer-a',
      deviceId: 'press-1',
    });
  });

  it('falls back to the last update for a done job without doneAt', () => {
    expect(toProductionRecord(job({ status: 'done' })).finishedAt).toBe(UPDATED);
  });

  it.each(['failed', 'cancelled'] as const)('finishes a %s job at its last update', (status) => {
    expect(toProductionRecord(job({ status }))).toEqual({ jobId: 'job-1', status, receivedAt: CREATED, finishedAt: UPDATED });
  });

  it.each(['received', 'queued', 'processing', 'printed'] as const)('leaves a %s job unfinished, without optional fields', (status) => {
    const record = toProductionRecord(job({ status, doneAt: DONE }));

    expect(record).toEqual({ jobId: 'job-1', status, receivedAt: CREATED });
    expect(Object.keys(record)).toEqual(['jobId', 'status', 'receivedAt']);
  });

  it('maps every job in order', () => {
    expect(toProductionRecords([job({ id: 'a' }), job({ id: 'b' })]).map((record) => record.jobId)).toEqual(['a', 'b']);
    expect(toProductionRecords([])).toEqual([]);
  });
});
