import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createEvent,
  deliverWebhook,
  InvalidWebhookSubscriptionError,
  matchesSubscription,
  nextRetryDelayMs,
  signPayload,
  validateWebhookSubscription,
  verifySignature,
  WEBHOOK_MAX_ATTEMPTS,
  type CloudEvent,
  type WebhookDeliveryDeps,
  type WebhookRequest,
  type WebhookSubscription,
} from '../src/index.js';

const NOW = new Date('2026-03-01T09:00:00.000Z');
const NOW_MS = NOW.getTime();
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const SECRET = 'test-secret-not-real-0000';

const SUBSCRIPTION: WebhookSubscription = {
  id: 'sub-1',
  url: 'https://hooks.example.com/bps',
  secret: SECRET,
  eventTypes: ['job.status.changed'],
  active: true,
};

function statusEvent(id = 'evt-1'): CloudEvent {
  return createEvent(
    { type: 'job.status.changed', source: '/bps/jobs', subject: 'job-1', data: { jobId: 'job-1', from: 'queued', to: 'printing' } },
    id,
    NOW,
  );
}

function fakeDeps(respond: (request: WebhookRequest) => Promise<{ status: number }>): {
  deps: WebhookDeliveryDeps;
  requests: WebhookRequest[];
} {
  const requests: WebhookRequest[] = [];
  return {
    requests,
    deps: {
      now: () => NOW_MS,
      send: (request) => {
        requests.push(request);
        return respond(request);
      },
    },
  };
}

describe('validateWebhookSubscription', () => {
  it('accepts https URLs and plain http for localhost and 127.0.0.1', () => {
    const urls = ['https://hooks.example.com/bps', 'http://localhost:8080/hook', 'http://127.0.0.1/hook'];
    for (const url of urls) {
      expect(validateWebhookSubscription({ ...SUBSCRIPTION, url }), url).toEqual({ ...SUBSCRIPTION, url });
    }
  });

  it('returns a frozen copy that does not share the input array', () => {
    const eventTypes = ['job.created'];
    const subscription = validateWebhookSubscription({ ...SUBSCRIPTION, eventTypes });
    eventTypes.push('job.purged');
    expect(subscription.eventTypes).toEqual(['job.created']);
    expect(Object.isFrozen(subscription)).toBe(true);
    expect(Object.isFrozen(subscription.eventTypes)).toBe(true);
  });

  it('rejects plain http to other hosts, other schemes and unparsable URLs', () => {
    const urls = ['http://hooks.example.com/bps', 'http://10.0.0.5/hook', 'ftp://hooks.example.com/', 'not a url', ''];
    for (const url of urls) {
      expect(() => validateWebhookSubscription({ ...SUBSCRIPTION, url }), url).toThrow(InvalidWebhookSubscriptionError);
    }
  });

  it('rejects secrets shorter than 16 characters', () => {
    expect(() => validateWebhookSubscription({ ...SUBSCRIPTION, secret: 'short-dummy' })).toThrow(/secret/);
    expect(validateWebhookSubscription({ ...SUBSCRIPTION, secret: 'x'.repeat(16) }).secret).toHaveLength(16);
  });

  it('rejects other malformed fields', () => {
    const invalid: unknown[] = [
      null,
      [],
      'sub-1',
      { ...SUBSCRIPTION, id: '' },
      { ...SUBSCRIPTION, secret: 1234 },
      { ...SUBSCRIPTION, eventTypes: [] },
      { ...SUBSCRIPTION, eventTypes: 'job.created' },
      { ...SUBSCRIPTION, eventTypes: ['job.created', ''] },
      { ...SUBSCRIPTION, active: 'yes' },
    ];
    for (const value of invalid) {
      expect(() => validateWebhookSubscription(value), JSON.stringify(value)).toThrow(InvalidWebhookSubscriptionError);
    }
  });
});

describe('matchesSubscription', () => {
  it('matches exact types and the "*" wildcard on active subscriptions only', () => {
    const event = statusEvent();
    expect(matchesSubscription(SUBSCRIPTION, event)).toBe(true);
    expect(matchesSubscription({ ...SUBSCRIPTION, eventTypes: ['job.created'] }, event)).toBe(false);
    expect(matchesSubscription({ ...SUBSCRIPTION, eventTypes: ['job.status'] }, event)).toBe(false);
    expect(matchesSubscription({ ...SUBSCRIPTION, eventTypes: ['*'] }, event)).toBe(true);
    expect(matchesSubscription({ ...SUBSCRIPTION, eventTypes: ['job.created', '*'] }, event)).toBe(true);
    expect(matchesSubscription({ ...SUBSCRIPTION, active: false }, event)).toBe(false);
    expect(matchesSubscription({ ...SUBSCRIPTION, eventTypes: ['*'], active: false }, event)).toBe(false);
  });
});

