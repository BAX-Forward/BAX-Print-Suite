import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appliedMigrations,
  InvalidLayoutTemplateError,
  LayoutTemplateNameConflictError,
  openDatabase,
  parseLayoutTemplateJson,
  SqliteLayoutTemplateRepository,
  type Database,
  type NewLayoutTemplate,
} from '../src/index.js';

const LAYOUT_JSON = JSON.stringify({
  placements: [{ itemId: 'a', copy: 0, xPt: 0, yPt: 0, rotation: 0, footprint: { w: 100, h: 50 }, panel: 0 }],
  mediaWidthPt: 3628.35,
  lengthUsedPt: 50,
  utilization: 0.03,
  unplaced: [],
  algorithm: 'maxrects',
  elapsedMs: 1,
  panels: [{ index: 0, offsetPt: 0, lengthPt: 50 }],
});

function template(overrides: Partial<NewLayoutTemplate> = {}): NewLayoutTemplate {
  return { id: 'tpl-1', name: 'Labels 4-up', rollWidthMm: 1280, layoutJson: LAYOUT_JSON, ...overrides };
}

/** A clock that advances one second per call. */
function steppingClock(start = Date.UTC(2026, 0, 1)): () => Date {
  let tick = 0;
  return () => new Date(start + 1000 * tick++);
}

