import {
  DISPLAY_NAME_MAX_LENGTH,
  InvalidArgumentError,
  isRole,
  normalizeUsername,
  toPublicAccount,
  type PermissionRole,
  type PublicUserAccount,
  type UserAccount,
} from '@bax-print/core';
import type { Database } from './database.js';

/**
 * Spec 028b: user accounts (spec 028a) persisted in the job database (migration 5). Accounts
 * are checked on create and on read, so a corrupt row never reaches a caller. Only `get` and
 * `getByUsername` return password hashes; `list` returns public views.
 */

export interface UserRepository {
  /** Throws {@link UsernameTakenError} or {@link InvalidUserRecordError}. */
  create(account: UserAccount): UserAccount;
  /** Throws {@link InvalidUserRecordError} if the stored row is malformed. */
  get(id: string): UserAccount | undefined;
  /** Looks up the username normalized like core; undefined for a username core would reject. */
  getByUsername(username: string): UserAccount | undefined;
  /** Ordered by username. Never includes password hashes. */
  list(): PublicUserAccount[];
  /** False when no account has `id`. Throws {@link InvalidUserRecordError} for a malformed hash. */
  updatePasswordHash(id: string, passwordHash: string): boolean;
  /** Disables the account at `at`, or enables it for `null`. False when no account has `id`. */
  setDisabled(id: string, at: Date | null): boolean;
  delete(id: string): boolean;
}

export class InvalidUserRecordError extends Error {
  readonly code = 'USER_RECORD_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidUserRecordError';
  }
}

export class UsernameTakenError extends Error {
  readonly code = 'USERNAME_TAKEN';
  readonly username: string;

  constructor(username: string) {
    super(`username ${JSON.stringify(username)} is taken`);
    this.name = 'UsernameTakenError';
    this.username = username;
  }
}

/** Matches the timestamps core writes with `toISOString`. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** The shape of core's encoded hash, "scrypt$N$r$p$salt$hash". Core checks the details on verify. */
const ENCODED_HASH = /^scrypt\$[1-9][0-9]*\$[1-9][0-9]*\$[1-9][0-9]*\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;

const COLUMNS = 'id, username, display_name, roles_json, password_hash, created_at, disabled_at';

interface AccountFields {
  readonly id: unknown;
  readonly username: unknown;
  readonly displayName: unknown;
  readonly roles: unknown;
  readonly passwordHash: unknown;
  readonly createdAt: unknown;
  readonly disabledAt: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function isEncodedHash(value: unknown): value is string {
  return typeof value === 'string' && ENCODED_HASH.test(value);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The username as core normalizes it, or undefined when core rejects it. */
function tryNormalizeUsername(value: unknown): string | undefined {
  try {
    return normalizeUsername(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) return undefined;
    throw error;
  }
}

/** True when `value` is already a username as core normalizes it. */
function isNormalizedUsername(value: unknown): value is string {
  return typeof value === 'string' && tryNormalizeUsername(value) === value;
}

function isDisplayName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= DISPLAY_NAME_MAX_LENGTH
  );
}

function isRoleList(value: unknown): value is readonly PermissionRole[] {
  return Array.isArray(value) && value.every((role: unknown) => isRole(role));
}

/** Known roles, sorted and without duplicates, never empty: the form core gives an account. */
function toRoles(value: unknown, id: string): readonly PermissionRole[] {
  if (!isRoleList(value) || value.length === 0) {
    throw new InvalidUserRecordError(`user ${id} needs a non-empty list of known roles`);
  }
  const normalized = [...new Set(value)].sort(compareStrings);
  if (normalized.length !== value.length || !normalized.every((role, index) => role === value[index])) {
    throw new InvalidUserRecordError(`user ${id} roles must be sorted and without duplicates`);
  }
  return Object.freeze(normalized);
}