describe('signPayload and verifySignature', () => {
  const body = JSON.stringify(statusEvent());

  it('produces t=<ts>,v1=<hex> and verifies the round trip', () => {
    const header = signPayload(SECRET, NOW_SECONDS, body);
    expect(header).toMatch(new RegExp(`^t=${NOW_SECONDS},v1=[0-9a-f]{64}$`));
    expect(verifySignature(SECRET, header, body, NOW_SECONDS)).toBe(true);
  });

  it('signs "<ts>.<body>" with HMAC-SHA256 of the secret', () => {
    const expected = createHmac('sha256', SECRET).update(`1700000000.${body}`).digest('hex');
    expect(signPayload(SECRET, 1_700_000_000, body)).toBe(`t=1700000000,v1=${expected}`);
    expect(signPayload(SECRET, 1, 'body')).not.toBe(signPayload(SECRET, 2, 'body'));
  });

  it('rejects a tampered body, a wrong secret and a tampered timestamp', () => {
    const header = signPayload(SECRET, NOW_SECONDS, body);
    expect(verifySignature(SECRET, header, `${body} `, NOW_SECONDS)).toBe(false);
    expect(verifySignature('other-secret-not-real-00', header, body, NOW_SECONDS)).toBe(false);
    const shifted = header.replace(`t=${NOW_SECONDS}`, `t=${NOW_SECONDS + 1}`);
    expect(verifySignature(SECRET, shifted, body, NOW_SECONDS)).toBe(false);
  });

  it('rejects timestamps outside the tolerance in either direction', () => {
    const header = signPayload(SECRET, NOW_SECONDS, body);
    expect(verifySignature(SECRET, header, body, NOW_SECONDS + 300)).toBe(true);
    expect(verifySignature(SECRET, header, body, NOW_SECONDS + 301)).toBe(false);
    expect(verifySignature(SECRET, header, body, NOW_SECONDS - 301)).toBe(false);
    expect(verifySignature(SECRET, header, body, NOW_SECONDS + 30, 10)).toBe(false);
  });

  it('rejects malformed headers without throwing', () => {
    const valid = signPayload(SECRET, NOW_SECONDS, body);
    const signature = valid.slice(valid.indexOf('v1='));
    const headers = ['', 'garbage', `t=${NOW_SECONDS}`, signature, `t=abc,${signature}`, `t=${NOW_SECONDS},v1=zz`, `t=${NOW_SECONDS},v1=abcd`];
    for (const header of headers) {
      expect(verifySignature(SECRET, header, body, NOW_SECONDS), header).toBe(false);
    }
  });

  it('rejects a non-integer signing timestamp', () => {
    expect(() => signPayload(SECRET, 1.5, body)).toThrow(RangeError);
    expect(() => signPayload(SECRET, -1, body)).toThrow(RangeError);
  });
});

describe('deliverWebhook', () => {
  it('sends the structured CloudEvent with signature and delivery id headers', async () => {
    const event = statusEvent('evt-42');
    const { deps, requests } = fakeDeps(() => Promise.resolve({ status: 204 }));

    const result = await deliverWebhook(SUBSCRIPTION, event, deps);

    expect(result).toEqual({ ok: true, status: 204, attempt: 1 });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    if (request === undefined) throw new Error('no request sent');
    expect(request.url).toBe(SUBSCRIPTION.url);
    expect(JSON.parse(request.body)).toEqual(event);
    expect(request.headers['content-type']).toBe('application/cloudevents+json');
    expect(request.headers['x-bps-delivery-id']).toBe('evt-42');
    const signature = request.headers['x-bps-signature'] ?? '';
    expect(signature).toBe(signPayload(SECRET, NOW_SECONDS, request.body));
    expect(verifySignature(SECRET, signature, request.body, NOW_SECONDS)).toBe(true);
  });

  it('reports the attempt number it was given', async () => {
    const { deps } = fakeDeps(() => Promise.resolve({ status: 200 }));
    expect(await deliverWebhook(SUBSCRIPTION, statusEvent(), deps, 3)).toEqual({ ok: true, status: 200, attempt: 3 });
  });

  it('treats 4xx, 5xx and 3xx answers as failures', async () => {
    for (const status of [400, 410, 500, 503, 302]) {
      const { deps } = fakeDeps(() => Promise.resolve({ status }));
      const result = await deliverWebhook(SUBSCRIPTION, statusEvent(), deps);
      expect(result.ok, String(status)).toBe(false);
      expect(result.status).toBe(status);
      expect(result.error).toMatch(String(status));
      expect(result.attempt).toBe(1);
    }
  });

  it('turns a thrown or rejected send into a failed result', async () => {
    const rejected = fakeDeps(() => Promise.reject(new Error('connection refused')));
    expect(await deliverWebhook(SUBSCRIPTION, statusEvent(), rejected.deps, 2)).toEqual({
      ok: false,
      error: 'connection refused',
      attempt: 2,
    });

    const thrown = fakeDeps(() => {
      throw new Error('send broke');
    });
    expect(await deliverWebhook(SUBSCRIPTION, statusEvent(), thrown.deps)).toEqual({
      ok: false,
      error: 'send broke',
      attempt: 1,
    });
  });
});

describe('nextRetryDelayMs', () => {
  it('doubles from 1 s and stops after the last attempt', () => {
    const delays: (number | null)[] = [];
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      delays.push(nextRetryDelayMs(attempt));
    }
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(8);
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, null]);
    expect(nextRetryDelayMs(9)).toBeNull();
  });

  it('caps the delay at one hour', () => {
    expect(nextRetryDelayMs(12, 100)).toBe(2_048_000);
    expect(nextRetryDelayMs(13, 100)).toBe(3_600_000);
    expect(nextRetryDelayMs(99, 100)).toBe(3_600_000);
  });

  it('rejects attempt numbers below 1', () => {
    expect(() => nextRetryDelayMs(0)).toThrow(RangeError);
    expect(() => nextRetryDelayMs(1.5)).toThrow(RangeError);
  });
});
