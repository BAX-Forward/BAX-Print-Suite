import { describe, expect, it } from 'vitest';
import {
  InvalidLayoutTemplateError,
  LayoutTemplateNameConflictError,
  PgLayoutTemplateRepository,
  type DbPort,
  type DbRow,
  type DbValue,
  type NewLayoutTemplate,
} from '../src/index.js';

const LAYOUT_JSON = JSON.stringify({
  placements: [{ itemId: 'a', copy: 0, xPt: 0, yPt: 0, rotation: 0, footprint: { w: 100, h: 50 }, panel: 0 }],
  mediaWidthPt: 3628.35,
});

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';

function template(overrides: Partial<NewLayoutTemplate> = {}): NewLayoutTemplate {
  return { id: 'tpl-1', name: 'Labels 4-up', rollWidthMm: 1280, layoutJson: LAYOUT_JSON, ...overrides };
}

/** A clock that advances one second per call. */
function steppingClock(start = Date.UTC(2026, 0, 1)): () => Date {
  let tick = 0;
  return () => new Date(start + 1000 * tick++);
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const SUMMARY = 'id, name, created_at, updated_at, roll_width_mm';
const FULL = `${SUMMARY}, layout_json::text AS layout_json`;

/** The exact statements PgLayoutTemplateRepository issues, whitespace-normalized. */
const SQL = {
  selectById: `SELECT ${FULL} FROM layout_templates WHERE id = ?`,
  selectByName: `SELECT ${FULL} FROM layout_templates WHERE name = ?`,
  listAll: `SELECT ${SUMMARY} FROM layout_templates ORDER BY name COLLATE "C", id COLLATE "C"`,
  nameHolder: 'SELECT id FROM layout_templates WHERE name = ? AND id <> ?',
  upsert: normalize(`INSERT INTO layout_templates (id, name, created_at, updated_at, roll_width_mm, layout_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      updated_at = EXCLUDED.updated_at,
      roll_width_mm = EXCLUDED.roll_width_mm,
      layout_json = EXCLUDED.layout_json
    RETURNING ${FULL}`),
  rename: `UPDATE layout_templates SET name = ?, updated_at = ? WHERE id = ? RETURNING ${FULL}`,
  deleteById: 'DELETE FROM layout_templates WHERE id = ?',
};

interface Call {
  readonly sql: string;
  readonly params: readonly DbValue[];
  readonly inTransaction: boolean;
}

function text(value: DbValue | undefined): string {
  if (typeof value === 'string') return value;
  throw new TypeError(`expected text, got ${String(value)}`);
}

function num(value: DbValue | undefined): number {
  if (typeof value === 'number') return value;
  throw new TypeError(`expected a number, got ${String(value)}`);
}

function compare(a: unknown, b: unknown): number {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** A stored row by column name. Unchecked except the key, so a test can store a malformed row. */
interface StoredRow {
  readonly id: string;
  readonly name: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly roll_width_mm: unknown;
  readonly layout_json: unknown;
}

function summaryRow(row: StoredRow): DbRow {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    roll_width_mm: row.roll_width_mm,
  };
}

function fullRow(row: StoredRow): DbRow {
  return { ...summaryRow(row), layout_json: row.layout_json };
}

/** In-memory DbPort that answers only the statements the repository issues and records every call. */
class FakeDbPort implements DbPort {
  rows = new Map<string, StoredRow>();
  readonly calls: Call[] = [];
  private depth = 0;

  query(sql: string, params: readonly DbValue[] = []): DbRow[] {
    const statement = this.record(sql, params);
    switch (statement) {
      case SQL.selectById: {
        const row = this.rows.get(text(params[0]));
        return row ? [fullRow(row)] : [];
      }
      case SQL.selectByName: {
        const name = text(params[0]);
        return [...this.rows.values()].filter((row) => row.name === name).map(fullRow);
      }
      case SQL.listAll:
        return [...this.rows.values()]
          .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
          .map(summaryRow);
      case SQL.nameHolder: {
        const name = text(params[0]);
        const id = text(params[1]);
        return [...this.rows.values()]
          .filter((row) => (row.id === id ? false : row.name === name))
          .map((row) => ({ id: row.id }));
      }
      case SQL.upsert:
        return [fullRow(this.upsert(params))];
      case SQL.rename: {
        const [name, updatedAt, id] = params;
        const existing = this.rows.get(text(id));
        if (existing === undefined) return [];
        const row: StoredRow = { ...existing, name: text(name), updated_at: text(updatedAt) };
        this.rows.set(row.id, row);
        return [fullRow(row)];
      }
      default:
        throw new Error(`fake port cannot answer query: ${statement}`);
    }
  }

  exec(sql: string, params: readonly DbValue[] = []): number {
    const statement = this.record(sql, params);
    if (statement === SQL.deleteById) {
      return this.rows.delete(text(params[0])) ? 1 : 0;
    }
    throw new Error(`fake port cannot run statement: ${statement}`);
  }

  transaction<T>(work: () => T): T {
    const snapshot = new Map(this.rows);
    this.depth += 1;
    try {
      return work();
    } catch (error) {
      this.rows = snapshot;
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  private upsert(params: readonly DbValue[]): StoredRow {
    const [id, name, createdAt, updatedAt, rollWidthMm, layoutJson] = params;
    const key = text(id);
    const existing = this.rows.get(key);
    // ON CONFLICT keeps the original created_at.
    const row: StoredRow = {
      id: key,
      name: text(name),
      created_at: existing?.created_at ?? text(createdAt),
      updated_at: text(updatedAt),
      roll_width_mm: num(rollWidthMm),
      layout_json: text(layoutJson),
    };
    this.rows.set(key, row);
    return row;
  }

  private record(sql: string, params: readonly DbValue[]): string {
    const statement = normalize(sql);
    this.calls.push({ sql: statement, params: [...params], inTransaction: this.depth > 0 });
    return statement;
  }
}

function openRepo(): { port: FakeDbPort; repo: PgLayoutTemplateRepository } {
  const port = new FakeDbPort();
  return { port, repo: new PgLayoutTemplateRepository(port, { now: steppingClock() }) };
}

function storedRow(overrides: Partial<Omit<StoredRow, 'id'>> = {}): StoredRow {
  return {
    id: 'bad',
    name: 'Bad',
    created_at: T0,
    updated_at: T0,
    roll_width_mm: 1280,
    layout_json: LAYOUT_JSON,
    ...overrides,
  };
}

function thrown(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('PgLayoutTemplateRepository', () => {
  it('creates a template with a name check and one upsert inside a transaction', () => {
    const { port, repo } = openRepo();

    const saved = repo.save(template({ name: '  Labels 4-up  ' }));

    expect(saved).toStrictEqual({
      id: 'tpl-1',
      name: 'Labels 4-up',
      createdAt: T0,
      updatedAt: T0,
      rollWidthMm: 1280,
      layoutJson: LAYOUT_JSON,
    });
    expect(port.calls).toStrictEqual([
      { sql: SQL.nameHolder, params: ['Labels 4-up', 'tpl-1'], inTransaction: true },
      { sql: SQL.upsert, params: ['tpl-1', 'Labels 4-up', T0, T0, 1280, LAYOUT_JSON], inTransaction: true },
    ]);
  });

  it('gets a template by id and by trimmed name', () => {
    const { port, repo } = openRepo();
    const saved = repo.save(template());

    expect(repo.get('tpl-1')).toStrictEqual(saved);
    expect(port.calls.at(-1)).toStrictEqual({ sql: SQL.selectById, params: ['tpl-1'], inTransaction: false });
    expect(repo.getByName(' Labels 4-up ')).toStrictEqual(saved);
    expect(port.calls.at(-1)).toStrictEqual({ sql: SQL.selectByName, params: ['Labels 4-up'], inTransaction: false });
  });

  it('generates an id when none is given', () => {
    const { repo } = openRepo();
    const saved = repo.save({ name: 'Generated', rollWidthMm: 610, layoutJson: '{"placements":[]}' });
    expect(saved.id).not.toBe('');
    expect(repo.get(saved.id)?.name).toBe('Generated');
  });

  it('updates by id, keeping the creation time', () => {
    const { repo } = openRepo();
    repo.save(template());
    const replaced = repo.save(template({ rollWidthMm: 1600, layoutJson: '{"placements":[]}' }));

    expect(replaced).toMatchObject({ createdAt: T0, updatedAt: T1, rollWidthMm: 1600, layoutJson: '{"placements":[]}' });
    expect(repo.get('tpl-1')).toStrictEqual(replaced);
    expect(repo.list()).toHaveLength(1);
  });

  it('lists by name, then id, without the layout document', () => {
    const { port, repo } = openRepo();
    repo.save(template({ id: 'c', name: 'Charlie' }));
    repo.save(template({ id: 'a', name: 'Alpha' }));
    repo.save(template({ id: 'b', name: 'Bravo' }));

    const listed = repo.list();
    expect(port.calls.at(-1)).toStrictEqual({ sql: SQL.listAll, params: [], inTransaction: false });
    expect(listed.map((item) => item.name)).toStrictEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(listed.every((item) => 'layoutJson' in item === false)).toBe(true);
    expect(listed[0]).toStrictEqual({ id: 'a', name: 'Alpha', createdAt: T1, updatedAt: T1, rollWidthMm: 1280 });
  });

  it('renames a template, trimming the name and touching updatedAt only', () => {
    const { port, repo } = openRepo();
    const saved = repo.save(template());

    const renamed = repo.rename('tpl-1', '  Labels 6-up ');
    expect(renamed).toStrictEqual({ ...saved, name: 'Labels 6-up', updatedAt: T1 });
    expect(port.calls.slice(-2)).toStrictEqual([
      { sql: SQL.nameHolder, params: ['Labels 6-up', 'tpl-1'], inTransaction: true },
      { sql: SQL.rename, params: ['Labels 6-up', T1, 'tpl-1'], inTransaction: true },
    ]);
    expect(repo.getByName('Labels 4-up')).toBeUndefined();
    // Renaming to its own name is not a conflict.
    expect(repo.rename('tpl-1', 'Labels 6-up')?.name).toBe('Labels 6-up');
  });

  it('rejects a name another template already has, on save and on rename, and changes nothing', () => {
    const { port, repo } = openRepo();
    repo.save(template({ id: 'a', name: 'Shared' }));

    expect(() => repo.save(template({ id: 'b', name: ' Shared ' }))).toThrow(LayoutTemplateNameConflictError);
    expect(repo.get('b')).toBeUndefined();

    repo.save(template({ id: 'b', name: 'Other' }));
    const callsBefore = port.calls.length;
    const caught = thrown(() => repo.rename('b', 'Shared'));
    expect(caught).toBeInstanceOf(LayoutTemplateNameConflictError);
    expect(caught).toMatchObject({ code: 'LAYOUT_TEMPLATE_NAME_EXISTS', templateName: 'Shared' });
    expect(port.calls.slice(callsBefore).map((call) => call.sql)).toStrictEqual([SQL.nameHolder]);
    expect(repo.get('b')?.name).toBe('Other');
  });

  it('deletes a template once and frees its name', () => {
    const { port, repo } = openRepo();
    repo.save(template());

    expect(repo.delete('tpl-1')).toBe(true);
    expect(port.calls.at(-1)).toStrictEqual({ sql: SQL.deleteById, params: ['tpl-1'], inTransaction: false });
    expect(repo.delete('tpl-1')).toBe(false);
    expect(repo.get('tpl-1')).toBeUndefined();
    expect(repo.list()).toStrictEqual([]);
    expect(repo.save(template({ id: 'tpl-2' })).name).toBe('Labels 4-up');
  });

  it('returns undefined and false for a missing id', () => {
    const { repo } = openRepo();
    expect(repo.get('missing')).toBeUndefined();
    expect(repo.getByName('missing')).toBeUndefined();
    expect(repo.rename('missing', 'Anything')).toBeUndefined();
    expect(repo.delete('missing')).toBe(false);
    expect(repo.list()).toStrictEqual([]);
  });

  it.each([
    ['a blank name', { name: '   ' }, 'name'],
    ['a name over 120 characters', { name: 'x'.repeat(121) }, 'name'],
    ['a zero roll width', { rollWidthMm: 0 }, 'rollWidthMm'],
    ['a NaN roll width', { rollWidthMm: Number.NaN }, 'rollWidthMm'],
    ['layout JSON that does not parse', { layoutJson: '{placements' }, 'layoutJson'],
    ['layout JSON without placements', { layoutJson: '{"panels":[]}' }, 'layoutJson'],
    ['an empty id', { id: ' ' }, 'id'],
  ] as const)('rejects %s before touching the port', (_label, overrides, field) => {
    const { port, repo } = openRepo();
    const caught = thrown(() => repo.save(template(overrides)));
    expect(caught).toBeInstanceOf(InvalidLayoutTemplateError);
    expect(caught).toMatchObject({ code: 'LAYOUT_TEMPLATE_INVALID', field });
    expect(port.calls).toStrictEqual([]);
  });

  it('rejects an invalid name on rename', () => {
    const { repo } = openRepo();
    repo.save(template());
    expect(() => repo.rename('tpl-1', '  ')).toThrow(InvalidLayoutTemplateError);
    expect(repo.get('tpl-1')?.name).toBe('Labels 4-up');
  });

  it.each([
    ['a missing name', { name: undefined }],
    ['a non-text created_at', { created_at: null }],
    ['a numeric updated_at', { updated_at: 7 }],
    ['a text roll width', { roll_width_mm: '1280' }],
    ['a zero roll width', { roll_width_mm: 0 }],
    ['an infinite roll width', { roll_width_mm: Number.POSITIVE_INFINITY }],
  ] as const)('rejects a stored row with %s from get and list', (_label, overrides) => {
    const { port, repo } = openRepo();
    port.rows.set('bad', storedRow(overrides));
    expect(() => repo.get('bad')).toThrow(TypeError);
    expect(() => repo.list()).toThrow(TypeError);
  });

  it.each([
    ['not text', { layout_json: { placements: [] } }],
    ['not JSON', { layout_json: 'not json' }],
    ['not an object', { layout_json: '[]' }],
    ['without placements', { layout_json: '{"panels":[]}' }],
  ] as const)('rejects a stored row whose layout_json is %s', (_label, overrides) => {
    const { port, repo } = openRepo();
    port.rows.set('bad', storedRow(overrides));
    expect(() => repo.get('bad')).toThrow(TypeError);
    expect(() => repo.getByName('Bad')).toThrow(TypeError);
    // The summary has no layout document, so list still works.
    expect(repo.list().map((item) => item.id)).toStrictEqual(['bad']);
  });

  it('rolls back writes made inside a port transaction that throws', () => {
    const { port, repo } = openRepo();
    repo.save(template({ id: 'kept', name: 'Kept' }));

    expect(() =>
      port.transaction(() => {
        repo.save(template({ id: 'lost', name: 'Lost' }));
        repo.rename('kept', 'Renamed');
        repo.delete('kept');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(repo.get('lost')).toBeUndefined();
    expect(repo.get('kept')?.name).toBe('Kept');

    port.transaction(() => repo.save(template({ id: 'committed', name: 'Committed' })));
    expect(repo.get('committed')?.name).toBe('Committed');
  });
});
