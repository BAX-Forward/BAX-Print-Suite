import { InvalidArgumentError } from './errors.js';

/** Environment variables read by {@link parseProxyConfig}; `process.env` is compatible. */
export type ProxyEnv = Readonly<Record<string, string | undefined>>;

/** One parsed NO_PROXY entry. A rule with a `port` only matches targets on that port. */
export type NoProxyRule =
  | { readonly kind: 'any' }
  | { readonly kind: 'ip'; readonly address: string; readonly port?: number }
  | {
      readonly kind: 'domain';
      readonly domain: string;
      /** `true` for a bare domain (matches the domain itself and subdomains), `false` for a leading-dot entry (subdomains only). */
      readonly includeApex: boolean;
      readonly port?: number;
    };

/** Frozen proxy settings. Proxy URLs are normalized and may contain credentials; log them through {@link redactProxyUrl}. */
export interface ProxyConfig {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly noProxy: readonly NoProxyRule[];
}

const REDACTED = '***';
const MAX_PORT = 65535;
const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;
const PORT_PATTERN = /^\d{1,5}$/;
const IPV4_OCTET_PATTERN = /^(0|[1-9]\d{0,2})$/;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/;
const NUMERIC_FINAL_LABEL_PATTERN = /(^|\.)\d+$/;

interface EnvValue {
  readonly name: string;
  readonly value: string | undefined;
}

interface Target {
  readonly scheme: 'http:' | 'https:';
  readonly host: string;
  readonly port: number;
}

/**
 * Reads HTTP_PROXY, HTTPS_PROXY, and NO_PROXY (or their lowercase forms) into a frozen config.
 * A lowercase variable wins over the uppercase one whenever it is defined, even if empty;
 * an empty or whitespace-only value means "not configured".
 */
export function parseProxyConfig(env: ProxyEnv): ProxyConfig {
  const httpProxy = parseProxyUrl(readEnv(env, 'HTTP_PROXY'));
  const httpsProxy = parseProxyUrl(readEnv(env, 'HTTPS_PROXY'));
  const noProxy = parseNoProxy(readEnv(env, 'NO_PROXY'));
  return Object.freeze({
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    noProxy,
  });
}

/** Returns the proxy URL to use for `targetUrl`, or `undefined` when the request should go direct. */
export function proxyFor(config: ProxyConfig, targetUrl: string | URL): string | undefined {
  const target = parseTarget(targetUrl);
  const proxy = target.scheme === 'https:' ? config.httpsProxy : config.httpProxy;
  if (proxy === undefined) return undefined;
  return config.noProxy.some((rule) => ruleMatches(rule, target)) ? undefined : proxy;
}

/** Replaces any credentials in a proxy URL with `***` so it can be logged or shown. */
export function redactProxyUrl(proxyUrl: string): string {
  const url = parseUrl(proxyUrl, 'proxy URL');
  if (url.username === '' && url.password === '') return url.href;
  url.username = REDACTED;
  url.password = '';
  return url.href;
}

function readEnv(env: ProxyEnv, upperName: string): EnvValue {
  const lowerName = upperName.toLowerCase();
  const lowerValue = env[lowerName];
  if (lowerValue !== undefined) return { name: lowerName, value: lowerValue };
  return { name: upperName, value: env[upperName] };
}

/** Parses without echoing the input, which may contain credentials. */
function parseUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new InvalidArgumentError(`${label} is not a valid URL`);
  }
}

function parseProxyUrl({ name, value }: EnvValue): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return undefined;
  const url = parseUrl(trimmed, name);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidArgumentError(`${name} must use the http or https scheme`);
  }
  if (url.hostname === '') throw new InvalidArgumentError(`${name} must include a host`);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new InvalidArgumentError(`${name} must not include a path, query, or fragment`);
  }
  return url.href;
}

function parseNoProxy({ name, value }: EnvValue): readonly NoProxyRule[] {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return Object.freeze(entries.map((entry, index) => parseNoProxyEntry(entry, `${name} entry ${index + 1}`)));
}

