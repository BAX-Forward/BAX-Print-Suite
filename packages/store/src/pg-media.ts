/**
 * Spec 027h: {@link MediaRepository} for PostgreSQL, written only against {@link DbPort}.
 *
 * Not wired into the server, and this build ships no PostgreSQL driver: nothing constructs a
 * port for it yet. The SQL uses `?` placeholders as DbPort documents; a driver adapter maps them
 * to its own form. The tables are the media tables from PG_MIGRATIONS version 5.
 *
 * `data` is JSONB there, so it is read back as `data::text`: the same document, but PostgreSQL
 * normalizes its whitespace and key order. Ids and keys sort with the "C" collation so lists
 * order by code point, as the SQLite repository does. Nested `transaction` calls use savepoints,
 * as SqliteMediaRepository does; the outermost call runs in one port transaction.
 */
import type {
  ColorSetup,
  ColorSetupRevisionRecord,
  JobColorBinding,
  Medium,
  OutputMode,
  Preset,
  ProfileRecord,
  ProfilingArtifactMeta,
  ProfilingSession,
} from '@bax-print/core';
import type { DbPort, DbRow, DbValue } from './db-port.js';
import type { MediaRepository, StoredArtifact } from './media-repository.js';

const SQL = {
  insertMedium: 'INSERT INTO media (id, archived, device_profile, device_medium_key, data) VALUES (?, ?, ?, ?, ?)',
  updateMedium: 'UPDATE media SET archived = ?, device_profile = ?, device_medium_key = ?, data = ? WHERE id = ?',
  getMedium: 'SELECT data::text AS data FROM media WHERE id = ?',
  listMedia: 'SELECT data::text AS data FROM media ORDER BY id COLLATE "C"',
  listActiveMedia: 'SELECT data::text AS data FROM media WHERE archived = 0 ORDER BY id COLLATE "C"',
  findMediumByDeviceRef:
    'SELECT data::text AS data FROM media WHERE device_profile = ? AND device_medium_key = ? ORDER BY id COLLATE "C" LIMIT 1',
  deletePresetsOfMedium: 'DELETE FROM presets WHERE medium_id = ?',
  deleteColorSetupsOfMedium: 'DELETE FROM color_setups WHERE medium_id = ?',
  deleteOutputModesOfMedium: 'DELETE FROM output_modes WHERE medium_id = ?',
  deleteMedium: 'DELETE FROM media WHERE id = ?',

  insertOutputMode: 'INSERT INTO output_modes (id, medium_id, device_profile, mode_key, data) VALUES (?, ?, ?, ?, ?)',
  updateOutputMode: 'UPDATE output_modes SET data = ? WHERE id = ?',
  getOutputMode: 'SELECT data::text AS data FROM output_modes WHERE id = ?',
  listOutputModes:
    'SELECT data::text AS data FROM output_modes WHERE medium_id = ? ORDER BY mode_key COLLATE "C", id COLLATE "C"',
  findOutputMode:
    'SELECT data::text AS data FROM output_modes WHERE medium_id = ? AND device_profile = ? AND mode_key = ?',

  insertColorSetup: 'INSERT INTO color_setups (id, medium_id, output_mode_id, data) VALUES (?, ?, ?, ?)',
  updateColorSetup: 'UPDATE color_setups SET data = ? WHERE id = ?',
  getColorSetup: 'SELECT data::text AS data FROM color_setups WHERE id = ?',
  getColorSetupByOutputMode: 'SELECT data::text AS data FROM color_setups WHERE output_mode_id = ?',
  listColorSetups: 'SELECT data::text AS data FROM color_setups WHERE medium_id = ? ORDER BY id COLLATE "C"',

  appendRevision: 'INSERT INTO color_setup_revisions (id, color_setup_id, seq, data) VALUES (?, ?, ?, ?)',
  getRevision: 'SELECT data::text AS data FROM color_setup_revisions WHERE id = ?',
  listRevisions: 'SELECT data::text AS data FROM color_setup_revisions WHERE color_setup_id = ? ORDER BY seq',

  insertPreset: 'INSERT INTO presets (id, medium_id, data) VALUES (?, ?, ?)',
  updatePreset: 'UPDATE presets SET medium_id = ?, data = ? WHERE id = ?',
  getPreset: 'SELECT data::text AS data FROM presets WHERE id = ?',
  listPresets: 'SELECT data::text AS data FROM presets ORDER BY id COLLATE "C"',
  deletePreset: 'DELETE FROM presets WHERE id = ?',

  putProfile: 'INSERT INTO profiles (sha256, data, bytes) VALUES (?, ?, ?) ON CONFLICT (sha256) DO NOTHING',
  getProfile: 'SELECT data::text AS data FROM profiles WHERE sha256 = ?',
  getProfileBytes: 'SELECT bytes FROM profiles WHERE sha256 = ?',

  insertSession: 'INSERT INTO profiling_sessions (id, data) VALUES (?, ?)',
  updateSession: 'UPDATE profiling_sessions SET data = ? WHERE id = ?',
  getSession: 'SELECT data::text AS data FROM profiling_sessions WHERE id = ?',
  listSessions: 'SELECT data::text AS data FROM profiling_sessions ORDER BY id COLLATE "C"',

  nextArtifactSeq:
    'SELECT CAST(COALESCE(MAX(seq), 0) + 1 AS INTEGER) AS next FROM profiling_artifacts WHERE session_id = ?',
  appendArtifact: 'INSERT INTO profiling_artifacts (id, session_id, seq, data, bytes) VALUES (?, ?, ?, ?, ?)',
  getArtifact: 'SELECT data::text AS data, bytes FROM profiling_artifacts WHERE id = ?',
  listArtifacts: 'SELECT data::text AS data FROM profiling_artifacts WHERE session_id = ? ORDER BY seq',

  insertJobBinding: 'INSERT INTO job_color_bindings (job_id, medium_id, data) VALUES (?, ?, ?)',
  getJobBinding: 'SELECT data::text AS data FROM job_color_bindings WHERE job_id = ?',
  countJobBindingsForMedium: 'SELECT CAST(COUNT(*) AS INTEGER) AS n FROM job_color_bindings WHERE medium_id = ?',
};

