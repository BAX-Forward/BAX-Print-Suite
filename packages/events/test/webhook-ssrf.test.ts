import { describe, expect, it } from 'vitest';
import {
  BlockedWebhookDestinationError,
  checkWebhookTarget,
  classifyAddress,
  createEvent,
  deliverWebhook,
  guardedWebhookSend,
  isBlockedAddress,
  pinnedLookup,
  WEBHOOK_BLOCKED_DESTINATION,
  type VettedWebhookTarget,
  type WebhookRequest,
  type WebhookTargetPolicy,
} from '../src/index.js';

/** Documentation-range addresses (not in any blocked range), so they count as public. */
const PUBLIC_V4 = '203.0.113.10';
const PUBLIC_V6 = '2001:db8::10';

/** Fake DNS: no real lookups. Unknown hosts have no answer. */
function policy(answers: Readonly<Record<string, readonly string[]>> = {}, allowLan = false): WebhookTargetPolicy & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    allowLan,
    resolve: async (host) => {
      asked.push(host);
      return [...(answers[host] ?? [])];
    },
  };
}

describe('isBlockedAddress', () => {
  it.each([
    ['10.0.0.0'],
    ['10.255.255.255'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.168.1.1'],
    ['169.254.169.254'],
    ['127.0.0.1'],
    ['127.255.255.254'],
    ['0.0.0.0'],
    ['0.1.2.3'],
    ['::'],
    ['::1'],
    ['fc00::1'],
    ['fdff:ffff::1'],
    ['fe80::1'],
    ['febf::1'],
    ['fe80::1%eth0'],
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['::ffff:10.0.0.1'],
    ['::ffff:172.20.1.1'],
    ['::ffff:192.168.0.1'],
    ['::ffff:169.254.0.1'],
    ['::ffff:127.0.0.1'],
    ['::ffff:0.0.0.0'],
    ['::ffff:a00:1'],
    ['::ffff:c0a8:1'],
    ['::ffff:7f00:1'],
    ['::ffff:a9fe:a9fe'],
    ['0:0:0:0:0:ffff:ac10:0001'],
  ])('blocks the IPv4-mapped form %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    [PUBLIC_V4],
    ['8.8.8.8'],
    ['9.255.255.255'],
    ['11.0.0.0'],
    ['172.15.255.255'],
    ['172.32.0.0'],
    ['192.167.255.255'],
    ['192.169.0.0'],
    ['169.253.255.255'],
    ['169.255.0.0'],
    ['128.0.0.0'],
    ['1.0.0.0'],
    [PUBLIC_V6],
    ['::2'],
    ['fbff::1'],
    ['fec0::1'],
    ['::ffff:8.8.8.8'],
    ['::ffff:808:808'],
  ])('allows the public address %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('treats anything that is not an IP address as blocked', () => {
    for (const text of ['', 'localhost', 'example.com', '256.0.0.1', '1.2.3', '::ffff:1.2.3.999', 'gggg::1']) {
      expect(isBlockedAddress(text), text).toBe(true);
      expect(classifyAddress(text), text).toBe('invalid');
    }
  });

  it('classifies each range', () => {
    expect(classifyAddress('10.1.1.1')).toBe('private');
    expect(classifyAddress('fd12::1')).toBe('private');
    expect(classifyAddress('127.0.0.2')).toBe('loopback');
    expect(classifyAddress('::1')).toBe('loopback');
    expect(classifyAddress('169.254.0.1')).toBe('link-local');
    expect(classifyAddress('fe80::abcd')).toBe('link-local');
    expect(classifyAddress('0.0.0.0')).toBe('unspecified');
    expect(classifyAddress('::')).toBe('unspecified');
    expect(classifyAddress('::ffff:192.168.0.1')).toBe('private');
    expect(classifyAddress(PUBLIC_V4)).toBe('public');
  });
});

