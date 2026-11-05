import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { BpsError } from '@bax-print/core';
import type { WebhookRequest, WebhookResponse } from './webhooks.js';

/**
 * Outbound webhook target checks (Spec 019c). A subscription URL may not point at loopback,
 * link-local, unspecified or private addresses; hostnames are resolved and rejected if any
 * answer is blocked. The delivery path connects to the vetted address, so a second DNS answer
 * cannot swap in a different one.
 */

/** The error a blocked delivery attempt records; such an attempt is not retried. */
export const WEBHOOK_BLOCKED_DESTINATION = 'blocked-destination';

/** Hosts allowed for local development regardless of the address checks. */
const DEV_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

const IPV4_OCTETS = 4;
const IPV6_HEXTETS = 8;
const HEXTET = /^[0-9a-f]{1,4}$/i;
const DECIMAL_OCTET = /^\d{1,3}$/;

/**
 * - `public`: any address not listed below;
 * - `private`: 10/8, 172.16/12, 192.168/16, fc00::/7 (allowed with `allowLan`);
 * - `loopback`: 127/8, ::1; `link-local`: 169.254/16, fe80::/10; `unspecified`: 0.0.0.0/8, ::;
 * - `invalid`: not an IP address.
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) take the class of the embedded IPv4 address.
 */
export type AddressClass = 'public' | 'private' | 'loopback' | 'link-local' | 'unspecified' | 'invalid';

export interface WebhookTargetPolicy {
  /** Every address `host` resolves to. Injected in tests; see `resolveAllAddresses`. */
  readonly resolve: (host: string) => Promise<string[]>;
  /** Allow the private ranges (not loopback or link-local). */
  readonly allowLan: boolean;
}

/** A checked target: connect to `address`, never to a fresh resolution of `url.hostname`. */
export interface VettedWebhookTarget {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
}

export type WebhookTargetCheck =
  | { readonly ok: true; readonly target: VettedWebhookTarget }
  | { readonly ok: false; readonly reason: string };

/** Sends one request to an already vetted target. */
export type WebhookTransport = (request: WebhookRequest, target: VettedWebhookTarget) => Promise<WebhookResponse>;

export class BlockedWebhookDestinationError extends BpsError {
  constructor(message: string) {
    super('BLOCKED_WEBHOOK_DESTINATION', message);
  }
}

function parseIpv4(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== IPV4_OCTETS) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!DECIMAL_OCTET.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

/** The eight 16-bit groups of an IPv6 address, or undefined when `text` is not one. */
function parseIpv6(text: string): number[] | undefined {
  const zone = text.indexOf('%');
  const address = zone >= 0 ? text.slice(0, zone) : text;
  let head = address;
  const tail: number[] = [];
  const lastColon = address.lastIndexOf(':');
  const last = address.slice(lastColon + 1);
  if (last.includes('.')) {
    const ipv4 = parseIpv4(last);
    if (ipv4 === undefined) return undefined;
    tail.push(Math.floor(ipv4 / 0x10000), ipv4 % 0x10000);
    const withColon = address.slice(0, lastColon + 1);
    head = withColon.endsWith('::') ? withColon : address.slice(0, lastColon);
  }
  const halves = head.split('::');
  if (halves.length > 2) return undefined;
  const groups = (half: string | undefined): string[] => (half === undefined || half === '' ? [] : half.split(':'));
  const left = groups(halves[0]);
  const right = groups(halves[1]);
  if (![...left, ...right].every((group) => HEXTET.test(group))) return undefined;
  const missing = IPV6_HEXTETS - left.length - right.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const hex = (group: string): number => Number.parseInt(group, 16);
  return [...left.map(hex), ...new Array<number>(Math.max(missing, 0)).fill(0), ...right.map(hex), ...tail];
}

function classifyIpv4(value: number): AddressClass {
  const a = Math.floor(value / 0x1000000);
  const b = Math.floor(value / 0x10000) % 256;
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  return 'public';
}

function classifyIpv6(groups: readonly number[]): AddressClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (upperZero && g5 === 0xffff) return classifyIpv4(g6 * 0x10000 + g7);
  if (upperZero && g5 === 0 && g6 === 0) {
    if (g7 === 0) return 'unspecified';
    if (g7 === 1) return 'loopback';
  }
  if ((g0 & 0xfe00) === 0xfc00) return 'private';
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local';
  return 'public';
}

export function classifyAddress(ip: string): AddressClass {
  const version = isIP(ip);
  if (version === 4) {
    const value = parseIpv4(ip);
    return value === undefined ? 'invalid' : classifyIpv4(value);
  }
  if (version === 6) {
    const groups = parseIpv6(ip);
    return groups === undefined ? 'invalid' : classifyIpv6(groups);
  }
  return 'invalid';
}

/** True for every address a webhook may not reach by default, and for anything that is not an IP address. */
export function isBlockedAddress(ip: string): boolean {
  return classifyAddress(ip) !== 'public';
}

function isAllowedAddress(ip: string, allowLan: boolean): boolean {
  const kind = classifyAddress(ip);
  return kind === 'public' || (allowLan && kind === 'private');
}

function familyOf(ip: string): 4 | 6 {
  return isIP(ip) === 6 ? 6 : 4;
}

function vetted(url: URL, address: string): WebhookTargetCheck {
  return { ok: true, target: { url, address, family: familyOf(address) } };
}

/**
 * Checks a webhook URL. Literal IPs are checked directly; hostnames are resolved and rejected
 * when there is no answer or ANY answer is blocked. `localhost` (when every answer is loopback)
 * and `127.0.0.1` stay allowed for development. Resolver failures propagate.
 */
export async function checkWebhookTarget(url: string, policy: WebhookTargetPolicy): Promise<WebhookTargetCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'webhook target is not a valid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'webhook target must be an http or https URL' };
  }
  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const isDevHost = DEV_HOSTS.has(host);

  if (isIP(host) !== 0) {
    if (isDevHost || isAllowedAddress(host, policy.allowLan)) return vetted(parsed, host);
    return { ok: false, reason: `webhook target ${host} is a blocked address` };
  }

  const addresses = await policy.resolve(host);
  const [first] = addresses;
  if (first === undefined) return { ok: false, reason: `webhook target ${host} did not resolve to any address` };
  const allowed = (address: string): boolean =>
    isDevHost ? classifyAddress(address) === 'loopback' : isAllowedAddress(address, policy.allowLan);
  const blocked = addresses.find((address) => !allowed(address));
  if (blocked !== undefined) return { ok: false, reason: `webhook target ${host} resolves to a blocked address (${blocked})` };
  return vetted(parsed, first);
}

/** Wraps a transport so every request is checked first; a blocked target throws {@link BlockedWebhookDestinationError}. */
export function guardedWebhookSend(
  transport: WebhookTransport,
  policy: WebhookTargetPolicy,
): (request: WebhookRequest) => Promise<WebhookResponse> {
  return async (request) => {
    const check = await checkWebhookTarget(request.url, policy);
    if (!check.ok) throw new BlockedWebhookDestinationError(check.reason);
    return transport(request, check.target);
  };
}

/** A socket `lookup` that answers with the vetted address only, whatever host is asked for. */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** Every address the system resolver returns for `host`. */
export async function resolveAllAddresses(host: string): Promise<string[]> {
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}