/** Checks every account field and rebuilds the account with only the known fields. */
function toAccount(fields: AccountFields): UserAccount {
  const { id, username, displayName, roles, passwordHash, createdAt, disabledAt } = fields;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new InvalidUserRecordError('user id must be a non-blank string');
  }
  if (!isNormalizedUsername(username)) {
    throw new InvalidUserRecordError(`user ${id} has an invalid username`);
  }
  if (!isDisplayName(displayName)) {
    throw new InvalidUserRecordError(`user ${id} display name must be 1-${DISPLAY_NAME_MAX_LENGTH} trimmed characters`);
  }
  const checkedRoles = toRoles(roles, id);
  if (!isEncodedHash(passwordHash)) {
    throw new InvalidUserRecordError(`user ${id} password hash is not an encoded scrypt hash`);
  }
  if (!isTimestamp(createdAt)) {
    throw new InvalidUserRecordError(`user ${id} createdAt must be an ISO 8601 timestamp`);
  }
  if (disabledAt !== undefined && !isTimestamp(disabledAt)) {
    throw new InvalidUserRecordError(`user ${id} disabledAt must be an ISO 8601 timestamp`);
  }
  const base = { id, username, displayName, roles: checkedRoles, passwordHash, createdAt };
  return Object.freeze(disabledAt === undefined ? base : { ...base, disabledAt });
}

function parseRolesJson(text: unknown, id: string): unknown {
  if (typeof text !== 'string') {
    throw new InvalidUserRecordError(`user ${id} roles_json must be text`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidUserRecordError(`user ${id} roles_json does not parse`);
  }
}

function rowToAccount(row: unknown): UserAccount {
  if (!isRecord(row)) {
    throw new InvalidUserRecordError('stored user row is malformed');
  }
  const id = typeof row.id === 'string' ? row.id : '';
  return toAccount({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roles: parseRolesJson(row.roles_json, id),
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    // SQL NULL means enabled.
    disabledAt: row.disabled_at === null ? undefined : row.disabled_at,
  });
}

function toIsoTimestamp(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new InvalidUserRecordError('disabledAt must be a valid date');
  }
  return value.toISOString();
}

/** Runs `work` in one transaction so the username check and the insert cannot interleave. */
function inTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export class SqliteUserRepository implements UserRepository {
  /** `db` must come from `openDatabase`, which applies the migrations. */
  constructor(private readonly db: Database) {}

  create(account: UserAccount): UserAccount {
    const checked = toAccount({
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      roles: account.roles,
      passwordHash: account.passwordHash,
      createdAt: account.createdAt,
      disabledAt: account.disabledAt,
    });
    return inTransaction(this.db, () => {
      const holder = this.db.prepare('SELECT id FROM users WHERE username = ?').get(checked.username);
      if (holder !== undefined) {
        throw new UsernameTakenError(checked.username);
      }
      this.db
        .prepare(`INSERT INTO users (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          checked.id,
          checked.username,
          checked.displayName,
          JSON.stringify(checked.roles),
          checked.passwordHash,
          checked.createdAt,
          checked.disabledAt ?? null,
        );
      return checked;
    });
  }

  get(id: string): UserAccount | undefined {
    const row: unknown = this.db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id);
    return row === undefined ? undefined : rowToAccount(row);
  }

  getByUsername(username: string): UserAccount | undefined {
    const normalized = tryNormalizeUsername(username);
    if (normalized === undefined) {
      return undefined;
    }
    const row: unknown = this.db.prepare(`SELECT ${COLUMNS} FROM users WHERE username = ?`).get(normalized);
    return row === undefined ? undefined : rowToAccount(row);
  }

  list(): PublicUserAccount[] {
    const rows: unknown[] = this.db.prepare(`SELECT ${COLUMNS} FROM users ORDER BY username, id`).all();
    return rows.map((row) => toPublicAccount(rowToAccount(row)));
  }

  updatePasswordHash(id: string, passwordHash: string): boolean {
    if (!isEncodedHash(passwordHash)) {
      throw new InvalidUserRecordError(`password hash for user ${id} is not an encoded scrypt hash`);
    }
    const result = this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
    return Number(result.changes) > 0;
  }

  setDisabled(id: string, at: Date | null): boolean {
    const disabledAt = at === null ? null : toIsoTimestamp(at);
    const result = this.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(disabledAt, id);
    return Number(result.changes) > 0;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}
