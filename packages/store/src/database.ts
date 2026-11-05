import { mkdirSync } from 'node:fs';
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
