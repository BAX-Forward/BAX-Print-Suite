import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Actor, Role } from './actor.js';
import { InvalidArgumentError } from './errors.js';
import { newId } from './ids.js';
import { type PermissionRole, parseRole } from './permissions.js';

/**
 * User accounts and password hashing (spec 028a). Pure apart from the
 * randomness and CPU cost of scrypt; storage, sessions and routes live elsewhere.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 64;
export const DISPLAY_NAME_MAX_LENGTH = 128;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

const USERNAME_PATTERN = /^[a-z0-9._-]+$/;

/** scrypt cost parameters. N must be a power of two greater than 1. */
export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export const SCRYPT_N = 2 ** 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_SALT_BYTES = 16;
export const SCRYPT_KEY_BYTES = 32;
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = Object.freeze({ N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });

/** Bounds for parameters read from a stored hash, so a corrupt record cannot demand unbounded work. */
const SCRYPT_MAX_N = 2 ** 16;
const SCRYPT_MAX_R = 16;
const SCRYPT_MAX_P = 4;
const MIN_ENCODED_BYTES = 16;
const MAX_ENCODED_BYTES = 64;
const SCHEME = 'scrypt';
const ENCODED_FIELDS = 6;
const DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface UserAccount {
  readonly id: string;
  /** Lowercase, 3-64 characters of [a-z0-9._-]. */
  readonly username: string;
  readonly displayName: string;
  /** Sorted, without duplicates, never empty. */
  readonly roles: readonly PermissionRole[];
  /** Encoded as produced by hashPassword. Never send to clients; see toPublicAccount. */
  readonly passwordHash: string;
  /** ISO 8601 timestamp. */
  readonly createdAt: string;
  /** ISO 8601 timestamp; present when the account may not sign in. */
  readonly disabledAt?: string;
}

/** An account without its password hash, safe to expose over the API. */
export type PublicUserAccount = Omit<UserAccount, 'passwordHash'>;

export interface CreateUserAccountInput {
  readonly username: string;
  readonly displayName: string;
  readonly roles: readonly PermissionRole[];
  readonly passwordHash: string;
  readonly disabledAt?: Date;
}

export type PasswordPolicyReason = 'too_short' | 'too_long' | 'matches_username';

export interface PasswordPolicyResult {
  readonly ok: boolean;
  readonly reasons: readonly PasswordPolicyReason[];
}

export interface HashPasswordOptions {
  /** Defaults to DEFAULT_SCRYPT_PARAMS. Lower values are for tests only. */
  readonly params?: ScryptParams;
}

/** Trims and lowercases a username, then validates it. */
export function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError('username must be a string');
  }
  const username = value.trim().toLowerCase();
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    throw new InvalidArgumentError(
      `username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters`,
    );
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new InvalidArgumentError('username may contain only a-z, 0-9, ".", "_" and "-"');
  }
  return username;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError('displayName must be a string');
  }
  const displayName = value.trim();
  if (displayName.length === 0 || displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new InvalidArgumentError(`displayName must be 1-${DISPLAY_NAME_MAX_LENGTH} characters`);
  }
  return displayName;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function normalizeRoles(value: readonly unknown[]): readonly PermissionRole[] {
  if (value.length === 0) {
    throw new InvalidArgumentError('an account needs at least one role');
  }
  const roles = [...new Set(value.map((role) => parseRole(role)))].sort(compareStrings);
  return Object.freeze(roles);
}

function toIsoTimestamp(value: Date, field: string): string {
  if (Number.isNaN(value.getTime())) {
    throw new InvalidArgumentError(`${field} must be a valid date`);
  }
  return value.toISOString();
}

export function createUserAccount(input: CreateUserAccountInput, now: Date): UserAccount {
  const createdAt = toIsoTimestamp(now, 'now');
  if (parseEncodedHash(input.passwordHash) === undefined) {
    throw new InvalidArgumentError('passwordHash must be an encoded scrypt hash');
  }
  const base = {
    id: newId(now.getTime()),
    username: normalizeUsername(input.username),
    displayName: normalizeDisplayName(input.displayName),
    roles: normalizeRoles(input.roles),
    passwordHash: input.passwordHash,
    createdAt,
  };
  const account: UserAccount =
    input.disabledAt === undefined
      ? base
      : { ...base, disabledAt: toIsoTimestamp(input.disabledAt, 'disabledAt') };
  return Object.freeze(account);
}

/** The account without its password hash. Builds a new object field by field. */
export function toPublicAccount(account: UserAccount): PublicUserAccount {
  const base = {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    roles: Object.freeze([...account.roles]),
    createdAt: account.createdAt,
  };
  return Object.freeze(account.disabledAt === undefined ? base : { ...base, disabledAt: account.disabledAt });
}

/** Checks a candidate password; length is counted in Unicode code points. */
export function checkPasswordPolicy(password: string, username?: string): PasswordPolicyResult {
  const reasons: PasswordPolicyReason[] = [];
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) reasons.push('too_short');
  if (length > PASSWORD_MAX_LENGTH) reasons.push('too_long');
  if (username !== undefined && password.trim().toLowerCase() === username.trim().toLowerCase()) {
    reasons.push('matches_username');
  }
  return Object.freeze({ ok: reasons.length === 0, reasons: Object.freeze(reasons) });
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 1 && (value & (value - 1)) === 0;
}

