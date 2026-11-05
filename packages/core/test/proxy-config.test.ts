import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, parseProxyConfig, proxyFor, redactProxyUrl } from '../src/index.js';

const HTTP_PROXY = 'http://proxy.local:3128/';
const HTTPS_PROXY = 'http://secure-proxy.local:3129/';

function withNoProxy(noProxy: string) {
  return parseProxyConfig({ HTTP_PROXY, HTTPS_PROXY, NO_PROXY: noProxy });
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

describe('parseProxyConfig', () => {
  it('returns an empty frozen config when nothing is set', () => {
    const config = parseProxyConfig({});
    expect(config).toEqual({ noProxy: [] });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.noProxy)).toBe(true);
  });

  it('reads and normalizes proxy URLs', () => {
    const config = parseProxyConfig({ HTTP_PROXY: ' http://Proxy.Local:3128 ', HTTPS_PROXY: 'https://secure.local' });
    expect(config.httpProxy).toBe('http://proxy.local:3128/');
    expect(config.httpsProxy).toBe('https://secure.local/');
  });

  it('freezes every NO_PROXY rule', () => {
    const config = withNoProxy('example.com,10.0.0.1,*');
    expect(config.noProxy).toHaveLength(3);
    for (const rule of config.noProxy) expect(Object.isFrozen(rule)).toBe(true);
  });

  it('keeps credentials in the config so they can be sent to the proxy', () => {
    const config = parseProxyConfig({ HTTP_PROXY: 'http://user:secret@proxy.local:3128' });
    expect(config.httpProxy).toBe('http://user:secret@proxy.local:3128/');
  });

  it('treats empty and whitespace-only values as unset', () => {
    expect(parseProxyConfig({ HTTP_PROXY: '', HTTPS_PROXY: '   ', NO_PROXY: ' , ,' })).toEqual({ noProxy: [] });
  });
});

describe('variable case precedence', () => {
  it.each([
    ['HTTP_PROXY', 'http_proxy', 'http://example.com/', 'httpProxy'],
    ['HTTPS_PROXY', 'https_proxy', 'https://example.com/', 'httpsProxy'],
  ] as const)('%s is overridden by %s', (upper, lower, target, key) => {
    const config = parseProxyConfig({ [upper]: 'http://upper.local:1', [lower]: 'http://lower.local:2' });
    expect(config[key]).toBe('http://lower.local:2/');
    expect(proxyFor(config, target)).toBe('http://lower.local:2/');
  });

  it('uses the uppercase variable when only it is set', () => {
    expect(parseProxyConfig({ HTTP_PROXY: 'http://upper.local:1' }).httpProxy).toBe('http://upper.local:1/');
    expect(parseProxyConfig({ HTTPS_PROXY: 'http://upper.local:1' }).httpsProxy).toBe('http://upper.local:1/');
  });

  it('uses the lowercase variable when only it is set', () => {
    expect(parseProxyConfig({ http_proxy: 'http://lower.local:2' }).httpProxy).toBe('http://lower.local:2/');
  });

  it('lets an empty lowercase variable disable the uppercase one', () => {
    expect(parseProxyConfig({ http_proxy: '', HTTP_PROXY: 'http://upper.local:1' }).httpProxy).toBeUndefined();
  });

  it('prefers no_proxy over NO_PROXY', () => {
    const config = parseProxyConfig({ HTTP_PROXY, NO_PROXY: 'upper.example', no_proxy: 'lower.example' });
    expect(proxyFor(config, 'http://lower.example/')).toBeUndefined();
    expect(proxyFor(config, 'http://upper.example/')).toBe(HTTP_PROXY);
  });

  it('names the variable that was actually read in errors', () => {
    expect(() => parseProxyConfig({ http_proxy: 'ftp://x', HTTP_PROXY: 'http://ok' })).toThrow(/^http_proxy /);
    expect(() => parseProxyConfig({ no_proxy: 'bad host' })).toThrow(/^no_proxy entry 1 /);
  });
});

