import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ColorSetupRevisionRecord, JobColorBinding, Medium, ProfilingArtifactMeta } from '@bax-print/core';
import { openMediaStore, openSqliteDatabase as openDatabase } from '../src/index.js';

const now = '2026-11-02T00:00:00.000Z';

const medium = (id: string): Medium => ({
  id,
  name: `Medium ${id}`,
  kind: { tag: 'film', term: 'film' },
  widthsMm: [1000],
  form: 'roll',
  sides: 1,
  archived: false,
  source: 'user',
  userOverrides: [],
  createdAt: now,
  updatedAt: now,
});

const revision = (id: string, seq: number): ColorSetupRevisionRecord => ({
  id,
  colorSetupId: 'cs1',
  seq,
  parentRevisionId: null,
  authorKind: 'user',
  author: 'tester',
  createdAt: now,
  reason: 'test',
  contentHash: 'h',
  content: { level: 'uncharacterized', renderingIntent: 'relative-colorimetric' },
});

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bps-store-'));
  dirs.push(dir);
  return join(dir, 'media.sqlite');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SqliteMediaRepository', () => {
  it('persists records across close and reopen', () => {
    const path = tempFile();
    const first = openMediaStore(path);
    first.insertMedium(medium('m1'));
    first.appendRevision(revision('r1', 1));
    first.close();

    const second = openMediaStore(path);
    expect(second.getMedium('m1')?.name).toBe('Medium m1');
    expect(second.listRevisions('cs1').map((r) => r.id)).toEqual(['r1']);
    second.close();
  });

  it('hides archived media unless asked', () => {
    const repo = openMediaStore(':memory:');
    repo.insertMedium(medium('m1'));
    repo.insertMedium({ ...medium('m2'), archived: true });
    expect(repo.listMedia().map((m) => m.id)).toEqual(['m1']);
    expect(repo.listMedia({ includeArchived: true }).map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(repo.getMedium('m2')?.archived).toBe(true);
    repo.close();
  });

  it('refuses to update or delete revisions, artifacts and job bindings', () => {
    const path = tempFile();
    const repo = openMediaStore(path);
    repo.appendRevision(revision('r1', 1));
    repo.appendArtifact(
      { id: 'a1', sessionId: 's1', slot: 'target_printed', kind: 'k', mediaType: 'text/plain', sha256: 'x', sizeBytes: 1, createdAt: now },
      new Uint8Array([1]),
    );
    repo.insertJobBinding({
      jobId: 'j1',
      presetId: 'p1',
      mediumId: 'm1',
      outputModeId: 'o1',
      colorSetupId: 'cs1',
      colorSetupRevisionId: 'r1',
      renderingIntent: 'perceptual',
      boundAt: now,
    });
    repo.close();

    const db = openDatabase(path);
    expect(() => db.exec("UPDATE color_setup_revisions SET data = '{}'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM color_setup_revisions')).toThrow(/append-only/);
    expect(() => db.exec("UPDATE profiling_artifacts SET data = '{}'")).toThrow(/append-only/);
    expect(() => db.exec("UPDATE job_color_bindings SET data = '{}'")).toThrow(/append-only/);
    db.close();
  });

  it('rolls back a failed transaction, including nested savepoints', () => {
    const repo = openMediaStore(':memory:');
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
    repo.close();
  });

  it('stores profile bytes once per hash and returns copies', () => {
    const repo = openMediaStore(':memory:');
    const record = {
      sha256: 'abc',
      description: 'p',
      format: 'icc' as const,
      mediaType: 'application/vnd.iccprofile',
      colorants: ['cyan'],
      provenance: { source: 's', license: 'l', redistributable: true },
      sizeBytes: 3,
      createdAt: now,
    };
    repo.putProfile(record, new Uint8Array([1, 2, 3]));
    repo.putProfile({ ...record, description: 'second' }, new Uint8Array([9]));
    expect(repo.getProfile('abc')?.description).toBe('p');
    expect(Array.from(repo.getProfileBytes('abc') ?? [])).toEqual([1, 2, 3]);
    repo.close();
  });

  it('round-trips artifacts with bytes and job bindings', () => {
    const repo = openMediaStore(':memory:');
    const meta = (id: string): ProfilingArtifactMeta => ({
      id,
      sessionId: 's1',
      slot: 'target_printed',
      kind: 'k',
      mediaType: 'text/plain',
      sha256: id,
      sizeBytes: 2,
      createdAt: now,
    });
    repo.appendArtifact(meta('a2'), new Uint8Array([7, 8]));
    repo.appendArtifact(meta('a1'), new Uint8Array([9, 10]));
    expect(repo.listArtifacts('s1').map((a) => a.id)).toEqual(['a2', 'a1']);
    const stored = repo.getArtifact('a1');
    expect(stored?.meta).toEqual(meta('a1'));
    expect(Array.from(stored?.bytes ?? [])).toEqual([9, 10]);
    expect(repo.getArtifact('missing')).toBeUndefined();

    const binding: JobColorBinding = {
      jobId: 'j1',
      presetId: 'p1',
      mediumId: 'm1',
      outputModeId: 'o1',
      colorSetupId: 'cs1',
      colorSetupRevisionId: 'r1',
      renderingIntent: 'perceptual',
      boundAt: now,
    };
    repo.insertJobBinding(binding);
    expect(repo.getJobBinding('j1')).toEqual(binding);
    expect(repo.countJobBindingsForMedium('m1')).toBe(1);
    expect(() => repo.insertJobBinding(binding)).toThrow();
    repo.close();
  });

  it('keeps revisions ordered, rejects duplicate seq and survives medium deletion', () => {
    const repo = openMediaStore(':memory:');
    repo.insertMedium(medium('m1'));
    repo.appendRevision(revision('r2', 2));
    repo.appendRevision(revision('r1', 1));
    expect(repo.getRevision('r2')).toEqual(revision('r2', 2));
    expect(repo.listRevisions('cs1').map((r) => r.seq)).toEqual([1, 2]);
    expect(() => repo.appendRevision(revision('r3', 2))).toThrow();
    expect(() => repo.appendRevision(revision('r1', 3))).toThrow();

    repo.deleteMedium('m1');
    expect(repo.getMedium('m1')).toBeUndefined();
    expect(repo.listRevisions('cs1').map((r) => r.id)).toEqual(['r1', 'r2']);
    repo.close();
  });

  it('migrates once and reopens an existing file without re-running migrations', () => {
    const path = tempFile();
    openMediaStore(path).close();
    openMediaStore(path).close();
    const db = openDatabase(path);
    const rows = db.prepare('SELECT version FROM media_schema_migrations').all() as unknown as { version: number }[];
    expect(rows.map((r) => r.version)).toEqual([1]);
    db.close();
  });
});
