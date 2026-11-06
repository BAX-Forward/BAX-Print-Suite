import { describe, expect, it } from 'vitest';
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
import {
  MEDIA_MIGRATIONS,
  PG_MIGRATIONS,
  PgMediaRepository,
  SqliteDbPort,
  openSqliteDatabase,
  type DbPort,
  type DbRow,
  type DbValue,
} from '../src/index.js';

const MEDIA_VERSION = 5;

const NOW = '2026-11-02T00:00:00.000Z';

const CREATED_OBJECT = /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;

/** `table:name` and `index:name` for every object a migration text creates, in order. */
function createdObjects(sql: string): string[] {
  return [...sql.matchAll(CREATED_OBJECT)].map((match) => `${(match[1] ?? '').toLowerCase()}:${match[2] ?? ''}`);
}

function pgMediaSql(): string {
  return PG_MIGRATIONS.find((migration) => migration.version === MEDIA_VERSION)?.sql ?? '';
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Reorders object keys, as JSONB does, so a test cannot depend on the stored string form. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compare(b, a))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

function jsonbText(row: DbRow): DbRow {
  const { data } = row;
  return typeof data === 'string' ? { ...row, data: JSON.stringify(sortKeys(JSON.parse(data))) } : row;
}

/** The only PostgreSQL-specific syntax the repository issues, mapped to its SQLite equivalent. */
function toSqlite(sql: string): string {
  return sql.replaceAll('::text', '').replaceAll('COLLATE "C"', 'COLLATE BINARY');
}

interface Call {
  readonly sql: string;
  readonly params: readonly DbValue[];
  readonly inTransaction: boolean;
}

/**
 * DbPort over an in-memory SQLite database that holds the PG_MIGRATIONS version 5 tables, so
 * primary keys and unique constraints are real. Records every statement as the repository sent it.
 */
class SqliteBackedPgPort implements DbPort {
  readonly db = openSqliteDatabase(':memory:');
  readonly calls: Call[] = [];
  private readonly inner = new SqliteDbPort(this.db);
  private depth = 0;

  constructor() {
    this.db.exec(pgMediaSql());
  }

  query(sql: string, params: readonly DbValue[] = []): DbRow[] {
    this.record(sql, params);
    const rows = this.inner.query(toSqlite(sql), params);
    return sql.includes('data::text') ? rows.map(jsonbText) : rows;
  }

  exec(sql: string, params: readonly DbValue[] = []): number {
    this.record(sql, params);
    return this.inner.exec(toSqlite(sql), params);
  }

  transaction<T>(work: () => T): T {
    this.depth += 1;
    try {
      return this.inner.transaction(work);
    } finally {
      this.depth -= 1;
    }
  }

  /** The stored `data` column, parsed. */
  storedData(table: string, keyColumn: string, key: string): unknown {
    const data = this.inner.query(`SELECT data FROM ${table} WHERE ${keyColumn} = ?`, [key])[0]?.data;
    if (typeof data !== 'string') throw new TypeError(`no ${table} row ${key}`);
    return JSON.parse(data);
  }

  private record(sql: string, params: readonly DbValue[]): void {
    this.calls.push({ sql, params: [...params], inTransaction: this.depth > 0 });
  }
}

function setup(): { port: SqliteBackedPgPort; repo: PgMediaRepository } {
  const port = new SqliteBackedPgPort();
  return { port, repo: new PgMediaRepository(port) };
}