describe('invalid proxy URLs', () => {
  it.each([
    ['not a url', /is not a valid URL/],
    ['http://', /is not a valid URL/],
    ['http://proxy.local:99999', /is not a valid URL/],
    ['proxy.local:3128', /must use the http or https scheme/],
    ['ftp://proxy.local', /must use the http or https scheme/],
    ['socks5://proxy.local:1080', /must use the http or https scheme/],
    ['http://proxy.local/path', /must not include a path, query, or fragment/],
    ['http://proxy.local/?a=1', /must not include a path, query, or fragment/],
    ['http://proxy.local/#frag', /must not include a path, query, or fragment/],
  ])('rejects %j', (value, message) => {
    const error = captureError(() => parseProxyConfig({ HTTPS_PROXY: value }));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toHaveProperty('message', expect.stringMatching(message));
  });

  it.each([
    'user:secret@proxy.local:3128',
    'http://user:secret@proxy.local:99999',
    'ftp://user:secret@proxy.local',
    'http://user:secret@proxy.local/path',
  ])('never puts credentials from %j in the error message', (value) => {
    const error = captureError(() => parseProxyConfig({ HTTP_PROXY: value }));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toHaveProperty('message', expect.not.stringContaining('secret'));
    expect(error).toHaveProperty('message', expect.not.stringContaining('proxy.local'));
  });
});

describe('redactProxyUrl', () => {
  it.each([
    ['http://user:secret@proxy.local:3128/', 'http://***@proxy.local:3128/'],
    ['http://user@proxy.local:3128', 'http://***@proxy.local:3128/'],
    ['http://:secret@proxy.local', 'http://***@proxy.local/'],
    ['https://proxy.local:8443', 'https://proxy.local:8443/'],
  ])('redacts %j', (input, expected) => {
    expect(redactProxyUrl(input)).toBe(expected);
  });

  it('rejects an unparseable URL without echoing it', () => {
    const error = captureError(() => redactProxyUrl('http://user:secret@proxy.local:99999'));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toHaveProperty('message', expect.not.stringContaining('secret'));
  });
});

describe('proxyFor', () => {
  it('picks the proxy by target scheme without falling back', () => {
    const both = parseProxyConfig({ HTTP_PROXY, HTTPS_PROXY });
    expect(proxyFor(both, 'http://example.com/')).toBe(HTTP_PROXY);
    expect(proxyFor(both, 'https://example.com/')).toBe(HTTPS_PROXY);
    expect(proxyFor(parseProxyConfig({ HTTP_PROXY }), 'https://example.com/')).toBeUndefined();
    expect(proxyFor(parseProxyConfig({ HTTPS_PROXY }), 'http://example.com/')).toBeUndefined();
  });

  it('accepts URL objects', () => {
    expect(proxyFor(parseProxyConfig({ HTTP_PROXY }), new URL('http://example.com/'))).toBe(HTTP_PROXY);
  });

  it.each(['ftp://example.com/', 'not a url', 'ws://example.com/'])('rejects target %j', (target) => {
    expect(() => proxyFor(parseProxyConfig({ HTTP_PROXY }), target)).toThrow(InvalidArgumentError);
  });

  it('does not echo target credentials in errors', () => {
    const error = captureError(() => proxyFor(parseProxyConfig({}), 'ftp://user:secret@example.com/'));
    expect(error).toHaveProperty('message', expect.not.stringContaining('secret'));
  });
});