describe('SqliteLayoutTemplateRepository', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDatabasePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bps-layouts-'));
    dirs.push(dir);
    return join(dir, 'jobs.db');
  }

  function openRepo(): { db: Database; repo: SqliteLayoutTemplateRepository } {
    const db = openDatabase(tempDatabasePath());
    return { db, repo: new SqliteLayoutTemplateRepository(db, { now: steppingClock() }) };
  }

  it('round-trips a template by id and by name, and across reopening the file', () => {
    const path = tempDatabasePath();
    const first = openDatabase(path);
    const repo = new SqliteLayoutTemplateRepository(first, { now: steppingClock() });

    const saved = repo.save(template({ name: '  Labels 4-up  ' }));
    expect(saved).toEqual({
      id: 'tpl-1',
      name: 'Labels 4-up',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      rollWidthMm: 1280,
      layoutJson: LAYOUT_JSON,
    });
    expect(repo.get('tpl-1')).toEqual(saved);
    expect(repo.getByName(' Labels 4-up ')).toEqual(saved);
    expect(repo.get('missing')).toBeUndefined();
    expect(repo.getByName('missing')).toBeUndefined();
    expect(parseLayoutTemplateJson(saved.layoutJson).placements).toHaveLength(1);
    first.close();

    const second = openDatabase(path);
    expect(new SqliteLayoutTemplateRepository(second).get('tpl-1')).toEqual(saved);
    second.close();
  });

  it('generates an id when none is given', () => {
    const { db, repo } = openRepo();
    const saved = repo.save({ name: 'Generated', rollWidthMm: 610, layoutJson: '{"placements":[]}' });
    expect(saved.id).not.toBe('');
    expect(repo.get(saved.id)?.name).toBe('Generated');
    db.close();
  });

  it('replaces by id, keeping the creation time', () => {
    const { db, repo } = openRepo();
    repo.save(template());
    const replaced = repo.save(template({ rollWidthMm: 1600, layoutJson: '{"placements":[]}' }));

    expect(replaced).toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      rollWidthMm: 1600,
      layoutJson: '{"placements":[]}',
    });
    expect(repo.list()).toHaveLength(1);
    db.close();
  });

  it('lists by name without the layout document', () => {
    const { db, repo } = openRepo();
    repo.save(template({ id: 'c', name: 'Charlie' }));
    repo.save(template({ id: 'a', name: 'Alpha' }));
    repo.save(template({ id: 'b', name: 'Bravo' }));

    const listed = repo.list();
    expect(listed.map((item) => item.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(listed.every((item) => !('layoutJson' in item))).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('placements');
    expect(listed[0]).toEqual({
      id: 'a',
      name: 'Alpha',
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      rollWidthMm: 1280,
    });
    db.close();
  });

  it('rejects a name another template already has, and changes nothing', () => {
    const { db, repo } = openRepo();
    repo.save(template({ id: 'a', name: 'Shared' }));

    expect(() => repo.save(template({ id: 'b', name: ' Shared ' }))).toThrow(LayoutTemplateNameConflictError);
    expect(repo.get('b')).toBeUndefined();

    repo.save(template({ id: 'b', name: 'Other' }));
    let caught: unknown;
    try {
      repo.rename('b', 'Shared');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LayoutTemplateNameConflictError);
    expect(caught).toMatchObject({ code: 'LAYOUT_TEMPLATE_NAME_EXISTS', templateName: 'Shared' });
    expect(repo.get('b')?.name).toBe('Other');
    db.close();
  });

  it('renames a template, trimming the name and touching updatedAt only', () => {
    const { db, repo } = openRepo();
    const saved = repo.save(template());

    const renamed = repo.rename('tpl-1', '  Labels 6-up ');
    expect(renamed).toEqual({ ...saved, name: 'Labels 6-up', updatedAt: '2026-01-01T00:00:01.000Z' });
    expect(repo.getByName('Labels 4-up')).toBeUndefined();
    expect(repo.getByName('Labels 6-up')).toEqual(renamed);
    // Renaming to its own name is not a conflict.
    expect(repo.rename('tpl-1', 'Labels 6-up')?.name).toBe('Labels 6-up');
    expect(repo.rename('missing', 'Anything')).toBeUndefined();
    db.close();
  });

  it('deletes a template', () => {
    const { db, repo } = openRepo();
    repo.save(template());

    expect(repo.delete('tpl-1')).toBe(true);
    expect(repo.delete('tpl-1')).toBe(false);
    expect(repo.get('tpl-1')).toBeUndefined();
    expect(repo.list()).toEqual([]);
    // The name is free again.
    expect(repo.save(template({ id: 'tpl-2' })).name).toBe('Labels 4-up');
    db.close();
  });

  it.each([
    ['an empty name', { name: '' }, 'name'],
    ['a blank name', { name: '   ' }, 'name'],
    ['a name over 120 characters', { name: 'x'.repeat(121) }, 'name'],
    ['a zero roll width', { rollWidthMm: 0 }, 'rollWidthMm'],
    ['a negative roll width', { rollWidthMm: -5 }, 'rollWidthMm'],
    ['a NaN roll width', { rollWidthMm: Number.NaN }, 'rollWidthMm'],
    ['an infinite roll width', { rollWidthMm: Number.POSITIVE_INFINITY }, 'rollWidthMm'],
    ['layout JSON that does not parse', { layoutJson: '{placements' }, 'layoutJson'],
    ['layout JSON that is an array', { layoutJson: '[]' }, 'layoutJson'],
    ['layout JSON that is null', { layoutJson: 'null' }, 'layoutJson'],
    ['layout JSON without placements', { layoutJson: '{"panels":[]}' }, 'layoutJson'],
    ['layout JSON with non-array placements', { layoutJson: '{"placements":{}}' }, 'layoutJson'],
    ['an empty id', { id: ' ' }, 'id'],
  ] as const)('rejects %s', (_label, overrides, field) => {
    const { db, repo } = openRepo();
    let caught: unknown;
    try {
      repo.save(template(overrides));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidLayoutTemplateError);
    expect(caught).toMatchObject({ code: 'LAYOUT_TEMPLATE_INVALID', field });
    expect(repo.list()).toEqual([]);
    db.close();
  });

  it('accepts a name of exactly 120 characters after trimming', () => {
    const { db, repo } = openRepo();
    const name = 'x'.repeat(120);
    expect(repo.save(template({ name: ` ${name} ` })).name).toBe(name);
    db.close();
  });

  it('rejects an invalid name on rename', () => {
    const { db, repo } = openRepo();
    repo.save(template());
    expect(() => repo.rename('tpl-1', '  ')).toThrow(InvalidLayoutTemplateError);
    expect(repo.get('tpl-1')?.name).toBe('Labels 4-up');
    db.close();
  });

  it('applies the layout templates migration once across reopening', () => {
    const path = tempDatabasePath();
    openDatabase(path).close();
    const db = openDatabase(path);

    expect(appliedMigrations(db)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const rows = db.prepare('SELECT version FROM schema_migrations WHERE version = 3').all();
    expect(rows).toHaveLength(1);
    db.close();
  });
});
