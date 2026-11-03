import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidArgumentError } from '@bax-print/core';
import { InvalidCursorError, MAX_PAGE_SIZE, type ArchiveSearchQuery } from '@bax-print/store';
import { parseSearchQuery } from '../src/index.js';
import { createHarness, DEFAULT_TICKET, DEVICE_A, DEVICE_B, MEDIUM_GLOSS, MEDIUM_MATTE, seedJob, type Harness } from './helpers.js';

const ticketOfSize = (widthMm: number, heightMm: number) => ({
  ...DEFAULT_TICKET,
  intent: { ...DEFAULT_TICKET.intent, finishedSize: { widthMm, heightMm } },
});

/** Four archived jobs; ids are ordered so the newest `done` time is not the largest id. */
async function seedArchive(h: Harness): Promise<void> {
  const fixtures = [
    {
      id: 'arc-spring-window',
      name: 'Spring window',
      customerRef: 'C-1001',
      deviceId: DEVICE_A,
      mediumId: MEDIUM_GLOSS,
      ticket: ticketOfSize(200, 100),
      tags: ['window', 'spring'],
      metadata: { order: 'PO-77' },
      doneAt: '2026-03-10T12:00:00.000Z',
    },
    {
      id: 'arc-fleet',
      name: 'Fleet decals',
      customerRef: 'C-2002',
      deviceId: DEVICE_B,
      mediumId: MEDIUM_MATTE,
      ticket: ticketOfSize(1000, 500),
      tags: ['vehicle'],
      doneAt: '2026-04-02T12:00:00.000Z',
    },
    {
      id: 'arc-banner',
      name: 'Spring banner',
      customerRef: 'C-1001',
      deviceId: DEVICE_A,
      mediumId: MEDIUM_MATTE,
      ticket: ticketOfSize(3000, 1000),
      tags: ['banner', 'Spring'],
      doneAt: '2026-05-20T12:00:00.000Z',
    },
    {
      id: 'arc-menu',
      name: 'Menu board',
      deviceId: DEVICE_B,
      mediumId: MEDIUM_GLOSS,
      ticket: { intent: { quantity: 1 }, process: {} },
      doneAt: '2026-06-01T12:00:00.000Z',
    },
  ];
  for (const fixture of fixtures) {
    await seedJob(h, fixture);
    await h.service.archive(fixture.id);
  }
}

async function idsFor(h: Harness, query: ArchiveSearchQuery): Promise<string[]> {
  return (await h.service.search(query)).items.map((row) => row.jobId);
}