type Guard<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && keys.every((key) => typeof value[key] === 'string');
}

// Shallow checks on the fields the repository keys rows by, as the hot folder repository checks its doc.
const isMedium = (value: unknown): value is Medium =>
  hasText(value, ['id', 'name', 'createdAt', 'updatedAt']) && typeof value.archived === 'boolean';

const isOutputMode = (value: unknown): value is OutputMode =>
  hasText(value, ['id', 'mediumId', 'deviceProfile', 'modeKey']);

const isColorSetup = (value: unknown): value is ColorSetup => hasText(value, ['id', 'mediumId', 'outputModeId']);

const isRevision = (value: unknown): value is ColorSetupRevisionRecord =>
  hasText(value, ['id', 'colorSetupId']) && typeof value.seq === 'number';

const isPreset = (value: unknown): value is Preset => hasText(value, ['id', 'mediumId']);

const isProfileRecord = (value: unknown): value is ProfileRecord => hasText(value, ['sha256']);

const isSession = (value: unknown): value is ProfilingSession => hasText(value, ['id']);

const isArtifactMeta = (value: unknown): value is ProfilingArtifactMeta => hasText(value, ['id', 'sessionId']);

const isJobBinding = (value: unknown): value is JobColorBinding => hasText(value, ['jobId', 'mediumId']);

/** The port returns unchecked rows, so the `data` column is checked before it becomes a record. */
function parse<T>(row: DbRow, guard: Guard<T>, label: string): T {
  const { data } = row;
  if (typeof data !== 'string') {
    throw new TypeError(`${label} row has no data text`);
  }
  const value: unknown = JSON.parse(data);
  if (!guard(value)) {
    throw new TypeError(`${label} row data is not a ${label} document`);
  }
  return value;
}

/** Copies the bytes, so callers never share a driver buffer. */
function bytesColumn(row: DbRow, label: string): Uint8Array {
  const { bytes } = row;
  if (bytes instanceof Uint8Array) {
    return Uint8Array.from(bytes);
  }
  throw new TypeError(`${label} row has no bytes`);
}

function integerColumn(row: DbRow, column: string, label: string): number {
  const value = row[column];
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  if (typeof numeric === 'number' && Number.isSafeInteger(numeric)) {
    return numeric;
  }
  throw new TypeError(`${label} row ${column} is not an integer`);
}

export class PgMediaRepository implements MediaRepository {
  private depth = 0;

  /** The port's database must have PG_MIGRATIONS version 5 applied. */
  constructor(private readonly port: DbPort) {}

