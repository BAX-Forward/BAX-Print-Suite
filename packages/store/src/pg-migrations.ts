/**
 * Spec 027b: PostgreSQL DDL texts for the job store schema.
 *
 * Not executed in this build. These texts mirror sqlite `MIGRATIONS` versions 1-4 in
 * database.ts with the same table, column, index and constraint names, translated to
 * PostgreSQL types. Version 5 (spec 027h) mirrors the media store's sqlite MEDIA_MIGRATIONS
 * version 1. No connection is opened and no driver is loaded here.
 */

export interface PgMigration {
  readonly version: number;
  readonly sql: string;
}

/** Ordered PostgreSQL migrations. Never edit an applied migration: append a new one. */
export const PG_MIGRATIONS: readonly PgMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    sql: `
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        priority BIGINT NOT NULL,
        hot_folder_id TEXT,
        source_sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        doc JSONB NOT NULL
      );
      CREATE INDEX jobs_queue ON jobs (status, priority DESC, created_at, id);
      CREATE INDEX jobs_lifecycle ON jobs (lifecycle, created_at, id);
      CREATE INDEX jobs_dedupe ON jobs (hot_folder_id, source_sha256);
      CREATE TABLE hot_folders (
        id TEXT PRIMARY KEY,
        path_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        doc JSONB NOT NULL
      );
    `,
  }),
  Object.freeze({
    version: 2,
    sql: `
      CREATE TABLE webhook_subscriptions (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        event_types TEXT NOT NULL,
        active BOOLEAN NOT NULL,
        secret TEXT NOT NULL
      );
    `,
  }),
  Object.freeze({
    version: 3,
    sql: `
      CREATE TABLE layout_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        roll_width_mm DOUBLE PRECISION NOT NULL,
        layout_json JSONB NOT NULL
      );
    `,
  }),
  Object.freeze({
    version: 4,
    sql: `
      CREATE TABLE finishing_plans (
        job_id TEXT PRIMARY KEY,
        plan_json JSONB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX finishing_plans_updated ON finishing_plans (updated_at, job_id);
    `,
  }),
  // Spec 027h: the media store tables, mirroring sqlite MEDIA_MIGRATIONS version 1 in migrations.ts.
  // Its append-only triggers are not mirrored: PgMediaRepository never updates or deletes those rows.
  Object.freeze({
    version: 5,
    sql: `
      CREATE TABLE media (
        id TEXT PRIMARY KEY,
        archived SMALLINT NOT NULL,
        device_profile TEXT,
        device_medium_key TEXT,
        data JSONB NOT NULL
      );
      CREATE INDEX media_device_ref ON media (device_profile, device_medium_key);
      CREATE TABLE output_modes (
        id TEXT PRIMARY KEY,
        medium_id TEXT NOT NULL,
        device_profile TEXT NOT NULL,
        mode_key TEXT NOT NULL,
        data JSONB NOT NULL,
        UNIQUE (medium_id, device_profile, mode_key)
      );
      CREATE TABLE color_setups (
        id TEXT PRIMARY KEY,
        medium_id TEXT NOT NULL,
        output_mode_id TEXT NOT NULL UNIQUE,
        data JSONB NOT NULL
      );
      CREATE TABLE color_setup_revisions (
        id TEXT PRIMARY KEY,
        color_setup_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data JSONB NOT NULL,
        UNIQUE (color_setup_id, seq)
      );
      CREATE TABLE presets (
        id TEXT PRIMARY KEY,
        medium_id TEXT NOT NULL,
        data JSONB NOT NULL
      );
      CREATE TABLE profiles (
        sha256 TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        bytes BYTEA NOT NULL
      );
      CREATE TABLE profiling_sessions (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
      CREATE TABLE profiling_artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data JSONB NOT NULL,
        bytes BYTEA NOT NULL
      );
      CREATE INDEX profiling_artifacts_session ON profiling_artifacts (session_id, seq);
      CREATE TABLE job_color_bindings (
        job_id TEXT PRIMARY KEY,
        medium_id TEXT NOT NULL,
        data JSONB NOT NULL
      );
      CREATE INDEX job_color_bindings_medium ON job_color_bindings (medium_id);
    `,
  }),
]);
