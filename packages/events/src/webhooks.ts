import { createHmac, timingSafeEqual } from 'node:crypto';
import { BpsError } from '@bax-print/core';
import type { CloudEvent } from './cloudevent.js';

/** Outbound job-status webhooks (Spec 019a): subscription checks, signing, one delivery attempt, retry schedule. */

export const WEBHOOK_MIN_SECRET_LENGTH = 16;
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;
export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_BASE_RETRY_DELAY_MS = 1_000;
export const WEBHOOK_MAX_RETRY_DELAY_MS = 3_600_000;
export const WEBHOOK_CONTENT_TYPE = 'application/cloudevents+json';
export const WEBHOOK_SIGNATURE_HEADER = 'x-bps-signature';
export const WEBHOOK_DELIVERY_ID_HEADER = 'x-bps-delivery-id';
/** Matches every event type in `WebhookSubscription.eventTypes`. */
export const WEBHOOK_ANY_EVENT_TYPE = '*';

const PLAIN_HTTP_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);
const SIGNATURE_HEX = /^[0-9a-f]{64}$/;
const TIMESTAMP_DIGITS = /^\d+$/;

export interface WebhookSubscription {
  readonly id: string;
  /** `https:` only; plain `http:` is accepted for `localhost` and `127.0.0.1`. */
  readonly url: string;
  readonly secret: string;
  /** Exact CloudEvent types, or `"*"` for all. */
  readonly eventTypes: readonly string[];
  readonly active: boolean;
}

export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface WebhookResponse {
  readonly status: number;
}

export interface WebhookDeliveryDeps {
  readonly send: (request: WebhookRequest) => Promise<WebhookResponse>;
  /** Current time in milliseconds since the Unix epoch. */
  readonly now: () => number;
}

export interface WebhookDeliveryResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
  readonly attempt: number;
}

export class InvalidWebhookSubscriptionError extends BpsError {
  constructor(message: string) {
    super('INVALID_WEBHOOK_SUBSCRIPTION', message);
  }
}

function requireNonEmptyString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw new InvalidWebhookSubscriptionError(`webhook subscription "${field}" must be a non-empty string`);
  }
  return value;
}

function isAllowedWebhookUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && PLAIN_HTTP_HOSTS.has(url.hostname);
}

function requireEventTypes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidWebhookSubscriptionError('webhook subscription "eventTypes" must be a non-empty array');
  }
  const types: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '') {
      throw new InvalidWebhookSubscriptionError('webhook subscription "eventTypes" entries must be non-empty strings');
    }
    types.push(item);
  }
  return Object.freeze(types);
}

/** Validates an untrusted value as a webhook subscription. Returns a frozen copy. */
export function validateWebhookSubscription(value: unknown): WebhookSubscription {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidWebhookSubscriptionError('webhook subscription must be an object');
  }
  const record = value as Record<string, unknown>;
  const id = requireNonEmptyString(record, 'id');
  const url = requireNonEmptyString(record, 'url');
  if (!isAllowedWebhookUrl(url)) {
    throw new InvalidWebhookSubscriptionError(
      'webhook subscription "url" must be an https URL (plain http only for localhost or 127.0.0.1)',
    );
  }
  const secret = record.secret;
  if (typeof secret !== 'string' || secret.length < WEBHOOK_MIN_SECRET_LENGTH) {
    throw new InvalidWebhookSubscriptionError(
      `webhook subscription "secret" must be a string of at least ${WEBHOOK_MIN_SECRET_LENGTH} characters`,
    );
  }
  const eventTypes = requireEventTypes(record.eventTypes);
  if (typeof record.active !== 'boolean') {
    throw new InvalidWebhookSubscriptionError('webhook subscription "active" must be a boolean');
  }
  return Object.freeze({ id, url, secret, eventTypes, active: record.active });
}

export function matchesSubscription(subscription: WebhookSubscription, event: CloudEvent): boolean {
  if (!subscription.active) return false;
  return subscription.eventTypes.some((type) => type === WEBHOOK_ANY_EVENT_TYPE || type === event.type);
}

function hmacHex(secret: string, timestampSeconds: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${body}`, 'utf8').digest('hex');
}

/** Builds the `x-bps-signature` header value: `t=<ts>,v1=<hex HMAC-SHA256 of "<ts>.<body>">`. */
export function signPayload(secret: string, timestampSeconds: number, body: string): string {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new RangeError('webhook signature timestamp must be a non-negative integer number of seconds');
  }
  return `t=${timestampSeconds},v1=${hmacHex(secret, timestampSeconds, body)}`;
}

interface ParsedSignature {
  readonly timestamp: number;
  readonly signatures: readonly string[];
}

function parseSignatureHeader(header: string): ParsedSignature | undefined {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) return undefined;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      if (timestamp !== undefined || !TIMESTAMP_DIGITS.test(value)) return undefined;
      timestamp = Number(value);
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }
  if (timestamp === undefined || !Number.isSafeInteger(timestamp) || signatures.length === 0) return undefined;
  return { timestamp, signatures };
}

/**
 * Checks a signature header against the raw body. Rejects malformed headers and timestamps
 * more than `toleranceSeconds` away from `nowSeconds` in either direction.
 */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds: number = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const parsed = parseSignatureHeader(header);
  if (parsed === undefined) return false;
  if (!(Math.abs(nowSeconds - parsed.timestamp) <= toleranceSeconds)) return false;
  const expected = Buffer.from(hmacHex(secret, parsed.timestamp, body), 'hex');
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (!SIGNATURE_HEX.test(candidate)) continue;
    if (timingSafeEqual(expected, Buffer.from(candidate, 'hex'))) matched = true;
  }
  return matched;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Makes one delivery attempt in CloudEvents structured JSON mode. Never throws: a non-2xx
 * status or a failed `send` comes back as `ok: false`. Subscription matching is the caller's job.
 */
export async function deliverWebhook(
  subscription: WebhookSubscription,
  event: CloudEvent,
  deps: WebhookDeliveryDeps,
  attempt = 1,
): Promise<WebhookDeliveryResult> {
  try {
    const body = JSON.stringify(event);
    const timestampSeconds = Math.floor(deps.now() / 1_000);
    const request: WebhookRequest = {
      url: subscription.url,
      headers: {
        'content-type': WEBHOOK_CONTENT_TYPE,
        [WEBHOOK_SIGNATURE_HEADER]: signPayload(subscription.secret, timestampSeconds, body),
        [WEBHOOK_DELIVERY_ID_HEADER]: event.id,
      },
      body,
    };
    const { status } = await deps.send(request);
    if (Number.isInteger(status) && status >= 200 && status < 300) {
      return { ok: true, status, attempt };
    }
    return { ok: false, status, error: `webhook endpoint answered HTTP ${status}`, attempt };
  } catch (error) {
    return { ok: false, error: errorMessage(error), attempt };
  }
}

/**
 * Delay before the next attempt after attempt number `attempt` (1-based) failed:
 * 1 s, 2 s, 4 s, ... capped at 1 h. Returns null once `maxAttempts` attempts have been made.
 */
export function nextRetryDelayMs(attempt: number, maxAttempts: number = WEBHOOK_MAX_ATTEMPTS): number | null {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError('webhook attempt must be a positive integer');
  }
  if (attempt >= maxAttempts) return null;
  return Math.min(WEBHOOK_BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), WEBHOOK_MAX_RETRY_DELAY_MS);
}