describe('archive search', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness({ start: '2026-07-01T08:00:00.000Z' });
    await seedArchive(h);
  });

  it('lists every archived job, newest done time first, with the slim index fields', async () => {
    const page = await h.service.search({});
    expect(page.items.map((row) => row.jobId)).toEqual(['arc-menu', 'arc-banner', 'arc-fleet', 'arc-spring-window']);
    expect(page.nextCursor).toBeUndefined();
    expect(page.items[1]).toMatchObject({
      name: 'Spring banner',
      customerRef: 'C-1001',
      deviceId: DEVICE_A,
      mediumId: MEDIUM_MATTE,
      widthMm: 3000,
      heightMm: 1000,
      doneAt: '2026-05-20T12:00:00.000Z',
      archivedAt: '2026-07-01T08:00:00.000Z',
    });
  });

  it('filters by case-insensitive text over name, customer, id, tags and metadata', async () => {
    expect(await idsFor(h, { text: 'SPRING' })).toEqual(['arc-banner', 'arc-spring-window']);
    expect(await idsFor(h, { text: 'po-77' })).toEqual(['arc-spring-window']);
    expect(await idsFor(h, { text: 'c-2002' })).toEqual(['arc-fleet']);
    expect(await idsFor(h, { text: 'nothing like this' })).toEqual([]);
  });

  it('filters by customer and metadata', async () => {
    expect(await idsFor(h, { customerRef: 'c-1001' })).toEqual(['arc-banner', 'arc-spring-window']);
    expect(await idsFor(h, { metadata: { order: 'PO-77' } })).toEqual(['arc-spring-window']);
    expect(await idsFor(h, { metadata: { order: 'PO-78' } })).toEqual([]);
  });

  it('filters by an inclusive date range on the chosen date field', async () => {
    expect(await idsFor(h, { from: '2026-04-01T00:00:00.000Z', to: '2026-05-31T23:59:59.999Z' })).toEqual([
      'arc-banner',
      'arc-fleet',
    ]);
    expect(await idsFor(h, { from: '2026-05-20T12:00:00.000Z' })).toEqual(['arc-menu', 'arc-banner']);
    expect(await idsFor(h, { dateField: 'archived', to: '2026-06-30T00:00:00.000Z' })).toEqual([]);
  });

  it('filters by device and medium', async () => {
    expect(await idsFor(h, { deviceId: DEVICE_B })).toEqual(['arc-menu', 'arc-fleet']);
    expect(await idsFor(h, { mediumId: MEDIUM_MATTE })).toEqual(['arc-banner', 'arc-fleet']);
    expect(await idsFor(h, { deviceId: DEVICE_A, mediumId: MEDIUM_GLOSS })).toEqual(['arc-spring-window']);
  });

  it('filters by size range and leaves out jobs without a finished size', async () => {
    expect(await idsFor(h, { minWidthMm: 500, maxWidthMm: 1500 })).toEqual(['arc-fleet']);
    expect(await idsFor(h, { minHeightMm: 100, maxHeightMm: 500 })).toEqual(['arc-fleet', 'arc-spring-window']);
    expect(await idsFor(h, { minWidthMm: 0 })).not.toContain('arc-menu');
  });

  it('requires every listed tag, case-insensitively', async () => {
    expect(await idsFor(h, { tags: ['spring'] })).toEqual(['arc-banner', 'arc-spring-window']);
    expect(await idsFor(h, { tags: ['SPRING', 'banner'] })).toEqual(['arc-banner']);
    expect(await idsFor(h, { tags: ['spring', 'vehicle'] })).toEqual([]);
  });

  it('pages with a cursor through every result exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await h.service.search({ limit: 1, cursor });
      seen.push(...page.items.map((row) => row.jobId));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(4);
    expect(seen).toEqual(['arc-menu', 'arc-banner', 'arc-fleet', 'arc-spring-window']);
  });

  it('keeps filters across pages', async () => {
    const first = await h.service.search({ customerRef: 'C-1001', limit: 1 });
    expect(first.items.map((row) => row.jobId)).toEqual(['arc-banner']);
    const second = await h.service.search({ customerRef: 'C-1001', limit: 1, cursor: first.nextCursor });
    expect(second.items.map((row) => row.jobId)).toEqual(['arc-spring-window']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('rejects a malformed cursor or one issued for another date field', async () => {
    const { nextCursor } = await h.service.search({ limit: 1 });
    await expect(h.service.search({ cursor: 'not-a-cursor' })).rejects.toThrow(InvalidCursorError);
    await expect(h.service.search({ dateField: 'created', cursor: nextCursor })).rejects.toThrow(InvalidCursorError);
  });

  it('drops a job from the index when it is restored or trashed', async () => {
    await h.service.restore('arc-fleet');
    await h.service.trash('arc-menu');
    expect(await idsFor(h, {})).toEqual(['arc-banner', 'arc-spring-window']);
  });
});

describe('parseSearchQuery', () => {
  it('maps query-string parameters to a search query', () => {
    expect(
      parseSearchQuery({
        q: 'spring',
        customer: 'C-1001',
        'meta.order': 'PO-77',
        dateField: 'archived',
        from: '2026-04-01',
        to: '2026-05-31T23:59:59Z',
        device: DEVICE_A,
        medium: MEDIUM_MATTE,
        minWidthMm: '500',
        maxWidthMm: '1500.5',
        minHeightMm: '0',
        maxHeightMm: 900,
        tags: ['spring, banner', 'window'],
        limit: '25',
        cursor: 'abc',
      }),
    ).toEqual({
      text: 'spring',
      customerRef: 'C-1001',
      metadata: { order: 'PO-77' },
      dateField: 'archived',
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-05-31T23:59:59.000Z',
      deviceId: DEVICE_A,
      mediumId: MEDIUM_MATTE,
      minWidthMm: 500,
      maxWidthMm: 1500.5,
      minHeightMm: 0,
      maxHeightMm: 900,
      tags: ['spring', 'banner', 'window'],
      limit: 25,
      cursor: 'abc',
    });
  });

  it('treats an empty query and blank values as no filter', () => {
    expect(parseSearchQuery({})).toEqual({});
    expect(parseSearchQuery({ q: '  ', tags: ' , ' })).toEqual({});
  });

  it('rejects invalid values', () => {
    const invalid: Record<string, unknown>[] = [
      { limit: '0' },
      { limit: String(MAX_PAGE_SIZE + 1) },
      { limit: '2.5' },
      { dateField: 'printed' },
      { from: 'yesterday' },
      { from: '2026-06-01', to: '2026-05-01' },
      { minWidthMm: '-1' },
      { maxHeightMm: 'wide' },
      { 'meta.': 'x' },
      { q: { $ne: '' } },
      { tags: [1, 2] },
    ];
    for (const raw of invalid) {
      expect(() => parseSearchQuery(raw), JSON.stringify(raw)).toThrow(InvalidArgumentError);
    }
  });
});
