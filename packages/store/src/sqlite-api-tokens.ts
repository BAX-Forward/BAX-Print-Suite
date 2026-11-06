import { isPermission, type ApiTokenRecord, type Permission } from '@bax-print/core';
import type { Database } from './database.js';

/**
 * Spec 029b: API token records (spec 029a) persisted in the job database (migration 6). Only
 * the record fields are stored: the secret never reaches the store, just its SHA-256 hash.
 * Records are checked on save and on read, so a corrupt row never reaches a caller.
 * A token may belong to a user; deleting the user deletes their tokens.
 */

export interface ApiTokenRepository {
  /**
   * Inserts a new record, optionally owned by `userId`. Throws {@link InvalidApiTokenRecordError},
   * {@link ApiTokenConflictError} or {@link ApiTokenUserNotFoundError}.
   */
  save(record: ApiTokenRecord, userId?: string): ApiTokenRecord;
  /** Throws {@link InvalidApiTokenRecordError} if the stored row is malformed. */
  get(id: string): ApiTokenRecord | undefined;
  /** Candidates for core `verifyApiToken`, including revoked and expired tokens. */
  findByPrefix(prefix: string): ApiTokenRecord[];
  /** Tokens owned by `userId`, oldest first. */
  listForUser(userId: string): ApiTokenRecord[];
  /** All tokens, oldest first. */
  list(): ApiTokenRecord[];
  /** Revokes the token at `at`; revoking twice keeps the first time. False when no token has `id`. */
  revoke(id: string, at: Date): boolean;
  delete(id: string): boolean;
}

export class InvalidApiTokenRecordError extends Error {
  readonly code = 'API_TOKEN_RECORD_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidApiTokenRecordError';
  }
}

export class ApiTokenConflictError extends Error {
  readonly code = 'API_TOKEN_CONFLICT';
  readonly id: string;

  constructor(id: string) {
    super(`API token ${id} or its secret hash is already stored`);
    this.name = 'ApiTokenConflictError';
    this.id = id;
  }
}

export class ApiTokenUserNotFoundError extends Error {
  readonly code = 'API_TOKEN_USER_NOT_FOUND';
  readonly userId: string;

  constructor(userId: string) {
    super(`user ${userId} does not exist`);
    this.name = 'ApiTokenUserNotFoundError';
    this.userId = userId;
  }
}

/** Matches the timestamps core writes with `toISOString`. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** Core's display prefix: the first 8 base64url characters of the secret body. */
const TOKEN_PREFIX = /^[A-Za-z0-9_-]{8}$/;
/** SHA-256 as lowercase hex, the form core stores. */
const SECRET_HASH = /^[0-9a-f]{64}$/;
/** Core's limit for a token name. */
const NAME_MAX_LENGTH = 100;

const COLUMNS = 'id, name, prefix, secret_hash, scopes_json, created_at, expires_at, revoked_at';
const ORDER = 'ORDER BY created_at, id';

interface RecordFields {
  readonly id: unknown;
  readonly name: unknown;
  readonly prefix: unknown;
  readonly secretHash: unknown;
  readonly scopes: unknown;
  readonly createdAt: unknown;
  readonly expiresAt: unknown;
  readonly revokedAt: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isTokenName(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= NAME_MAX_LENGTH
  );
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function isPermissionList(value: unknown): value is readonly Permission[] {
  return Array.isArray(value) && value.every((scope: unknown) => isPermission(scope));
}

/** Known permissions, sorted and without duplicates, never empty: the form core gives a record. */
function toScopes(value: unknown, id: string): readonly Permission[] {
  if (!isPermissionList(value) || value.length === 0) {
    throw new InvalidApiTokenRecordError(`API token ${id} needs a non-empty list of known scopes`);
  }
  const normalized = [...new Set(value)].sort(compareStrings);
  if (normalized.length !== value.length || !normalized.every((scope, index) => scope === value[index])) {
    throw new InvalidApiTokenRecordError(`API token ${id} scopes must be sorted and without duplicates`);
  }
  return Object.freeze(normalized);
}

function optionalTimestamp(value: unknown, id: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isTimestamp(value)) {
    throw new InvalidApiTokenRecordError(`API token ${id} ${field} must be an ISO 8601 timestamp`);
  }
  return value;
}