const medium = (id: string, extra: Partial<Medium> = {}): Medium => ({
  id,
  name: `Medium ${id}`,
  kind: { tag: 'film', term: 'film' },
  widthsMm: [1000],
  form: 'roll',
  sides: 1,
  archived: false,
  source: 'user',
  userOverrides: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

const outputMode = (id: string, mediumId: string, modeKey: string): OutputMode => ({
  id,
  mediumId,
  deviceProfile: 'profile-a',
  modeKey,
  name: `Mode ${modeKey}`,
  resolutionDpi: { x: 720, y: 720 },
  passes: 4,
  inkSet: ['cyan', 'magenta'],
  direction: 'bidirectional',
  params: { nested: { b: 2, a: 1 } },
  hidden: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const colorSetup = (id: string, mediumId: string, outputModeId: string): ColorSetup => ({
  id,
  mediumId,
  outputModeId,
  headRevisionId: null,
  content: { level: 'uncharacterized', renderingIntent: 'relative-colorimetric' },
  revisionCount: 0,
  userRevisionCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
});

const revision = (id: string, seq: number): ColorSetupRevisionRecord => ({
  id,
  colorSetupId: 'cs1',
  seq,
  parentRevisionId: null,
  authorKind: 'user',
  author: 'tester',
  createdAt: NOW,
  reason: 'test',
  contentHash: 'h',
  content: { level: 'uncharacterized', renderingIntent: 'relative-colorimetric' },
});

const preset = (id: string, mediumId: string): Preset => ({
  id,
  name: `Preset ${id}`,
  mediumId,
  outputModeId: 'o1',
  colorSetupId: 'cs1',
  verification: { maxMeanDeltaE2000: 2, maxP95DeltaE2000: 4 },
  createdAt: NOW,
  updatedAt: NOW,
});

const session = (id: string): ProfilingSession => ({
  id,
  mediumId: 'm1',
  outputModeId: 'o1',
  colorSetupId: 'cs1',
  level: 'L1',
  state: 'created',
  options: {
    rampSteps: 21,
    patchSizeMm: 6,
    pageWidthMm: 1000,
    maxVerificationPatches: 50,
    linearizationMetric: 'de2000-from-paper',
    thresholds: { maxMeanDeltaE2000: 2, maxP95DeltaE2000: 4 },
  },
  artifacts: {},
  history: [{ state: 'created', at: NOW, author: 'tester' }],
  createdBy: 'tester',
  createdAt: NOW,
  updatedAt: NOW,
});

const artifact = (id: string): ProfilingArtifactMeta => ({
  id,
  sessionId: 's1',
  slot: 'target_printed',
  kind: 'k',
  mediaType: 'text/plain',
  sha256: id,
  sizeBytes: 2,
  createdAt: NOW,
});

const binding: JobColorBinding = {
  jobId: 'j1',
  presetId: 'p1',
  mediumId: 'm1',
  outputModeId: 'o1',
  colorSetupId: 'cs1',
  colorSetupRevisionId: 'r1',
  renderingIntent: 'perceptual',
  boundAt: NOW,
};

const profile: ProfileRecord = {
  sha256: 'abc',
  description: 'p',
  format: 'icc',
  mediaType: 'application/vnd.iccprofile',
  colorants: ['cyan'],
  provenance: { source: 's', license: 'l', redistributable: true },
  sizeBytes: 3,
  createdAt: NOW,
};

describe('PG_MIGRATIONS version 5 (027h)', () => {
  it('follows versions 1-4', () => {
    expect(PG_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, MEDIA_VERSION]);
    expect(Object.isFrozen(PG_MIGRATIONS.find((migration) => migration.version === MEDIA_VERSION))).toBe(true);
  });

  it('creates every table and index the sqlite media store version 1 creates', () => {
    const expected = createdObjects(MEDIA_MIGRATIONS.find((migration) => migration.version === 1)?.sql ?? '');

    expect(expected).toContain('index:media_device_ref');
    expect(createdObjects(pgMediaSql())).toEqual(expected);
  });

  it('stores documents as JSONB and bytes as BYTEA', () => {
    const sql = pgMediaSql();
    expect(sql.match(/\bdata JSONB NOT NULL/g)).toHaveLength(9);
    expect(sql.match(/\bbytes BYTEA NOT NULL/g)).toHaveLength(2);
    expect(sql).not.toMatch(/\bBLOB\b|\bTRIGGER\b/i);
  });
});

describe('PgMediaRepository', () => {
  it('issues only `?` placeholders and PostgreSQL forms of the sqlite statements', () => {
    const { port, repo } = setup();
    repo.insertMedium(medium('m1'));
    repo.listMedia();
    repo.putProfile(profile, new Uint8Array([1]));
    repo.appendArtifact(artifact('a1'), new Uint8Array([1]));
    repo.getArtifact('a1');
    repo.countJobBindingsForMedium('m1');
    repo.deleteMedium('m1');

    for (const { sql } of port.calls) {
      expect(sql).not.toMatch(/\$\d|INSERT OR|\bIFNULL\b/);
      if (/^SELECT data\b/.test(sql)) expect(sql).toMatch(/^SELECT data::text AS data\b/);
      if (/ORDER BY id\b/.test(sql)) expect(sql).toMatch(/ORDER BY id COLLATE "C"/);
    }
    expect(port.calls.map((call) => call.sql)).toContain(
      'INSERT INTO profiles (sha256, data, bytes) VALUES (?, ?, ?) ON CONFLICT (sha256) DO NOTHING',
    );
  });

  it('round-trips media and stores the document structurally', () => {
    const { port, repo } = setup();
    const stored = medium('m1', { deviceRef: { deviceProfile: 'profile-a', mediumKey: 'k1' }, thicknessUm: 80 });
    repo.insertMedium(stored);

    expect(repo.getMedium('m1')).toStrictEqual(stored);
    expect(port.storedData('media', 'id', 'm1')).toStrictEqual(stored);
    expect(port.calls[0]?.params.slice(0, 4)).toStrictEqual(['m1', 0, 'profile-a', 'k1']);

    const archived: Medium = { ...stored, name: 'Renamed', archived: true };
    repo.updateMedium(archived);
    expect(repo.getMedium('m1')).toStrictEqual(archived);
    expect(port.calls.at(-2)?.params.slice(0, 3)).toStrictEqual([1, 'profile-a', 'k1']);
  });

  it('hides archived media unless asked and lists by id in code point order', () => {
    const { repo } = setup();
    repo.insertMedium(medium('b'));
    repo.insertMedium(medium('a', { archived: true }));
    repo.insertMedium(medium('B'));
    repo.insertMedium(medium('a2'));

    expect(repo.listMedia().map((m) => m.id)).toEqual(['B', 'a2', 'b']);
    expect(repo.listMedia({ includeArchived: true }).map((m) => m.id)).toEqual(['B', 'a', 'a2', 'b']);
    expect(repo.getMedium('a')?.archived).toBe(true);
  });

  it('finds a medium by device ref, preferring the lowest id', () => {
    const { repo } = setup();
    const ref = { deviceProfile: 'profile-a', mediumKey: 'k1' };
    repo.insertMedium(medium('m2', { deviceRef: ref }));
    repo.insertMedium(medium('m1', { deviceRef: ref }));
    repo.insertMedium(medium('m0'));

    expect(repo.findMediumByDeviceRef('profile-a', 'k1')?.id).toBe('m1');
    expect(repo.findMediumByDeviceRef('profile-a', 'k2')).toBeUndefined();
    expect(repo.findMediumByDeviceRef('profile-b', 'k1')).toBeUndefined();

    repo.updateMedium(medium('m1'));
    expect(repo.findMediumByDeviceRef('profile-a', 'k1')?.id).toBe('m2');
  });

  it('returns undefined or empty lists for missing records and ignores updates to them', () => {
    const { repo } = setup();
    repo.updateMedium(medium('missing'));
    repo.updateOutputMode(outputMode('missing', 'm1', 'k'));
    repo.updateColorSetup(colorSetup('missing', 'm1', 'o1'));
    repo.updatePreset(preset('missing', 'm1'));
    repo.updateSession(session('missing'));
    repo.deletePreset('missing');
    repo.deleteMedium('missing');

    expect(repo.getMedium('missing')).toBeUndefined();
    expect(repo.getOutputMode('missing')).toBeUndefined();
    expect(repo.findOutputMode('m1', 'profile-a', 'k')).toBeUndefined();
    expect(repo.getColorSetup('missing')).toBeUndefined();
    expect(repo.getColorSetupByOutputMode('missing')).toBeUndefined();
    expect(repo.getRevision('missing')).toBeUndefined();
    expect(repo.getPreset('missing')).toBeUndefined();
    expect(repo.getProfile('missing')).toBeUndefined();
    expect(repo.getProfileBytes('missing')).toBeUndefined();
    expect(repo.getSession('missing')).toBeUndefined();
    expect(repo.getArtifact('missing')).toBeUndefined();
    expect(repo.getJobBinding('missing')).toBeUndefined();
    expect(repo.countJobBindingsForMedium('missing')).toBe(0);
    expect(repo.listMedia({ includeArchived: true })).toEqual([]);
    expect(repo.listOutputModes('m1')).toEqual([]);
    expect(repo.listColorSetups('m1')).toEqual([]);
    expect(repo.listRevisions('cs1')).toEqual([]);
    expect(repo.listPresets()).toEqual([]);
    expect(repo.listSessions()).toEqual([]);
    expect(repo.listArtifacts('s1')).toEqual([]);
  });

  it('orders output modes by mode key then id and rejects a duplicate device mode', () => {
    const { port, repo } = setup();
    repo.insertOutputMode(outputMode('o3', 'm1', 'b'));
    repo.insertOutputMode({ ...outputMode('o2', 'm1', 'a'), deviceProfile: 'profile-b' });
    repo.insertOutputMode(outputMode('o1', 'm1', 'a'));
    repo.insertOutputMode(outputMode('o9', 'm2', 'a'));

    expect(repo.listOutputModes('m1').map((mode) => mode.id)).toEqual(['o1', 'o2', 'o3']);
    expect(repo.findOutputMode('m1', 'profile-b', 'a')?.id).toBe('o2');
    expect(repo.getOutputMode('o1')).toStrictEqual(outputMode('o1', 'm1', 'a'));
    expect(port.storedData('output_modes', 'id', 'o1')).toStrictEqual(outputMode('o1', 'm1', 'a'));
    expect(() => repo.insertOutputMode(outputMode('o4', 'm1', 'a'))).toThrow();
    expect(() => repo.insertOutputMode(outputMode('o1', 'm3', 'z'))).toThrow();

    const renamed: OutputMode = { ...outputMode('o1', 'm1', 'a'), name: 'Renamed' };
    repo.updateOutputMode(renamed);
    expect(repo.getOutputMode('o1')).toStrictEqual(renamed);
  });

  it('keeps one color setup per output mode', () => {
    const { repo } = setup();
    repo.insertColorSetup(colorSetup('cs2', 'm1', 'o2'));
    repo.insertColorSetup(colorSetup('cs1', 'm1', 'o1'));
    repo.insertColorSetup(colorSetup('cs9', 'm2', 'o9'));

    expect(repo.listColorSetups('m1').map((s) => s.id)).toEqual(['cs1', 'cs2']);
    expect(repo.getColorSetupByOutputMode('o2')).toStrictEqual(colorSetup('cs2', 'm1', 'o2'));
    expect(() => repo.insertColorSetup(colorSetup('cs3', 'm1', 'o1'))).toThrow();

    const updated: ColorSetup = { ...colorSetup('cs1', 'm1', 'o1'), headRevisionId: 'r1', revisionCount: 1 };
    repo.updateColorSetup(updated);
    expect(repo.getColorSetup('cs1')).toStrictEqual(updated);
  });

  it('keeps revisions ordered, rejects duplicate seq and survives medium deletion', () => {
    const { repo } = setup();
    repo.insertMedium(medium('m1'));
    repo.appendRevision(revision('r2', 2));
    repo.appendRevision(revision('r1', 1));
    expect(repo.getRevision('r2')).toStrictEqual(revision('r2', 2));
    expect(repo.listRevisions('cs1').map((r) => r.seq)).toEqual([1, 2]);
    expect(() => repo.appendRevision(revision('r3', 2))).toThrow();
    expect(() => repo.appendRevision(revision('r1', 3))).toThrow();

    repo.deleteMedium('m1');
    expect(repo.getMedium('m1')).toBeUndefined();
    expect(repo.listRevisions('cs1').map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('deletes a medium with its modes, setups and presets in one transaction', () => {
    const { port, repo } = setup();
    repo.insertMedium(medium('m1'));
    repo.insertMedium(medium('m2'));
    repo.insertOutputMode(outputMode('o1', 'm1', 'a'));
    repo.insertOutputMode(outputMode('o2', 'm2', 'a'));
    repo.insertColorSetup(colorSetup('cs1', 'm1', 'o1'));
    repo.insertColorSetup(colorSetup('cs2', 'm2', 'o2'));
    repo.insertPreset(preset('p1', 'm1'));
    repo.insertPreset(preset('p2', 'm2'));
    repo.insertJobBinding(binding);
    const before = port.calls.length;

    repo.deleteMedium('m1');

    const deletes = port.calls.slice(before).filter((call) => call.sql.startsWith('DELETE'));
    expect(deletes).toHaveLength(4);
    expect(deletes.every((call) => call.inTransaction && call.params[0] === 'm1')).toBe(true);
    expect(repo.listMedia().map((m) => m.id)).toEqual(['m2']);
    expect(repo.listOutputModes('m1')).toEqual([]);
    expect(repo.listColorSetups('m1')).toEqual([]);
    expect(repo.listPresets().map((p) => p.id)).toEqual(['p2']);
    expect(repo.getOutputMode('o2')?.mediumId).toBe('m2');
    expect(repo.countJobBindingsForMedium('m1')).toBe(1);
  });

  it('updates, lists and deletes presets', () => {
    const { repo } = setup();
    repo.insertPreset(preset('p2', 'm1'));
    repo.insertPreset(preset('p1', 'm1'));
    expect(repo.listPresets().map((p) => p.id)).toEqual(['p1', 'p2']);

    const moved: Preset = { ...preset('p1', 'm2'), pinnedRevisionId: 'r1' };
    repo.updatePreset(moved);
    expect(repo.getPreset('p1')).toStrictEqual(moved);

    repo.deleteMedium('m1');
    expect(repo.listPresets()).toStrictEqual([moved]);
    repo.deletePreset('p1');
    expect(repo.listPresets()).toEqual([]);
  });

  it('stores profile bytes once per hash and returns copies', () => {
    const { repo } = setup();
    repo.putProfile(profile, new Uint8Array([1, 2, 3]));
    repo.putProfile({ ...profile, description: 'second' }, new Uint8Array([9]));

    expect(repo.getProfile('abc')).toStrictEqual(profile);
    const bytes = repo.getProfileBytes('abc') ?? new Uint8Array();
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    bytes.fill(0);
    expect(Array.from(repo.getProfileBytes('abc') ?? [])).toEqual([1, 2, 3]);
  });

  it('round-trips profiling sessions', () => {
    const { port, repo } = setup();
    repo.insertSession(session('s2'));
    repo.insertSession(session('s1'));
    expect(repo.listSessions().map((s) => s.id)).toEqual(['s1', 's2']);

    const measured: ProfilingSession = {
      ...session('s1'),
      state: 'measured',
      artifacts: { target_printed: ['a1'] },
    };
    repo.updateSession(measured);
    expect(repo.getSession('s1')).toStrictEqual(measured);
    expect(port.storedData('profiling_sessions', 'id', 's1')).toStrictEqual(measured);
    expect(() => repo.insertSession(session('s1'))).toThrow();
  });

  it('appends artifacts in arrival order per session and returns bytes', () => {
    const { port, repo } = setup();
    repo.appendArtifact(artifact('a2'), new Uint8Array([7, 8]));
    repo.appendArtifact(artifact('a1'), new Uint8Array([9, 10]));
    repo.appendArtifact({ ...artifact('a0'), sessionId: 's2' }, new Uint8Array([1]));

    expect(repo.listArtifacts('s1').map((a) => a.id)).toEqual(['a2', 'a1']);
    expect(repo.listArtifacts('s2').map((a) => a.id)).toEqual(['a0']);
    const inserts = port.calls.filter((call) => call.sql.startsWith('INSERT INTO profiling_artifacts'));
    expect(inserts.map((call) => call.params[2])).toEqual([1, 2, 1]);
    expect(inserts.every((call) => call.inTransaction)).toBe(true);

    const stored = repo.getArtifact('a1');
    expect(stored?.meta).toStrictEqual(artifact('a1'));
    expect(Array.from(stored?.bytes ?? [])).toEqual([9, 10]);
    expect(() => repo.appendArtifact(artifact('a1'), new Uint8Array([1]))).toThrow();
  });

  it('records job bindings once and counts them per medium', () => {
    const { repo } = setup();
    repo.insertJobBinding(binding);
    repo.insertJobBinding({ ...binding, jobId: 'j2' });
    repo.insertJobBinding({ ...binding, jobId: 'j3', mediumId: 'm2' });

    expect(repo.getJobBinding('j1')).toStrictEqual(binding);
    expect(repo.countJobBindingsForMedium('m1')).toBe(2);
    expect(repo.countJobBindingsForMedium('m2')).toBe(1);
    expect(() => repo.insertJobBinding(binding)).toThrow();
  });

  it('rolls back a failed transaction, including nested savepoints', () => {
    const { port, repo } = setup();
    expect(() =>
      repo.transaction(() => {
        repo.insertMedium(medium('m1'));
        repo.transaction(() => repo.insertMedium(medium('m2')));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repo.listMedia()).toEqual([]);

    expect(() =>
      repo.transaction(() => {
        repo.insertMedium(medium('m3'));
        try {
          repo.transaction(() => {
            repo.insertMedium(medium('m4'));
            throw new Error('inner');
          });
        } catch {
          // inner savepoint rolled back, outer continues
        }
      }),
    ).not.toThrow();
    expect(repo.listMedia().map((m) => m.id)).toEqual(['m3']);
    const statements = port.calls.map((call) => call.sql);
    for (const statement of ['SAVEPOINT media_sp_1', 'ROLLBACK TO SAVEPOINT media_sp_1', 'RELEASE SAVEPOINT media_sp_1']) {
      expect(statements).toContain(statement);
    }
  });

  it('returns the callback value and rejects asynchronous callbacks', () => {
    const { repo } = setup();
    expect(repo.transaction(() => 42)).toBe(42);
    expect(() =>
      repo.transaction(() => {
        repo.insertMedium(medium('m1'));
        return Promise.resolve();
      }),
    ).toThrow(TypeError);
    expect(repo.getMedium('m1')).toBeUndefined();
  });

  it('rejects rows whose data is not the expected document', () => {
    const { port, repo } = setup();
    port.db.exec(`INSERT INTO media (id, archived, data) VALUES ('n', 0, 42)`);
    port.db.exec(`INSERT INTO media (id, archived, data) VALUES ('x', 0, '{"id":"x","name":"X"}')`);
    port.db.exec(`INSERT INTO presets (id, medium_id, data) VALUES ('p', 'm', '[]')`);
    port.db.exec(`INSERT INTO job_color_bindings (job_id, medium_id, data) VALUES ('j', 'm', '{"jobId":7}')`);
    port.db.exec(`INSERT INTO profiles (sha256, data, bytes) VALUES ('h', '{"sha256":"h"}', 'text')`);

    expect(() => repo.getMedium('n')).toThrow(TypeError);
    expect(() => repo.getMedium('x')).toThrow(TypeError);
    expect(() => repo.listMedia()).toThrow(TypeError);
    expect(() => repo.getPreset('p')).toThrow(TypeError);
    expect(() => repo.getJobBinding('j')).toThrow(TypeError);
    expect(repo.getProfile('h')).toStrictEqual({ sha256: 'h' });
    expect(() => repo.getProfileBytes('h')).toThrow(TypeError);
  });
});
