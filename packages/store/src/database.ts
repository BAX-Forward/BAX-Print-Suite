import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// `node:sqlite` exists only with the `node:` prefix. Loading it through createRequire keeps
// bundlers and test transformers from trying to resolve it as a package.
const loadBuiltin = createRequire(import.meta.url);

export type Database = DatabaseSync;

export const IN_MEMORY = ':memory:';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Ordered schema migrations. Never edit an applied migration: append a new one. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: 'jobs and hot folders',
    sql: `
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        priority INTEGER NOT NULL,
        hot_folder_id TEXT,
        source_sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        doc TEXT NOT NULL
      );
      CREATE INDEX jobs_queue ON jobs (status, priority DESC, created_at, id);
      CREATE INDEX jobs_lifecycle ON jobs (lifecycle, created_at, id);
      CREATE INDEX jobs_dedupe ON jobs (hot_folder_id, source_sha256);
      CREATE TABLE hot_folders (
        id TEXT PRIMARY KEY,
        path_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        doc TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'webhook subscriptions',
    sql: `
      CREATE TABLE webhook_subscriptions (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        event_types TEXT NOT NULL,
        active INTEGER NOT NULL,
        secret TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'layout templates',
    sql: `
      CREATE TABLE layout_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        roll_width_mm REAL NOT NULL,
        layout_json TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: 'finishing plans',
    sql: `
      CREATE TABLE finishing_plans (
        job_id TEXT PRIMARY KEY,
        plan_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX finishing_plans_updated ON finishing_plans (updated_at, job_id);
    `,
  },
]);

function applyMigrations(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(appliedMigrations(db));
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** Versions of all applied migrations, ascending. */
export function appliedMigrations(db: DatabaseSync): number[] {
  return (
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
      version: number | bigint;
    }>
  ).map((row) => Number(row.version));
}

const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;
/** SQLite gives these the main file's mode when it creates them. */
const SIDE_FILE_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Narrows an existing file to 0600 if this process owns it; leaves files of other users alone. */
function restrictOwnedFile(path: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  if (stats.uid === process.getuid?.() && (stats.mode & PERMISSION_BITS) !== PRIVATE_FILE_MODE) {
    chmodSync(path, PRIVATE_FILE_MODE);
  }
}

/**
 * Spec 019d: makes the database file readable by its owner only, before `openDatabase` opens it.
 * Creates a missing file with mode 0600 and narrows an existing file this process owns (and its
 * WAL, shared-memory and journal files) to 0600. No-op for `:memory:` and on Windows.
 */
export function preparePrivateDatabaseFile(location: string): void {
  if (location === IN_MEMORY || process.platform === 'win32') {
    return;
  }
  const path = resolve(location);
  mkdirSync(dirname(path), { recursive: true });
  try {
    closeSync(openSync(path, 'wx', PRIVATE_FILE_MODE));
  } catch (error) {
    if (!isErrorCode(error, 'EEXIST')) throw error;
  }
  for (const file of [path, ...SIDE_FILE_SUFFIXES.map((suffix) => path + suffix)]) {
    restrictOwnedFile(file);
  }
}

/** Opens (creating if needed) a SQLite database and brings its schema up to date. */
export function openDatabase(location: string = IN_MEMORY): DatabaseSync {
  const { DatabaseSync: DatabaseConstructor } = loadBuiltin('node:sqlite') as typeof import('node:sqlite');
  const path = location === IN_MEMORY ? IN_MEMORY : resolve(location);
  if (path !== IN_MEMORY) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseConstructor(path);
  if (path !== IN_MEMORY) {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA busy_timeout = 5000');
  applyMigrations(db);
  return db;
}