describe('NO_PROXY matching', () => {
  // [NO_PROXY, target, bypassed]
  const cases: readonly (readonly [string, string, boolean])[] = [
    // wildcard
    ['*', 'http://anything.example/', true],
    ['*', 'https://[2001:db8::1]/', true],
    // exact host / bare domain suffix: the domain itself and its subdomains
    ['localhost', 'http://localhost:8080/', true],
    ['localhost', 'http://localhost.example/', false],
    ['example.com', 'http://example.com/', true],
    ['example.com', 'https://api.example.com/', true],
    ['example.com', 'http://a.b.example.com/', true],
    ['example.com', 'http://notexample.com/', false],
    ['example.com', 'http://example.com.evil.test/', false],
    ['example.com', 'http://example.org/', false],
    // leading dot: subdomains only
    ['.example.com', 'http://api.example.com/', true],
    ['.example.com', 'http://example.com/', false],
    ['.example.com', 'http://notexample.com/', false],
    // case and trailing dots are normalized on both sides
    ['Example.COM.', 'http://API.Example.com./', true],
    // host:port
    ['example.com:8080', 'http://example.com:8080/', true],
    ['example.com:8080', 'http://example.com/', false],
    ['example.com:8080', 'http://api.example.com:8080/', true],
    ['example.com:80', 'http://example.com/', true],
    ['example.com:443', 'https://example.com/', true],
    ['example.com:443', 'http://example.com/', false],
    ['.example.com:8443', 'https://api.example.com:8443/', true],
    // IPv4 literals match exactly, never as a suffix
    ['10.0.0.1', 'http://10.0.0.1/', true],
    ['10.0.0.1', 'http://10.0.0.1:9000/', true],
    ['10.0.0.1', 'http://10.0.0.10/', false],
    ['10.0.0.1', 'http://110.0.0.1/', false],
    ['10.0.0.1:9000', 'http://10.0.0.1:9000/', true],
    ['10.0.0.1:9000', 'http://10.0.0.1/', false],
    ['127.0.0.1', 'http://localhost/', false],
    // IPv6 literals, bare or bracketed, compared in normalized form
    ['::1', 'http://[::1]:3000/', true],
    ['::1', 'http://[::2]/', false],
    ['0:0:0:0:0:0:0:1', 'http://[::1]/', true],
    ['2001:DB8::1', 'https://[2001:db8:0::1]/', true],
    ['[::1]', 'http://[::1]/', true],
    ['[::1]:3000', 'http://[::1]:3000/', true],
    ['[::1]:3000', 'http://[::1]:3001/', false],
    // comma lists with whitespace and empty entries
    [' localhost , .internal,, 10.0.0.1 ', 'http://db.internal/', true],
    [' localhost , .internal,, 10.0.0.1 ', 'http://10.0.0.1/', true],
    [' localhost , .internal,, 10.0.0.1 ', 'http://example.com/', false],
  ];

  it.each(cases)('NO_PROXY=%j target %s bypassed=%s', (noProxy, target, bypassed) => {
    const expected = target.startsWith('https:') ? HTTPS_PROXY : HTTP_PROXY;
    expect(proxyFor(withNoProxy(noProxy), target)).toBe(bypassed ? undefined : expected);
  });

  it('parses each form into a rule', () => {
    expect(withNoProxy('*, Example.com, .sub.example.com:8080, 10.0.0.1:80, [::1]:3000').noProxy).toEqual([
      { kind: 'any' },
      { kind: 'domain', domain: 'example.com', includeApex: true },
      { kind: 'domain', domain: 'sub.example.com', includeApex: false, port: 8080 },
      { kind: 'ip', address: '10.0.0.1', port: 80 },
      { kind: 'ip', address: '::1', port: 3000 },
    ]);
  });
});

describe('invalid NO_PROXY entries', () => {
  it.each([
    ['.', /is not a valid host name/],
    ['..example.com', /is not a valid host name/],
    ['exa mple.com', /is not a valid host name/],
    ['*.example.com', /is not a valid host name/],
    ['-bad.example.com', /is not a valid host name/],
    ['10.0.0.0/8', /is not a valid host name/],
    ['bücher.example', /is not a valid host name/],
    ['10.0.0.256', /is not a valid IPv4 address/],
    ['10.0.1', /is not a valid IPv4 address/],
    ['010.0.0.1', /is not a valid IPv4 address/],
    ['example.com:0', /has an invalid port/],
    ['example.com:65536', /has an invalid port/],
    ['example.com:abc', /has an invalid port/],
    ['example.com:', /has an invalid port/],
    ['[::1', /is not a valid bracketed IPv6 address/],
    ['[example.com]', /is not a valid bracketed IPv6 address/],
    ['[::1]x', /has text after the IPv6 address/],
    ['gg::1', /is not a valid IPv6 address/],
    ['fe80::1%eth0', /is not a valid IPv6 address/],
  ])('rejects %j', (entry, message) => {
    const error = captureError(() => withNoProxy(`localhost,${entry}`));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toHaveProperty('message', expect.stringMatching(/^NO_PROXY entry 2 /));
    expect(error).toHaveProperty('message', expect.stringMatching(message));
  });

  it('does not echo the entry, which could hold pasted credentials', () => {
    const error = captureError(() => withNoProxy('http://user:secret@proxy.local'));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toHaveProperty('message', expect.not.stringContaining('secret'));
  });
});