function isValidParams(params: ScryptParams): boolean {
  return (
    isPowerOfTwo(params.N) &&
    params.N <= SCRYPT_MAX_N &&
    Number.isInteger(params.r) &&
    params.r >= 1 &&
    params.r <= SCRYPT_MAX_R &&
    Number.isInteger(params.p) &&
    params.p >= 1 &&
    params.p <= SCRYPT_MAX_P
  );
}

function deriveKey(password: string, salt: Buffer, keyLength: number, params: ScryptParams): Promise<Buffer> {
  // Node's default maxmem (32 MiB) is too small for N=2^15, r=8; allow twice the working set.
  const maxmem = 2 * 128 * params.N * params.r;
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: params.N, r: params.r, p: params.p, maxmem }, (error, key) => {
      if (error !== null) reject(error);
      else resolve(key);
    });
  });
}

/** Hashes a password as "scrypt$N$r$p$salt$hash" with base64url salt and hash. */
export async function hashPassword(password: string, options: HashPasswordOptions = {}): Promise<string> {
  if (password.length === 0) {
    throw new InvalidArgumentError('password must be a non-empty string');
  }
  const params = options.params ?? DEFAULT_SCRYPT_PARAMS;
  if (!isValidParams(params)) {
    throw new InvalidArgumentError('invalid scrypt parameters');
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await deriveKey(password, salt, SCRYPT_KEY_BYTES, params);
  return [SCHEME, params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseDecimal(value: string | undefined): number | undefined {
  return value !== undefined && DECIMAL_PATTERN.test(value) ? Number(value) : undefined;
}

function parseBase64url(value: string | undefined): Buffer | undefined {
  if (value === undefined || !BASE64URL_PATTERN.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  // Reject non-canonical encodings that Buffer would silently accept.
  if (bytes.toString('base64url') !== value) return undefined;
  if (bytes.length < MIN_ENCODED_BYTES || bytes.length > MAX_ENCODED_BYTES) return undefined;
  return bytes;
}

function parseEncodedHash(encoded: unknown): ParsedHash | undefined {
  if (typeof encoded !== 'string') return undefined;
  const fields = encoded.split('$');
  if (fields.length !== ENCODED_FIELDS) return undefined;
  const [scheme, n, r, p, salt, key] = fields;
  if (scheme !== SCHEME) return undefined;
  const N = parseDecimal(n);
  const rValue = parseDecimal(r);
  const pValue = parseDecimal(p);
  const saltBytes = parseBase64url(salt);
  const keyBytes = parseBase64url(key);
  if (
    N === undefined ||
    rValue === undefined ||
    pValue === undefined ||
    saltBytes === undefined ||
    keyBytes === undefined
  ) {
    return undefined;
  }
  const params: ScryptParams = { N, r: rValue, p: pValue };
  if (!isValidParams(params)) return undefined;
  return { params, salt: saltBytes, key: keyBytes };
}

/** True when the password matches the encoded hash. Never throws; malformed input yields false. */
export async function verifyPassword(password: unknown, encoded: unknown): Promise<boolean> {
  if (typeof password !== 'string') return false;
  const parsed = parseEncodedHash(encoded);
  if (parsed === undefined) return false;
  try {
    const key = await deriveKey(password, parsed.salt, parsed.key.length, parsed.params);
    return timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
}

/** True when the hash is malformed or was made with other parameters or sizes than `params`. */
export function needsRehash(encoded: unknown, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): boolean {
  const parsed = parseEncodedHash(encoded);
  if (parsed === undefined) return true;
  return (
    parsed.params.N !== params.N ||
    parsed.params.r !== params.r ||
    parsed.params.p !== params.p ||
    parsed.salt.length !== SCRYPT_SALT_BYTES ||
    parsed.key.length !== SCRYPT_KEY_BYTES
  );
}

/**
 * Actor role for each account role. The actor model has no designer role;
 * designer maps down to viewer so that it never gains operator-only writes.
 */
const ACTOR_ROLE: Readonly<Record<PermissionRole, Role>> = Object.freeze({
  admin: 'admin',
  designer: 'viewer',
  operator: 'operator',
  viewer: 'viewer',
});

const ACTOR_RANK: Readonly<Record<Role, number>> = Object.freeze({ viewer: 0, operator: 1, admin: 2 });

/** The core Actor for an enabled account, using its highest mapped role. */
export function accountToActor(account: UserAccount): Actor {
  if (account.disabledAt !== undefined) {
    throw new InvalidArgumentError(`account ${account.id} is disabled`);
  }
  let role: Role | undefined;
  for (const accountRole of account.roles) {
    const mapped = ACTOR_ROLE[parseRole(accountRole)];
    if (role === undefined || ACTOR_RANK[mapped] > ACTOR_RANK[role]) role = mapped;
  }
  if (role === undefined) {
    throw new InvalidArgumentError(`account ${account.id} has no roles`);
  }
  return Object.freeze({ id: account.id, role });
}
