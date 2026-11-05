import { describe, expect, it } from 'vitest';
import {
  createEvent,
  verifySignature,
  WEBHOOK_DELIVERY_LOG_LIMIT,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_SIGNATURE_HEADER,
  WebhookDispatcher,
  type CloudEvent,
  type WebhookRequest,
  type WebhookSubscription,
} from '../src/index.js';

const NOW = new Date('2026-03-01T09:00:00.000Z');
const NOW_MS = NOW.getTime();
const SECRET = 'test-secret-not-real-0000';

function subscription(id: string, eventTypes: readonly string[], active = true): WebhookSubscription {
  return { id, url: `https://hooks.example.com/${id}`, secret: SECRET, eventTypes, active };
}

function event(id: string, type = 'job.status.changed'): CloudEvent {
  return createEvent({ type, source: '/bps/jobs', subject: 'job-1', data: { jobId: 'job-1' } }, id, NOW);
}

interface Scheduled {
  readonly delayMs: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/** Records scheduled retries; `runNext` fires the oldest one that is still live. */
function fakeScheduler(): {
  schedule: (delayMs: number, fn: () => void) => () => void;
  scheduled: Scheduled[];
  runNext: () => Promise<void>;
} {
  const scheduled: Scheduled[] = [];
  return {
    scheduled,
    schedule: (delayMs, fn) => {
      const entry: Scheduled = { delayMs, fn, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    runNext: async () => {
      const next = scheduled.find((entry) => !entry.cancelled);
      if (next === undefined) throw new Error('no retry scheduled');
      next.cancelled = true;
      next.fn();
      await settle();
    },
  };
}

/** Lets the fake sends (which resolve immediately) and the log writes finish. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(subscriptions: WebhookSubscription[], status: (request: WebhookRequest) => number) {
  const requests: WebhookRequest[] = [];
  const scheduler = fakeScheduler();
  const dispatcher = new WebhookDispatcher({
    subscriptions: () => subscriptions,
    send: async (request) => {
      requests.push(request);
      return { status: status(request) };
    },
    now: () => NOW_MS,
    schedule: scheduler.schedule,
  });
  return { dispatcher, requests, scheduler };
}

describe('WebhookDispatcher', () => {
  it('delivers a signed event to active matching subscriptions only', async () => {
    const subs = [
      subscription('exact', ['job.status.changed']),
      subscription('any', ['*']),
      subscription('other', ['job.created']),
      subscription('paused', ['*'], false),
    ];
    const { dispatcher, requests } = harness(subs, () => 204);

    await dispatcher.dispatch(event('evt-1'));

    expect(requests.map((request) => request.url).sort()).toEqual([
      'https://hooks.example.com/any',
      'https://hooks.example.com/exact',
    ]);
    const first = requests[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(verifySignature(SECRET, first.headers[WEBHOOK_SIGNATURE_HEADER] ?? '', first.body, NOW_MS / 1_000)).toBe(true);
    expect(dispatcher.deliveries()).toEqual(
      expect.arrayContaining([
        { subscriptionId: 'exact', eventId: 'evt-1', attempt: 1, ok: true, status: 204, at: NOW.toISOString() },
        { subscriptionId: 'any', eventId: 'evt-1', attempt: 1, ok: true, status: 204, at: NOW.toISOString() },
      ]),
    );
    expect(dispatcher.deliveries('exact')).toHaveLength(1);
    expect(dispatcher.pendingRetries).toBe(0);
  });

  it('schedules a retry with the next attempt number after a failure', async () => {
    let failures = 2;
    const { dispatcher, requests, scheduler } = harness([subscription('sub-1', ['*'])], () => (failures-- > 0 ? 503 : 200));

    await dispatcher.dispatch(event('evt-1'));
    expect(scheduler.scheduled.map((entry) => entry.delayMs)).toEqual([1_000]);
    expect(dispatcher.pendingRetries).toBe(1);

    await scheduler.runNext();
    expect(scheduler.scheduled.map((entry) => entry.delayMs)).toEqual([1_000, 2_000]);

    await scheduler.runNext();
    expect(requests).toHaveLength(3);
    expect(dispatcher.pendingRetries).toBe(0);
    expect(dispatcher.deliveries('sub-1').map(({ attempt, ok, status }) => ({ attempt, ok, status }))).toEqual([
      { attempt: 1, ok: false, status: 503 },
      { attempt: 2, ok: false, status: 503 },
      { attempt: 3, ok: true, status: 200 },
    ]);
    expect(dispatcher.deliveries('sub-1')[0]?.error).toBe('webhook endpoint answered HTTP 503');
  });

  it('records a failed send as an error without a status', async () => {
    const scheduler = fakeScheduler();
    const dispatcher = new WebhookDispatcher({
      subscriptions: () => [subscription('sub-1', ['*'])],
      send: () => Promise.reject(new Error('connection refused')),
      now: () => NOW_MS,
      schedule: scheduler.schedule,
    });

    await dispatcher.dispatch(event('evt-1'));

    expect(dispatcher.deliveries()).toEqual([
      { subscriptionId: 'sub-1', eventId: 'evt-1', attempt: 1, ok: false, error: 'connection refused', at: NOW.toISOString() },
    ]);
    expect(scheduler.scheduled).toHaveLength(1);
  });

  it('stops after the last attempt fails', async () => {
    const { dispatcher, requests, scheduler } = harness([subscription('sub-1', ['*'])], () => 500);

    await dispatcher.dispatch(event('evt-1'));
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) await scheduler.runNext();

    expect(requests).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect(scheduler.scheduled).toHaveLength(WEBHOOK_MAX_ATTEMPTS - 1);
    expect(dispatcher.pendingRetries).toBe(0);
    expect(dispatcher.deliveries().at(-1)).toMatchObject({ attempt: WEBHOOK_MAX_ATTEMPTS, ok: false });
    await expect(scheduler.runNext()).rejects.toThrow('no retry scheduled');
  });

  it('drops a retry when the subscription was removed or deactivated', async () => {
    const subs = [subscription('sub-1', ['*'])];
    const { dispatcher, requests, scheduler } = harness(subs, () => 500);

    await dispatcher.dispatch(event('evt-1'));
    subs[0] = subscription('sub-1', ['*'], false);
    await scheduler.runNext();

    expect(requests).toHaveLength(1);
    expect(dispatcher.pendingRetries).toBe(0);
  });

  it('stop() cancels scheduled retries', async () => {
    const { dispatcher, requests, scheduler } = harness([subscription('sub-1', ['*'])], () => 500);

    await dispatcher.dispatch(event('evt-1'));
    dispatcher.stop();

    expect(scheduler.scheduled.every((entry) => entry.cancelled)).toBe(true);
    expect(dispatcher.pendingRetries).toBe(0);
    scheduler.scheduled[0]?.fn();
    await settle();
    expect(requests).toHaveLength(1);
  });

  it(`keeps only the newest ${WEBHOOK_DELIVERY_LOG_LIMIT} log entries`, async () => {
    const { dispatcher } = harness([subscription('sub-1', ['*'])], () => 200);

    for (let n = 1; n <= WEBHOOK_DELIVERY_LOG_LIMIT + 5; n++) await dispatcher.dispatch(event(`evt-${n}`));

    const log = dispatcher.deliveries();
    expect(log).toHaveLength(WEBHOOK_DELIVERY_LOG_LIMIT);
    expect(log[0]?.eventId).toBe('evt-6');
    expect(log.at(-1)?.eventId).toBe(`evt-${WEBHOOK_DELIVERY_LOG_LIMIT + 5}`);
  });

  it('reports a failing subscription source instead of rejecting', async () => {
    const errors: unknown[] = [];
    const dispatcher = new WebhookDispatcher({
      subscriptions: () => {
        throw new Error('store offline');
      },
      send: async () => ({ status: 200 }),
      now: () => NOW_MS,
      schedule: fakeScheduler().schedule,
      onError: (error) => errors.push(error),
    });

    await expect(dispatcher.dispatch(event('evt-1'))).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('rejects a log limit below one', () => {
    expect(
      () => new WebhookDispatcher({ subscriptions: () => [], send: async () => ({ status: 200 }), now: () => NOW_MS, schedule: fakeScheduler().schedule, logLimit: 0 }),
    ).toThrow(RangeError);
  });
});