/** Checks every record field and rebuilds the record with only the known fields. */
function toRecord(fields: RecordFields): ApiTokenRecord {
  const { id, name, prefix, secretHash, scopes, createdAt } = fields;
  if (!isNonBlank(id)) {
    throw new InvalidApiTokenRecordError('API token id must be a non-blank string');
  }
  if (!isTokenName(name)) {
    throw new InvalidApiTokenRecordError(`API token ${id} name must be 1-${NAME_MAX_LENGTH} trimmed characters`);
  }
  if (typeof prefix !== 'string' || !TOKEN_PREFIX.test(prefix)) {
    throw new InvalidApiTokenRecordError(`API token ${id} prefix must be 8 base64url characters`);
  }
  if (typeof secretHash !== 'string' || !SECRET_HASH.test(secretHash)) {
    throw new InvalidApiTokenRecordError(`API token ${id} secret hash must be 64 lowercase hex characters`);
  }
  const checkedScopes = toScopes(scopes, id);
  if (!isTimestamp(createdAt)) {
    throw new InvalidApiTokenRecordError(`API token ${id} createdAt must be an ISO 8601 timestamp`);
  }
  const expiresAt = optionalTimestamp(fields.expiresAt, id, 'expiresAt');
  const revokedAt = optionalTimestamp(fields.revokedAt, id, 'revokedAt');
  return Object.freeze({
    id,
    name,
    prefix,
    secretHash,
    scopes: checkedScopes,
    createdAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  });
}

function parseScopesJson(text: unknown, id: string): unknown {
  if (typeof text !== 'string') {
    throw new InvalidApiTokenRecordError(`API token ${id} scopes_json must be text`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidApiTokenRecordError(`API token ${id} scopes_json does not parse`);
  }
}

function rowToRecord(row: unknown): ApiTokenRecord {
  if (!isRecord(row)) {
    throw new InvalidApiTokenRecordError('stored API token row is malformed');
  }
  const id = typeof row.id === 'string' ? row.id : '';
  return toRecord({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    secretHash: row.secret_hash,
    scopes: parseScopesJson(row.scopes_json, id),
    createdAt: row.created_at,
    // SQL NULL means no expiry and not revoked.
    expiresAt: row.expires_at === null ? undefined : row.expires_at,
    revokedAt: row.revoked_at === null ? undefined : row.revoked_at,
  });
}

function toIsoTimestamp(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new InvalidApiTokenRecordError('revokedAt must be a valid date');
  }
  return value.toISOString();
}

/** Runs `work` in one transaction so the conflict checks and the insert cannot interleave. */
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

export class SqliteApiTokenRepository implements ApiTokenRepository {
  /** `db` must come from `openDatabase`, which applies the migrations and enables foreign keys. */
  constructor(private readonly db: Database) {}

  save(record: ApiTokenRecord, userId?: string): ApiTokenRecord {
    const checked = toRecord({
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      secretHash: record.secretHash,
      scopes: record.scopes,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      revokedAt: record.revokedAt,
    });
    if (userId !== undefined && !isNonBlank(userId)) {
      throw new InvalidApiTokenRecordError(`API token ${checked.id} user id must be a non-blank string`);
    }
    return inTransaction(this.db, () => {
      const holder = this.db
        .prepare('SELECT id FROM api_tokens WHERE id = ? OR secret_hash = ?')
        .get(checked.id, checked.secretHash);
      if (holder !== undefined) {
        throw new ApiTokenConflictError(checked.id);
      }
      if (userId !== undefined && this.db.prepare('SELECT id FROM users WHERE id = ?').get(userId) === undefined) {
        throw new ApiTokenUserNotFoundError(userId);
      }
      this.db
        .prepare(`INSERT INTO api_tokens (${COLUMNS}, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          checked.id,
          checked.name,
          checked.prefix,
          checked.secretHash,
          JSON.stringify(checked.scopes),
          checked.createdAt,
          checked.expiresAt ?? null,
          checked.revokedAt ?? null,
          userId ?? null,
        );
      return checked;
    });
  }

  get(id: string): ApiTokenRecord | undefined {
    const row: unknown = this.db.prepare(`SELECT ${COLUMNS} FROM api_tokens WHERE id = ?`).get(id);
    return row === undefined ? undefined : rowToRecord(row);
  }

  findByPrefix(prefix: string): ApiTokenRecord[] {
    const rows: unknown[] = this.db.prepare(`SELECT ${COLUMNS} FROM api_tokens WHERE prefix = ? ${ORDER}`).all(prefix);
    return rows.map((row) => rowToRecord(row));
  }

  listForUser(userId: string): ApiTokenRecord[] {
    const rows: unknown[] = this.db.prepare(`SELECT ${COLUMNS} FROM api_tokens WHERE user_id = ? ${ORDER}`).all(userId);
    return rows.map((row) => rowToRecord(row));
  }

  list(): ApiTokenRecord[] {
    const rows: unknown[] = this.db.prepare(`SELECT ${COLUMNS} FROM api_tokens ${ORDER}`).all();
    return rows.map((row) => rowToRecord(row));
  }

  revoke(id: string, at: Date): boolean {
    const revokedAt = toIsoTimestamp(at);
    const result = this.db
      .prepare('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
      .run(revokedAt, id);
    return Number(result.changes) > 0;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}
