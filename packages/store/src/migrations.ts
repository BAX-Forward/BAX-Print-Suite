import type { DatabaseSync } from './sqlite.js';

const appendOnly = (table: string): string => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
`;

/** Ordered schema migrations. Never edit a released entry; append a new one. */
export const MEDIA_MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  archived INTEGER NOT NULL,
  device_profile TEXT,
  device_medium_key TEXT,
  data TEXT NOT NULL
);
CREATE INDEX media_device_ref ON media (device_profile, device_medium_key);

CREATE TABLE output_modes (
  id TEXT PRIMARY KEY,
  medium_id TEXT NOT NULL,
  device_profile TEXT NOT NULL,
  mode_key TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (medium_id, device_profile, mode_key)
);

CREATE TABLE color_setups (
  id TEXT PRIMARY KEY,
  medium_id TEXT NOT NULL,
  output_mode_id TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL
);

CREATE TABLE color_setup_revisions (
  id TEXT PRIMARY KEY,
  color_setup_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (color_setup_id, seq)
);
${appendOnly('color_setup_revisions')}

CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  medium_id TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE profiles (
  sha256 TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  bytes BLOB NOT NULL
);

CREATE TABLE profiling_sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE profiling_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  bytes BLOB NOT NULL
);
CREATE INDEX profiling_artifacts_session ON profiling_artifacts (session_id, seq);
${appendOnly('profiling_artifacts')}

CREATE TABLE job_color_bindings (
  job_id TEXT PRIMARY KEY,
  medium_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX job_color_bindings_medium ON job_color_bindings (medium_id);
${appendOnly('job_color_bindings')}
`,
  },
];

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS media_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS version FROM media_schema_migrations').get() as unknown as
    | { version: number | null }
    | undefined;
  const current = row?.version ?? 0;
  for (const migration of MEDIA_MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO media_schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
