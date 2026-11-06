import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { InvalidArgumentError } from './errors.js';
import { newId } from './ids.js';
import { type Permission, parsePermission } from './permissions.js';

/**
 * API token model (spec 029a). A token secret is shown once at issue time;
 * the stored record keeps only a SHA-256 hash of it, never the secret.
 */

export const API_TOKEN_PREFIX = 'bps_';
const SECRET_BYTES = 32;
/** Length of 32 bytes in unpadded base64url. */
const SECRET_BODY_LENGTH = 43;
const DISPLAY_PREFIX_LENGTH = 8;
const MAX_NAME_LENGTH = 100;
const SECRET_PATTERN = /^bps_[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface ApiTokenRecord {
  readonly id: string;
  readonly name: string;
  /** First characters of the secret after `bps_`, for display and lookup. */
  readonly prefix: string;
  /** SHA-256 of the full secret, lowercase hex. */
  readonly secretHash: string;
  /** Validated permissions, sorted and without duplicates. Never empty. */
  readonly scopes: readonly Permission[];
  /** ISO 8601 timestamps. */
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

export interface IssueApiTokenInput {
  name: string;
  scopes: readonly Permission[];
  expiresAt?: Date;
  now: Date;
}

export interface IssuedApiToken {
  /** The full secret. Show it once; it cannot be recovered from the record. */
  readonly secret: string;
  readonly record: ApiTokenRecord;
}

export type ApiTokenRejection = 'malformed' | 'mismatch' | 'revoked' | 'expired';

export type ApiTokenVerification =
  | { readonly ok: true; readonly record: ApiTokenRecord }
  | { readonly ok: false; readonly reason: ApiTokenRejection };

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function requireDate(value: unknown, field: string): Date {
  if (!isValidDate(value)) {
    throw new InvalidArgumentError(`${field} must be a valid Date`);
  }
  return value;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError('token name must be a string');
  }
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new InvalidArgumentError(`token name must be 1 to ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

function parseScopes(value: unknown): readonly Permission[] {
  if (!Array.isArray(value)) {
    throw new InvalidArgumentError('token scopes must be an array');
  }
  const scopes = new Set<Permission>();
  for (const scope of value) scopes.add(parsePermission(scope));
  if (scopes.size === 0) {
    throw new InvalidArgumentError('token scopes must not be empty');
  }
  return Object.freeze([...scopes].sort(compareStrings));
}

/** Issues a new token. Throws InvalidArgumentError on invalid input. */
export function issueApiToken(input: IssueApiTokenInput): IssuedApiToken {
  const now = requireDate(input.now, 'now');
  const name = parseName(input.name);
  const scopes = parseScopes(input.scopes);
  let expiresAt: string | undefined;
  if (input.expiresAt !== undefined) {
    const expiry = requireDate(input.expiresAt, 'expiresAt');
    if (expiry.getTime() <= now.getTime()) {
      throw new InvalidArgumentError('expiresAt must be after now');
    }
    expiresAt = expiry.toISOString();
  }

  const body = randomBytes(SECRET_BYTES).toString('base64url');
  const secret = API_TOKEN_PREFIX + body;
  const record: ApiTokenRecord = Object.freeze({
    id: newId(now.getTime()),
    name,
    prefix: body.slice(0, DISPLAY_PREFIX_LENGTH),
    secretHash: hashSecret(secret),
    scopes,
    createdAt: now.toISOString(),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  return Object.freeze({ secret, record });
}

/** Parses an optional ISO timestamp; NaN marks a malformed value. */
function timestampOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function reject(reason: ApiTokenRejection): ApiTokenVerification {
  return { ok: false, reason };
}

/**
 * Checks a presented secret against a stored record. Never throws: bad input
 * yields `malformed`. The hash is compared before revocation and expiry so a
 * wrong secret learns nothing about the token's state. A token is expired
 * from its `expiresAt` instant onward.
 */
export function verifyApiToken(secret: unknown, record: ApiTokenRecord, now: Date): ApiTokenVerification {
  if (typeof secret !== 'string' || secret.length !== API_TOKEN_PREFIX.length + SECRET_BODY_LENGTH) {
    return reject('malformed');
  }
  if (!SECRET_PATTERN.test(secret) || !isValidDate(now)) return reject('malformed');
  const storedHash: unknown = record.secretHash;
  if (typeof storedHash !== 'string' || !HASH_PATTERN.test(storedHash)) return reject('malformed');
  const revokedAt = timestampOf(record.revokedAt);
  const expiresAt = timestampOf(record.expiresAt);
  if (Number.isNaN(revokedAt) || Number.isNaN(expiresAt)) return reject('malformed');

  const presented = Buffer.from(hashSecret(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (!timingSafeEqual(presented, stored)) return reject('mismatch');
  if (revokedAt !== undefined) return reject('revoked');
  if (expiresAt !== undefined && now.getTime() >= expiresAt) return reject('expired');
  return { ok: true, record };
}

/** Returns a revoked copy of the record. Revoking twice keeps the first time. */
export function revokeApiToken(record: ApiTokenRecord, now: Date): ApiTokenRecord {
  const at = requireDate(now, 'now');
  if (record.revokedAt !== undefined) return record;
  return Object.freeze({ ...record, revokedAt: at.toISOString() });
}
