import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../mock/db';
import { fixtureId } from '../mock/fixtures';
import { queryKeys } from '../src/api/queries';
import type { Job, JobPage } from '../src/api/types';
import { formatBox, formatBytes, formatDateTime, formatLength, formatPageSize } from '../src/lib/format';
import { DEFAULT_SORT, nextSort, readJobFilters, toListFilters, writeJobFilters } from '../src/lib/jobFilters';
import { buildTimeline, deliveredPath } from '../src/lib/timeline';
import {
  applyEventToCache,
  connectLive,
  eventJobId,
  parseCloudEvent,
  type BpsEvent,
  type ConnectionState,
  type EventSourceLike,
} from '../src/live/events';
import { createPdfThumbnailRenderer } from '../src/preview/pdfThumbnailRenderer';
import { MAX_THUMBNAIL_PX, thumbnailScale, type RenderBackend } from '../src/preview/types';

/** Unit tests for the UI's pure modules (formatting, URL filters, timeline, SSE, preview pipeline). */

describe('format', () => {
  it('converts points to inches and millimetres without trailing zeros', () => {
    expect(formatLength(612, 'in')).toBe('8.5');
    expect(formatLength(612, 'mm')).toBe('215.9');
    expect(formatLength(72, 'in')).toBe('1');
    expect(formatPageSize(612, 792, 'in')).toBe('8.5 × 11 in');
  });

  it('formats a box with its origin', () => {
    expect(formatBox({ x: 9, y: 9, width: 612, height: 792 }, 'in')).toBe('8.5 × 11 in at 0.13, 0.13');
  });

  it('formats byte counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });

  it('formats missing and invalid dates safely', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
    expect(formatDateTime('2026-01-02T03:04:05Z')).toMatch(/2026/);
  });
});

describe('job filters in the URL', () => {
  it('reads repeated and comma-separated statuses, dropping unknown values', () => {
    const filters = readJobFilters(new URLSearchParams('status=failed,held&status=bogus&status=failed&q=sale&sort=-name'));
    expect(filters).toEqual({ status: ['failed', 'held'], q: 'sale', hotFolderId: '', deviceId: '', sort: '-name' });
  });

  it('falls back to the default sort for unknown values', () => {
    expect(readJobFilters(new URLSearchParams('sort=size')).sort).toBe(DEFAULT_SORT);
  });

  it('round-trips and omits defaults', () => {
    const filters = { status: ['queued' as const], q: 'x', hotFolderId: 'h1', deviceId: '', sort: DEFAULT_SORT };
    const params = writeJobFilters(filters);
    expect(params.toString()).toBe('status=queued&q=x&hotFolderId=h1');
    expect(readJobFilters(params)).toEqual(filters);
  });

  it('maps empty values to undefined for the API', () => {
    expect(toListFilters({ status: [], q: '  ', hotFolderId: '', deviceId: 'd1', sort: 'priority' })).toEqual({
      status: undefined,
      q: undefined,
      hotFolderId: undefined,
      deviceId: 'd1',
      sort: 'priority',
    });
  });

  it('toggles direction on the same column and uses the column default otherwise', () => {
    expect(nextSort('-createdAt', 'createdAt')).toBe('createdAt');
    expect(nextSort('createdAt', 'createdAt')).toBe('-createdAt');
    expect(nextSort('-createdAt', 'name')).toBe('name');
    expect(nextSort('-createdAt', 'priority')).toBe('-priority');
  });
});

describe('timeline', () => {
  const step = (id: string, stage: string, startedAt: string | null, result: Record<string, unknown> | null = null) => ({
    id,
    stage,
    status: 'completed' as const,
    startedAt,
    finishedAt: startedAt,
    result,
  });

  it('merges steps and audit entries oldest first, untimed items last', () => {
    const items = buildTimeline({
      steps: [step('s1', 'intake', '2026-01-01T10:00:00Z'), step('s2', 'inspect', null), step('s3', 'output', '2026-01-01T10:02:00Z')],
      audit: [{ id: 'a1', time: '2026-01-01T10:01:00Z', type: 'job.status.changed', message: 'Ready' }],
    });
    expect(items.map((item) => item.key)).toEqual(['step-s1', 'audit-a1', 'step-s3', 'step-s2']);
  });

  it('finds the latest delivered path of a completed output step', () => {
    expect(
      deliveredPath({
        steps: [
          step('s1', 'output', '2026-01-01T10:00:00Z', { deliveredPath: '/out/first.pdf' }),
          step('s2', 'output', '2026-01-01T11:00:00Z', { deliveredPath: '/out/second.pdf' }),
          { ...step('s3', 'output', '2026-01-01T12:00:00Z', { deliveredPath: '/out/partial.pdf' }), status: 'failed' as const },
        ],
      }),
    ).toBe('/out/second.pdf');
    expect(deliveredPath({ steps: [step('s1', 'intake', null)] })).toBeNull();
  });
});

describe('thumbnail scale', () => {
  it(`fits the longest edge into the request, never above ${MAX_THUMBNAIL_PX} px`, () => {
    expect(792 * thumbnailScale(612, 792, 200)).toBeCloseTo(200);
    expect(792 * thumbnailScale(612, 792, 4000)).toBeCloseTo(MAX_THUMBNAIL_PX);
    expect(8504 * thumbnailScale(8504, 2835, 320)).toBeCloseTo(MAX_THUMBNAIL_PX);
    expect(thumbnailScale(0, 0, 320)).toBe(1);
  });
});

