import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../api/queries';
import { JOB_STATUSES, type Job, type JobPage, type JobStatus } from '../api/types';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'offline';

/** The subset of the browser EventSource used here; lets mock mode and tests supply their own. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export const browserEventSourceFactory: EventSourceFactory = (url) => new EventSource(url);

/** Parsed CloudEvents envelope (ARCHITECTURE §5). */
export interface BpsEvent {
  id: string;
  type: string;
  time: string;
  subject?: string;
  data: Record<string, unknown>;
}

/** SSE `event:` names we listen for, in addition to unnamed `message` events. */
export const SUBSCRIBED_EVENT_TYPES = [
  'job.created',
  'job.status.changed',
  'step.started',
  'step.progress',
  'step.completed',
  'step.failed',
  'device.status',
] as const;

const EVENT_SOURCE_CLOSED = 2;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_REMEMBERED_EVENT_IDS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

function isJob(value: unknown): value is Job {
  return isRecord(value) && typeof value.id === 'string' && isJobStatus(value.status);
}

export function parseCloudEvent(raw: unknown): BpsEvent | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string') return null;
  return {
    id: value.id,
    type: value.type,
    time: typeof value.time === 'string' ? value.time : new Date().toISOString(),
    subject: typeof value.subject === 'string' ? value.subject : undefined,
    data: isRecord(value.data) ? value.data : {},
  };
}

export function eventJobId(event: BpsEvent): string | undefined {
  if (typeof event.data.jobId === 'string') return event.data.jobId;
  const isJobScoped = event.type.startsWith('job.') || event.type.startsWith('step.');
  return isJobScoped ? event.subject : undefined;
}

/** Whether list queries must be refetched (membership, ordering or new rows may have changed). */
export function eventAffectsLists(event: BpsEvent): boolean {
  return event.type.startsWith('job.');
}

/**
 * Applies an event to cached data immediately (so a row's status changes without a refetch),
 * then invalidates what the event may have made stale.
 */
export function applyEventToCache(queryClient: QueryClient, event: BpsEvent): void {
  if (event.type.startsWith('device.')) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.devices });
    return;
  }
  const jobId = eventJobId(event);
  if (!jobId) return;

  if (event.type === 'job.status.changed') {
    const fullJob = isJob(event.data.job) ? event.data.job : undefined;
    const to = isJobStatus(event.data.to) ? event.data.to : undefined;
    const patch = (old: Job): Job => fullJob ?? (to ? { ...old, status: to, updatedAt: event.time } : old);

    queryClient.setQueryData<Job>(queryKeys.job(jobId), (old) => (old ? patch(old) : old));
    queryClient.setQueriesData<InfiniteData<JobPage>>({ queryKey: queryKeys.jobLists }, (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              items: page.items.map((job) => (job.id === jobId ? patch(job) : job)),
            })),
          }
        : old,
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.transitions(jobId) });
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.job(jobId) });
}

export interface LiveOptions {
  url: string;
  factory: EventSourceFactory;
  onEvent: (event: BpsEvent) => void;
  onState: (state: ConnectionState) => void;
  retryDelaysMs?: readonly number[];
}

/**
 * Opens the SSE stream and keeps it open. EventSource retries on its own while CONNECTING;
 * if the browser gives up (CLOSED) we reconnect with backoff. Duplicate event ids are dropped.
 * Returns a disconnect function.
 */
export function connectLive(options: LiveOptions): () => void {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const seen = new Set<string>();
  let source: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;

  const handleMessage = (message: MessageEvent) => {
    const event = parseCloudEvent(message.data);
    if (!event || seen.has(event.id)) return;
    if (seen.size >= MAX_REMEMBERED_EVENT_IDS) seen.clear();
    seen.add(event.id);
    options.onEvent(event);
  };

  const scheduleRetry = () => {
    options.onState('offline');
    const delay = delays[Math.min(attempt, delays.length - 1)];
    attempt += 1;
    retryTimer = setTimeout(open, delay);
  };

  function open() {
    if (stopped) return;
    options.onState(attempt === 0 ? 'connecting' : 'reconnecting');
    let es: EventSourceLike;
    try {
      es = options.factory(options.url);
    } catch {
      scheduleRetry();
      return;
    }
    source = es;
    es.onopen = () => {
      attempt = 0;
      options.onState('open');
    };
    es.onerror = () => {
      if (stopped) return;
      if (es.readyState === EVENT_SOURCE_CLOSED) {
        es.close();
        source = null;
        scheduleRetry();
      } else {
        options.onState('reconnecting');
      }
    };
    es.addEventListener('message', handleMessage);
    for (const type of SUBSCRIBED_EVENT_TYPES) es.addEventListener(type, handleMessage);
  }

  open();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    source?.close();
    source = null;
  };
}