  transaction<T>(fn: () => T): T {
    if (this.depth === 0) {
      return this.port.transaction(() => this.enter(fn));
    }
    const savepoint = `media_sp_${this.depth}`;
    this.port.exec(`SAVEPOINT ${savepoint}`);
    try {
      const value = this.enter(fn);
      this.port.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      this.port.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.port.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  // Media
  insertMedium(medium: Medium): void {
    this.port.exec(SQL.insertMedium, [
      medium.id,
      medium.archived ? 1 : 0,
      medium.deviceRef?.deviceProfile ?? null,
      medium.deviceRef?.mediumKey ?? null,
      JSON.stringify(medium),
    ]);
  }

  updateMedium(medium: Medium): void {
    this.port.exec(SQL.updateMedium, [
      medium.archived ? 1 : 0,
      medium.deviceRef?.deviceProfile ?? null,
      medium.deviceRef?.mediumKey ?? null,
      JSON.stringify(medium),
      medium.id,
    ]);
  }

  getMedium(id: string): Medium | undefined {
    return this.one(SQL.getMedium, [id], isMedium, 'media');
  }

  listMedia(options: { includeArchived?: boolean } = {}): Medium[] {
    return this.many(options.includeArchived ? SQL.listMedia : SQL.listActiveMedia, [], isMedium, 'media');
  }

  findMediumByDeviceRef(deviceProfile: string, mediumKey: string): Medium | undefined {
    return this.one(SQL.findMediumByDeviceRef, [deviceProfile, mediumKey], isMedium, 'media');
  }

  deleteMedium(id: string): void {
    this.transaction(() => {
      this.port.exec(SQL.deletePresetsOfMedium, [id]);
      this.port.exec(SQL.deleteColorSetupsOfMedium, [id]);
      this.port.exec(SQL.deleteOutputModesOfMedium, [id]);
      this.port.exec(SQL.deleteMedium, [id]);
    });
  }

  // Output modes
  insertOutputMode(mode: OutputMode): void {
    this.port.exec(SQL.insertOutputMode, [mode.id, mode.mediumId, mode.deviceProfile, mode.modeKey, JSON.stringify(mode)]);
  }

  updateOutputMode(mode: OutputMode): void {
    this.port.exec(SQL.updateOutputMode, [JSON.stringify(mode), mode.id]);
  }

  getOutputMode(id: string): OutputMode | undefined {
    return this.one(SQL.getOutputMode, [id], isOutputMode, 'output_modes');
  }

  listOutputModes(mediumId: string): OutputMode[] {
    return this.many(SQL.listOutputModes, [mediumId], isOutputMode, 'output_modes');
  }

  findOutputMode(mediumId: string, deviceProfile: string, modeKey: string): OutputMode | undefined {
    return this.one(SQL.findOutputMode, [mediumId, deviceProfile, modeKey], isOutputMode, 'output_modes');
  }

  // Color setups
  insertColorSetup(setup: ColorSetup): void {
    this.port.exec(SQL.insertColorSetup, [setup.id, setup.mediumId, setup.outputModeId, JSON.stringify(setup)]);
  }

  updateColorSetup(setup: ColorSetup): void {
    this.port.exec(SQL.updateColorSetup, [JSON.stringify(setup), setup.id]);
  }

  getColorSetup(id: string): ColorSetup | undefined {
    return this.one(SQL.getColorSetup, [id], isColorSetup, 'color_setups');
  }

  getColorSetupByOutputMode(outputModeId: string): ColorSetup | undefined {
    return this.one(SQL.getColorSetupByOutputMode, [outputModeId], isColorSetup, 'color_setups');
  }

  listColorSetups(mediumId: string): ColorSetup[] {
    return this.many(SQL.listColorSetups, [mediumId], isColorSetup, 'color_setups');
  }

  // Revisions (append-only: the repository never updates or deletes them)
  appendRevision(revision: ColorSetupRevisionRecord): void {
    this.port.exec(SQL.appendRevision, [revision.id, revision.colorSetupId, revision.seq, JSON.stringify(revision)]);
  }

  getRevision(id: string): ColorSetupRevisionRecord | undefined {
    return this.one(SQL.getRevision, [id], isRevision, 'color_setup_revisions');
  }

  listRevisions(colorSetupId: string): ColorSetupRevisionRecord[] {
    return this.many(SQL.listRevisions, [colorSetupId], isRevision, 'color_setup_revisions');
  }

  // Presets
  insertPreset(preset: Preset): void {
    this.port.exec(SQL.insertPreset, [preset.id, preset.mediumId, JSON.stringify(preset)]);
  }

  updatePreset(preset: Preset): void {
    this.port.exec(SQL.updatePreset, [preset.mediumId, JSON.stringify(preset), preset.id]);
  }

  getPreset(id: string): Preset | undefined {
    return this.one(SQL.getPreset, [id], isPreset, 'presets');
  }

  listPresets(): Preset[] {
    return this.many(SQL.listPresets, [], isPreset, 'presets');
  }

  deletePreset(id: string): void {
    this.port.exec(SQL.deletePreset, [id]);
  }

  // Profiles
  putProfile(record: ProfileRecord, bytes: Uint8Array): void {
    this.port.exec(SQL.putProfile, [record.sha256, JSON.stringify(record), bytes]);
  }

  getProfile(sha256: string): ProfileRecord | undefined {
    return this.one(SQL.getProfile, [sha256], isProfileRecord, 'profiles');
  }

  getProfileBytes(sha256: string): Uint8Array | undefined {
    const row = this.port.query(SQL.getProfileBytes, [sha256])[0];
    return row ? bytesColumn(row, 'profiles') : undefined;
  }

  // Profiling sessions
  insertSession(session: ProfilingSession): void {
    this.port.exec(SQL.insertSession, [session.id, JSON.stringify(session)]);
  }

  updateSession(session: ProfilingSession): void {
    this.port.exec(SQL.updateSession, [JSON.stringify(session), session.id]);
  }

  getSession(id: string): ProfilingSession | undefined {
    return this.one(SQL.getSession, [id], isSession, 'profiling_sessions');
  }

  listSessions(): ProfilingSession[] {
    return this.many(SQL.listSessions, [], isSession, 'profiling_sessions');
  }

  // Artifacts (append-only)
  appendArtifact(meta: ProfilingArtifactMeta, bytes: Uint8Array): void {
    this.transaction(() => {
      const row = this.port.query(SQL.nextArtifactSeq, [meta.sessionId])[0];
      const seq = row ? integerColumn(row, 'next', 'profiling_artifacts') : 1;
      this.port.exec(SQL.appendArtifact, [meta.id, meta.sessionId, seq, JSON.stringify(meta), bytes]);
    });
  }

  getArtifact(id: string): StoredArtifact | undefined {
    const row = this.port.query(SQL.getArtifact, [id])[0];
    if (!row) return undefined;
    return {
      meta: parse(row, isArtifactMeta, 'profiling_artifacts'),
      bytes: bytesColumn(row, 'profiling_artifacts'),
    };
  }

  listArtifacts(sessionId: string): ProfilingArtifactMeta[] {
    return this.many(SQL.listArtifacts, [sessionId], isArtifactMeta, 'profiling_artifacts');
  }

  // Job bindings (append-only)
  insertJobBinding(binding: JobColorBinding): void {
    this.port.exec(SQL.insertJobBinding, [binding.jobId, binding.mediumId, JSON.stringify(binding)]);
  }

  getJobBinding(jobId: string): JobColorBinding | undefined {
    return this.one(SQL.getJobBinding, [jobId], isJobBinding, 'job_color_bindings');
  }

  countJobBindingsForMedium(mediumId: string): number {
    const row = this.port.query(SQL.countJobBindingsForMedium, [mediumId])[0];
    return row ? integerColumn(row, 'n', 'job_color_bindings') : 0;
  }

  close(): void {
    // The port belongs to its caller, who closes the connection.
  }

  private enter<T>(fn: () => T): T {
    this.depth += 1;
    try {
      const value = fn();
      if (value instanceof Promise) throw new TypeError('transaction callbacks must be synchronous');
      return value;
    } finally {
      this.depth -= 1;
    }
  }

  private one<T>(sql: string, params: readonly DbValue[], guard: Guard<T>, label: string): T | undefined {
    const row = this.port.query(sql, params)[0];
    return row ? parse(row, guard, label) : undefined;
  }

  private many<T>(sql: string, params: readonly DbValue[], guard: Guard<T>, label: string): T[] {
    return this.port.query(sql, params).map((row) => parse(row, guard, label));
  }
}