describe('CloudEvents parsing', () => {
  it('accepts well-formed events and rejects the rest', () => {
    expect(parseCloudEvent('not json')).toBeNull();
    expect(parseCloudEvent(JSON.stringify({ type: 'job.created' }))).toBeNull();
    expect(parseCloudEvent(42)).toBeNull();
    const event = parseCloudEvent(JSON.stringify({ id: 'e1', type: 'job.created', time: 't', subject: 'J1', data: [1] }));
    expect(event).toEqual({ id: 'e1', type: 'job.created', time: 't', subject: 'J1', data: {} });
  });

  it('finds the job an event is about', () => {
    const base: BpsEvent = { id: 'e', type: 'step.started', time: 't', subject: 'J1', data: {} };
    expect(eventJobId(base)).toBe('J1');
    expect(eventJobId({ ...base, data: { jobId: 'J2' } })).toBe('J2');
    expect(eventJobId({ ...base, type: 'device.status', subject: 'D1' })).toBeUndefined();
  });
});

/** A controllable EventSource. */
function fakeSource() {
  const listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  const source: EventSourceLike & { emit: (type: string, data: unknown) => void } = {
    readyState: 1,
    onopen: null,
    onerror: null,
    addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    close: vi.fn(),
    emit: (type, data) => {
      for (const listener of listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    },
  };
  return source;
}

describe('connectLive', () => {
  it('reports state, delivers named events once per id and closes on disconnect', () => {
    const source = fakeSource();
    const states: ConnectionState[] = [];
    const received: string[] = [];
    const disconnect = connectLive({
      url: '/events',
      factory: () => source,
      onEvent: (event) => received.push(event.id),
      onState: (state) => states.push(state),
    });
    source.onopen?.(new Event('open'));
    const event = { id: 'e1', type: 'job.status.changed', time: 't', data: { jobId: 'J1', to: 'held' } };
    source.emit('job.status.changed', event);
    source.emit('job.status.changed', event);
    source.emit('message', { ...event, id: 'e2' });

    expect(states).toEqual(['connecting', 'open']);
    expect(received).toEqual(['e1', 'e2']);
    disconnect();
    expect(source.close).toHaveBeenCalled();
  });
});

describe('applyEventToCache', () => {
  it('patches the job detail and every loaded list page in place', () => {
    const db = createMockDb();
    const job: Job = db.getJob(fixtureId(7));
    db.dispose();
    const queryClient = new QueryClient();
    const listKey = [...queryKeys.jobLists, { sort: '-createdAt' }];
    queryClient.setQueryData<Job>(queryKeys.job(job.id), job);
    queryClient.setQueryData<InfiniteData<JobPage>>(listKey, {
      pages: [{ items: [job], nextCursor: null }],
      pageParams: [null],
    });

    applyEventToCache(queryClient, {
      id: 'e1',
      type: 'job.status.changed',
      time: '2026-01-01T12:00:00Z',
      data: { jobId: job.id, from: job.status, to: 'held' },
    });

    expect(queryClient.getQueryData<Job>(queryKeys.job(job.id))?.status).toBe('held');
    expect(queryClient.getQueryData<InfiniteData<JobPage>>(listKey)?.pages[0].items[0]).toMatchObject({
      status: 'held',
      updatedAt: '2026-01-01T12:00:00Z',
    });
    queryClient.clear();
  });
});

describe('thumbnail pipeline', () => {
  const image = { source: {} as CanvasImageSource, width: 100, height: 75 };

  function setup(worker: RenderBackend | null) {
    const api = {
      getPreview: vi.fn(async () => null), // 501 no-render-engine in M2
      getJobFile: vi.fn(async () => new ArrayBuffer(8)),
    };
    const fallback: RenderBackend = {
      render: vi.fn(async (_key, load) => {
        await load();
        return image;
      }),
    };
    const renderer = createPdfThumbnailRenderer(api, { primary: () => worker, fallback: () => fallback });
    return { api, fallback, renderer };
  }

  it('renders in the worker once the server reports no render engine, and stops asking the server', async () => {
    const worker: RenderBackend = { render: vi.fn(async () => image) };
    const { api, fallback, renderer } = setup(worker);
    await renderer.render({ jobId: 'J1', pageIndex: 0, maxPx: 320 });
    await renderer.render({ jobId: 'J1', pageIndex: 1, maxPx: 320 });
    expect(api.getPreview).toHaveBeenCalledTimes(1);
    expect(api.getPreview).toHaveBeenCalledWith('J1', 1, 320);
    expect(worker.render).toHaveBeenCalledTimes(2);
    expect(fallback.render).not.toHaveBeenCalled();
  });

  it('falls back to the main thread when the worker fails or is unsupported, loading the file once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken: RenderBackend = { render: vi.fn(async () => Promise.reject(new Error('no OffscreenCanvas'))) };
    const failing = setup(broken);
    expect(await failing.renderer.render({ jobId: 'J1', pageIndex: 0, maxPx: 320 })).toBe(image);
    expect(failing.fallback.render).toHaveBeenCalledTimes(1);

    const unsupported = setup(null);
    await unsupported.renderer.render({ jobId: 'J2', pageIndex: 0, maxPx: 320 });
    await unsupported.renderer.render({ jobId: 'J2', pageIndex: 1, maxPx: 320 });
    expect(unsupported.fallback.render).toHaveBeenCalledTimes(2);
    expect(unsupported.api.getJobFile).toHaveBeenCalledTimes(1);
  });
});