/** Error messages name the entry by position rather than echoing it. */
function parseNoProxyEntry(entry: string, label: string): NoProxyRule {
  if (entry === '*') return freezeRule({ kind: 'any' });
  const { host, port } = splitHostPort(entry, label);
  const portPart = port === undefined ? {} : { port };
  if (host.includes(':')) {
    return freezeRule({ kind: 'ip', address: normalizeIpv6(host, label), ...portPart });
  }
  const lower = host.toLowerCase();
  if (isIpv4(lower)) return freezeRule({ kind: 'ip', address: lower, ...portPart });
  const includeApex = !lower.startsWith('.');
  const domain = (includeApex ? lower : lower.slice(1)).replace(/\.$/, '');
  if (domain === '' || !domain.split('.').every((part) => DOMAIN_LABEL_PATTERN.test(part))) {
    throw new InvalidArgumentError(`${label} is not a valid host name`);
  }
  if (NUMERIC_FINAL_LABEL_PATTERN.test(domain)) {
    throw new InvalidArgumentError(`${label} is not a valid IPv4 address`);
  }
  return freezeRule({ kind: 'domain', domain, includeApex, ...portPart });
}

function freezeRule(rule: NoProxyRule): NoProxyRule {
  return Object.freeze(rule);
}

function splitHostPort(entry: string, label: string): { host: string; port?: number } {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    const host = entry.slice(1, close);
    if (close === -1 || !host.includes(':')) {
      throw new InvalidArgumentError(`${label} is not a valid bracketed IPv6 address`);
    }
    const rest = entry.slice(close + 1);
    if (rest === '') return { host };
    if (!rest.startsWith(':')) throw new InvalidArgumentError(`${label} has text after the IPv6 address`);
    return { host, port: parsePort(rest.slice(1), label) };
  }
  const colon = entry.indexOf(':');
  // Several colons without brackets is a bare IPv6 literal, which cannot carry a port.
  if (colon === -1 || colon !== entry.lastIndexOf(':')) return { host: entry };
  return { host: entry.slice(0, colon), port: parsePort(entry.slice(colon + 1), label) };
}

function parsePort(text: string, label: string): number {
  const port = Number(text);
  if (!PORT_PATTERN.test(text) || port < 1 || port > MAX_PORT) {
    throw new InvalidArgumentError(`${label} has an invalid port`);
  }
  return port;
}

function isIpv4(host: string): boolean {
  const octets = host.split('.');
  return octets.length === 4 && octets.every((octet) => IPV4_OCTET_PATTERN.test(octet) && Number(octet) <= 255);
}

/** Uses the WHATWG URL parser so equivalent spellings (`0:0::1`, `::1`) compare equal. */
function normalizeIpv6(host: string, label: string): string {
  let hostname: string;
  try {
    hostname = new URL(`http://[${host}]/`).hostname;
  } catch {
    throw new InvalidArgumentError(`${label} is not a valid IPv6 address`);
  }
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) {
    throw new InvalidArgumentError(`${label} is not a valid IPv6 address`);
  }
  return hostname.slice(1, -1);
}

function parseTarget(targetUrl: string | URL): Target {
  const url = parseUrl(targetUrl.toString(), 'target URL');
  const scheme = url.protocol;
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new InvalidArgumentError('target URL must use the http or https scheme');
  }
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname.replace(/\.$/, '');
  const defaultPort = scheme === 'https:' ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;
  const port = url.port === '' ? defaultPort : Number(url.port);
  return { scheme, host, port };
}

function ruleMatches(rule: NoProxyRule, target: Target): boolean {
  switch (rule.kind) {
    case 'any':
      return true;
    case 'ip':
      return portMatches(rule.port, target.port) && target.host === rule.address;
    case 'domain':
      return (
        portMatches(rule.port, target.port) &&
        ((rule.includeApex && target.host === rule.domain) || target.host.endsWith(`.${rule.domain}`))
      );
  }
}

function portMatches(rulePort: number | undefined, targetPort: number): boolean {
  return rulePort === undefined || rulePort === targetPort;
}
