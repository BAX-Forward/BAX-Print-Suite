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
import type { MediaRepository, StoredArtifact } from './media-repository.js';
import { migrate } from './migrations.js';
import { type DatabaseSync, openDatabase } from './sqlite.js';

type Param = string | number | null | Uint8Array;
interface DataRow {
  data: string;
}
interface BlobRow extends DataRow {
  bytes: Uint8Array;
}

function parse<T>(row: DataRow | undefined): T | undefined {
  return row ? (JSON.parse(row.data) as T) : undefined;
}

function toBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}

export class SqliteMediaRepository implements MediaRepository {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec('PRAGMA foreign_keys = ON');
    migrate(this.db);
  }

  private run(sql: string, ...params: Param[]): void {
    this.db.prepare(sql).run(...params);
  }

  private get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  private all<T>(sql: string, ...params: Param[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private one<T>(sql: string, ...params: Param[]): T | undefined {
    return parse<T>(this.get<DataRow>(sql, ...params));
  }

  private many<T>(sql: string, ...params: Param[]): T[] {
    return this.all<DataRow>(sql, ...params).map((row) => JSON.parse(row.data) as T);
  }

  transaction<T>(fn: () => T): T {
    const savepoint = `sp_${this.depth}`;
    this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth += 1;
    try {
      const value = fn();
      if (value instanceof Promise) throw new TypeError('transaction callbacks must be synchronous');
      this.depth -= 1;
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return value;
    } catch (error) {
      this.depth -= 1;
      if (this.depth === 0) this.db.exec('ROLLBACK');
      else this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  // Media
  insertMedium(medium: Medium): void {
    this.run(
      'INSERT INTO media (id, archived, device_profile, device_medium_key, data) VALUES (?, ?, ?, ?, ?)',
      medium.id,
      medium.archived ? 1 : 0,
      medium.deviceRef?.deviceProfile ?? null,
      medium.deviceRef?.mediumKey ?? null,
      JSON.stringify(medium),
    );
  }

  updateMedium(medium: Medium): void {
    this.run(
      'UPDATE media SET archived = ?, device_profile = ?, device_medium_key = ?, data = ? WHERE id = ?',
      medium.archived ? 1 : 0,
      medium.deviceRef?.deviceProfile ?? null,
      medium.deviceRef?.mediumKey ?? null,
      JSON.stringify(medium),
      medium.id,
    );
  }

  getMedium(id: string): Medium | undefined {
    return this.one<Medium>('SELECT data FROM media WHERE id = ?', id);
  }

  listMedia(options: { includeArchived?: boolean } = {}): Medium[] {
    return options.includeArchived
      ? this.many<Medium>('SELECT data FROM media ORDER BY id')
      : this.many<Medium>('SELECT data FROM media WHERE archived = 0 ORDER BY id');
  }

  findMediumByDeviceRef(deviceProfile: string, mediumKey: string): Medium | undefined {
    return this.one<Medium>(
      'SELECT data FROM media WHERE device_profile = ? AND device_medium_key = ? ORDER BY id LIMIT 1',
      deviceProfile,
      mediumKey,
    );
  }

  deleteMedium(id: string): void {
    this.transaction(() => {
      this.run('DELETE FROM presets WHERE medium_id = ?', id);
      this.run('DELETE FROM color_setups WHERE medium_id = ?', id);
      this.run('DELETE FROM output_modes WHERE medium_id = ?', id);
      this.run('DELETE FROM media WHERE id = ?', id);
    });
  }

  // Output modes
  insertOutputMode(mode: OutputMode): void {
    this.run(
      'INSERT INTO output_modes (id, medium_id, device_profile, mode_key, data) VALUES (?, ?, ?, ?, ?)',
      mode.id,
      mode.mediumId,
      mode.deviceProfile,
      mode.modeKey,
      JSON.stringify(mode),
    );
  }

  updateOutputMode(mode: OutputMode): void {
    this.run('UPDATE output_modes SET data = ? WHERE id = ?', JSON.stringify(mode), mode.id);
  }

  getOutputMode(id: string): OutputMode | undefined {
    return this.one<OutputMode>('SELECT data FROM output_modes WHERE id = ?', id);
  }

  listOutputModes(mediumId: string): OutputMode[] {
    return this.many<OutputMode>('SELECT data FROM output_modes WHERE medium_id = ? ORDER BY mode_key, id', mediumId);
  }

  findOutputMode(mediumId: string, deviceProfile: string, modeKey: string): OutputMode | undefined {
    return this.one<OutputMode>(
      'SELECT data FROM output_modes WHERE medium_id = ? AND device_profile = ? AND mode_key = ?',
      mediumId,
      deviceProfile,
      modeKey,
    );
  }

  // Color setups
  insertColorSetup(setup: ColorSetup): void {
    this.run(
      'INSERT INTO color_setups (id, medium_id, output_mode_id, data) VALUES (?, ?, ?, ?)',
      setup.id,
      setup.mediumId,
      setup.outputModeId,
      JSON.stringify(setup),
    );
  }

  updateColorSetup(setup: ColorSetup): void {
    this.run('UPDATE color_setups SET data = ? WHERE id = ?', JSON.stringify(setup), setup.id);
  }

  getColorSetup(id: string): ColorSetup | undefined {
    return this.one<ColorSetup>('SELECT data FROM color_setups WHERE id = ?', id);
  }

  getColorSetupByOutputMode(outputModeId: string): ColorSetup | undefined {
    return this.one<ColorSetup>('SELECT data FROM color_setups WHERE output_mode_id = ?', outputModeId);
  }

  listColorSetups(mediumId: string): ColorSetup[] {
    return this.many<ColorSetup>('SELECT data FROM color_setups WHERE medium_id = ? ORDER BY id', mediumId);
  }

  // Revisions (append-only, enforced by triggers)
  appendRevision(revision: ColorSetupRevisionRecord): void {
    this.run(
      'INSERT INTO color_setup_revisions (id, color_setup_id, seq, data) VALUES (?, ?, ?, ?)',
      revision.id,
      revision.colorSetupId,
      revision.seq,
      JSON.stringify(revision),
    );
  }

  getRevision(id: string): ColorSetupRevisionRecord | undefined {
    return this.one<ColorSetupRevisionRecord>('SELECT data FROM color_setup_revisions WHERE id = ?', id);
  }

  listRevisions(colorSetupId: string): ColorSetupRevisionRecord[] {
    return this.many<ColorSetupRevisionRecord>(
      'SELECT data FROM color_setup_revisions WHERE color_setup_id = ? ORDER BY seq',
      colorSetupId,
    );
  }

  // Presets
  insertPreset(preset: Preset): void {
    this.run('INSERT INTO presets (id, medium_id, data) VALUES (?, ?, ?)', preset.id, preset.mediumId, JSON.stringify(preset));
  }

  updatePreset(preset: Preset): void {
    this.run('UPDATE presets SET medium_id = ?, data = ? WHERE id = ?', preset.mediumId, JSON.stringify(preset), preset.id);
  }

  getPreset(id: string): Preset | undefined {
    return this.one<Preset>('SELECT data FROM presets WHERE id = ?', id);
  }

  listPresets(): Preset[] {
    return this.many<Preset>('SELECT data FROM presets ORDER BY id');
  }

  deletePreset(id: string): void {
    this.run('DELETE FROM presets WHERE id = ?', id);
  }

  // Profiles
  putProfile(record: ProfileRecord, bytes: Uint8Array): void {
    this.run('INSERT OR IGNORE INTO profiles (sha256, data, bytes) VALUES (?, ?, ?)', record.sha256, JSON.stringify(record), bytes);
  }

  getProfile(sha256: string): ProfileRecord | undefined {
    return this.one<ProfileRecord>('SELECT data FROM profiles WHERE sha256 = ?', sha256);
  }

  getProfileBytes(sha256: string): Uint8Array | undefined {
    const row = this.get<BlobRow>('SELECT data, bytes FROM profiles WHERE sha256 = ?', sha256);
    return row ? toBytes(row.bytes) : undefined;
  }

  // Profiling sessions
  insertSession(session: ProfilingSession): void {
    this.run('INSERT INTO profiling_sessions (id, data) VALUES (?, ?)', session.id, JSON.stringify(session));
  }

  updateSession(session: ProfilingSession): void {
    this.run('UPDATE profiling_sessions SET data = ? WHERE id = ?', JSON.stringify(session), session.id);
  }

  getSession(id: string): ProfilingSession | undefined {
    return this.one<ProfilingSession>('SELECT data FROM profiling_sessions WHERE id = ?', id);
  }

  listSessions(): ProfilingSession[] {
    return this.many<ProfilingSession>('SELECT data FROM profiling_sessions ORDER BY id');
  }

  // Artifacts (append-only)
  appendArtifact(meta: ProfilingArtifactMeta, bytes: Uint8Array): void {
    const row = this.get<{ next: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM profiling_artifacts WHERE session_id = ?',
      meta.sessionId,
    );
    this.run(
      'INSERT INTO profiling_artifacts (id, session_id, seq, data, bytes) VALUES (?, ?, ?, ?, ?)',
      meta.id,
      meta.sessionId,
      row?.next ?? 1,
      JSON.stringify(meta),
      bytes,
    );
  }

  getArtifact(id: string): StoredArtifact | undefined {
    const row = this.get<BlobRow>('SELECT data, bytes FROM profiling_artifacts WHERE id = ?', id);
    return row ? { meta: JSON.parse(row.data) as ProfilingArtifactMeta, bytes: toBytes(row.bytes) } : undefined;
  }

  listArtifacts(sessionId: string): ProfilingArtifactMeta[] {
    return this.many<ProfilingArtifactMeta>('SELECT data FROM profiling_artifacts WHERE session_id = ? ORDER BY seq', sessionId);
  }

  // Job bindings (append-only)
  insertJobBinding(binding: JobColorBinding): void {
    this.run(
      'INSERT INTO job_color_bindings (job_id, medium_id, data) VALUES (?, ?, ?)',
      binding.jobId,
      binding.mediumId,
      JSON.stringify(binding),
    );
  }

  getJobBinding(jobId: string): JobColorBinding | undefined {
    return this.one<JobColorBinding>('SELECT data FROM job_color_bindings WHERE job_id = ?', jobId);
  }

  countJobBindingsForMedium(mediumId: string): number {
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM job_color_bindings WHERE medium_id = ?', mediumId)?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

/** Opens (and migrates) a media store. Use `:memory:` for an ephemeral store. */
export function openMediaStore(path: string): SqliteMediaRepository {
  return new SqliteMediaRepository(openDatabase(path));
}