describe('checkWebhookTarget', () => {
  it('checks literal IPs without resolving', async () => {
    const p = policy();
    expect(await checkWebhookTarget('https://10.0.0.1/hook', p)).toMatchObject({ ok: false });
    expect(await checkWebhookTarget('https://[::ffff:10.0.0.1]/hook', p)).toMatchObject({ ok: false });
    expect(await checkWebhookTarget('https://[::1]/hook', p)).toMatchObject({ ok: false });
    expect(await checkWebhookTarget(`https://${PUBLIC_V4}/hook`, p)).toMatchObject({
      ok: true,
      target: { address: PUBLIC_V4, family: 4 },
    });
    expect(await checkWebhookTarget('https://[2001:db8::10]/hook', p)).toMatchObject({
      ok: true,
      target: { address: PUBLIC_V6, family: 6 },
    });
    expect(p.asked).toEqual([]);
  });

  it('resolves hostnames and vets the first answer', async () => {
    const p = policy({ 'hooks.example.com': [PUBLIC_V4, PUBLIC_V6] });
    const check = await checkWebhookTarget('https://hooks.example.com/bps', p);
    expect(check).toMatchObject({ ok: true, target: { address: PUBLIC_V4, family: 4 } });
    expect(check.ok && check.target.url.hostname).toBe('hooks.example.com');
    expect(p.asked).toEqual(['hooks.example.com']);
  });

  it('rejects a hostname when ANY answer is blocked', async () => {
    const p = policy({
      'mixed.example.com': [PUBLIC_V4, '192.168.1.5'],
      'mixed6.example.com': [PUBLIC_V6, 'fe80::1'],
      'mapped.example.com': [PUBLIC_V4, '::ffff:127.0.0.1'],
    });
    for (const host of ['mixed.example.com', 'mixed6.example.com', 'mapped.example.com']) {
      const check = await checkWebhookTarget(`https://${host}/hook`, p);
      expect(check.ok, host).toBe(false);
      expect(!check.ok && check.reason, host).toContain('blocked address');
    }
  });

  it('rejects a hostname with no answers', async () => {
    const check = await checkWebhookTarget('https://void.example.com/hook', policy({ 'void.example.com': [] }));
    expect(check).toEqual({ ok: false, reason: 'webhook target void.example.com did not resolve to any address' });
  });

  it('propagates resolver failures', async () => {
    const failing: WebhookTargetPolicy = {
      allowLan: false,
      resolve: async () => {
        throw new Error('resolver down');
      },
    };
    await expect(checkWebhookTarget('https://hooks.example.com/', failing)).rejects.toThrow('resolver down');
  });

  it('rejects non-http URLs and unparsable URLs', async () => {
    expect(await checkWebhookTarget('ftp://hooks.example.com/', policy())).toMatchObject({ ok: false });
    expect(await checkWebhookTarget('not a url', policy())).toMatchObject({ ok: false });
  });

  it('keeps the localhost and 127.0.0.1 development allowance', async () => {
    const p = policy({ localhost: ['127.0.0.1', '::1'] });
    expect(await checkWebhookTarget('http://localhost:9000/hook', p)).toMatchObject({ ok: true, target: { address: '127.0.0.1' } });
    expect(await checkWebhookTarget('https://localhost/hook', p)).toMatchObject({ ok: true });
    expect(await checkWebhookTarget('http://127.0.0.1:9000/hook', p)).toMatchObject({ ok: true, target: { address: '127.0.0.1' } });
  });

  it('does not extend the allowance to other loopback addresses or non-loopback localhost answers', async () => {
    const p = policy({ localhost: ['127.0.0.1', '10.0.0.1'] });
    expect(await checkWebhookTarget('http://localhost/hook', p)).toMatchObject({ ok: false });
    expect(await checkWebhookTarget('https://127.0.0.2/hook', p)).toMatchObject({ ok: false });
    expect(await checkWebhookTarget('https://[::1]/hook', policy({}, true))).toMatchObject({ ok: false });
  });

  it('allows the private ranges with allowLan, but not loopback, link-local or unspecified', async () => {
    const lan = policy({ 'printer.lan': ['192.168.1.20', 'fd00::20'], 'meta.lan': ['169.254.169.254'] }, true);
    for (const url of ['https://10.0.0.1/', 'https://172.16.5.5/', 'https://[fd00::1]/', 'https://[::ffff:192.168.0.9]/', 'https://printer.lan/']) {
      expect(await checkWebhookTarget(url, lan), url).toMatchObject({ ok: true });
    }
    for (const url of ['https://127.0.0.5/', 'https://169.254.1.1/', 'https://[fe80::1]/', 'https://0.0.0.0/', 'https://[::]/', 'https://meta.lan/']) {
      expect(await checkWebhookTarget(url, lan), url).toMatchObject({ ok: false });
    }
  });
});

describe('guardedWebhookSend', () => {
  const request: WebhookRequest = { url: 'https://hooks.example.com/bps', headers: {}, body: '{}' };

  it('passes the vetted target to the transport', async () => {
    const targets: VettedWebhookTarget[] = [];
    const send = guardedWebhookSend(async (_request, target) => {
      targets.push(target);
      return { status: 204 };
    }, policy({ 'hooks.example.com': [PUBLIC_V4] }));

    expect(await send(request)).toEqual({ status: 204 });
    expect(targets.map((target) => [target.address, target.family, target.url.hostname])).toEqual([[PUBLIC_V4, 4, 'hooks.example.com']]);
  });

  it('resolves once per request and never calls the transport for a blocked target', async () => {
    const p = policy({ 'hooks.example.com': ['10.0.0.9'] });
    let calls = 0;
    const send = guardedWebhookSend(async () => {
      calls += 1;
      return { status: 204 };
    }, p);

    await expect(send(request)).rejects.toBeInstanceOf(BlockedWebhookDestinationError);
    expect(calls).toBe(0);
    expect(p.asked).toEqual(['hooks.example.com']);
  });

  it('makes deliverWebhook report a blocked-destination attempt that is not retryable', async () => {
    const send = guardedWebhookSend(async () => ({ status: 204 }), policy({ 'hooks.example.com': [PUBLIC_V4, '172.16.0.1'] }));
    const event = createEvent({ type: 'job.created', source: '/bps/jobs', subject: 'job-1', data: { jobId: 'job-1' } }, 'evt-1', new Date(0));
    const subscription = { id: 'sub-1', url: request.url, secret: 'test-secret-not-real-0000', eventTypes: ['*'], active: true };

    expect(await deliverWebhook(subscription, event, { send, now: () => 0 })).toEqual({
      ok: false,
      error: WEBHOOK_BLOCKED_DESTINATION,
      attempt: 1,
      retryable: false,
    });
  });
});

describe('pinnedLookup', () => {
  it('answers with the vetted address whatever host is asked for', () => {
    const lookup = pinnedLookup(PUBLIC_V4, 4);
    const single: unknown[] = [];
    lookup('rebind.example.com', {}, (error, address, family) => single.push(error, address, family));
    expect(single).toEqual([null, PUBLIC_V4, 4]);

    const all: unknown[] = [];
    lookup('rebind.example.com', { all: true }, (error, address) => all.push(error, address));
    expect(all).toEqual([null, [{ address: PUBLIC_V4, family: 4 }]]);
  });
});
