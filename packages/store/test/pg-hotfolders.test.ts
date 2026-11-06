import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Clock } from '@bax-print/core';
import {
  DuplicateHotFolderError,
  HotFolderNotFoundError,
  PgHotFolderRepository,
  pathKey,
  type DbPort,
  type DbRow,
  type DbValue,
} from '../src/index.js';

const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-01T09:00:01.000Z';
const T2 = '2026-03-01T09:00:02.000Z';

const PATH_A = resolve('hot', 'a');
const PATH_B = resolve('hot', 'b');
const PATH_C = resolve('hot', 'c');

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** The exact statements PgHotFolderRepository issues, whitespace-normalized. */
const SQL = {
  selectById: 'SELECT doc::text AS doc FROM hot_folders WHERE id = ?',
  selectByPathKey: 'SELECT doc::text AS doc FROM hot_folders WHERE path_key = ?',
  insert: 'INSERT INTO hot_folders (id, path_key, created_at, doc) VALUES (?, ?, ?, ?)',
  updateDoc: 'UPDATE hot_folders SET doc = ? WHERE id = ?',
  listAll: 'SELECT doc::text AS doc FROM hot_folders ORDER BY created_at COLLATE "C", id COLLATE "C"',
};

interface StoredRow {
  readonly id: string;
  readonly pathKey: string;
  readonly createdAt: string;
  /** Unchecked, so a test can store a malformed document. */
  readonly doc: unknown;
}

interface Call {
  readonly sql: string;
  readonly params: readonly DbValue[];
  readonly inTransaction: boolean;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(`expected text, got ${String(value)}`);
  return value;
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
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
        return row ? [{ doc: row.doc }] : [];
      }
      case SQL.selectByPathKey: {
        const key = text(params[0]);
        return [...this.rows.values()].filter((row) => row.pathKey === key).map((row) => ({ doc: row.doc }));
      }
      case SQL.listAll:
        return [...this.rows.values()]
          .sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id))
          .map((row) => ({ doc: row.doc }));
      default:
        throw new Error(`fake port cannot answer query: ${statement}`);
    }
  }

  exec(sql: string, params: readonly DbValue[] = []): number {
    const statement = this.record(sql, params);
    switch (statement) {
      case SQL.insert: {
        const [id, key, createdAt, doc] = params;
        const row: StoredRow = { id: text(id), pathKey: text(key), createdAt: text(createdAt), doc: text(doc) };
        // The PRIMARY KEY and UNIQUE (path_key) constraints from PG_MIGRATIONS version 1.
        if (this.rows.has(row.id) || [...this.rows.values()].some((other) => other.pathKey === row.pathKey)) {
          throw new Error('duplicate key value violates unique constraint');
        }
        this.rows.set(row.id, row);
        return 1;
      }
      case SQL.updateDoc: {
        const id = text(params[1]);
        const existing = this.rows.get(id);
        if (!existing) return 0;
        this.rows.set(id, { ...existing, doc: text(params[0]) });
        return 1;
      }
      default:
        throw new Error(`fake port cannot run statement: ${statement}`);
    }
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

  storedDoc(id: string): unknown {
    return JSON.parse(text(this.rows.get(id)?.doc));
  }

  private record(sql: string, params: readonly DbValue[]): string {
    const statement = normalize(sql);
    this.calls.push({ sql: statement, params: [...params], inTransaction: this.depth > 0 });
    return statement;
  }
}

/** Returns each time in turn, then keeps returning the last one. */
function clockOf(...times: string[]): Clock {
  let index = 0;
  return () => {
    const time = times[Math.min(index, times.length - 1)] ?? T0;
    index += 1;
    return new Date(time);
  };
}

function badRow(doc: unknown): StoredRow {
  return { id: 'bad', pathKey: pathKey(PATH_A), createdAt: T0, doc };
}

describe('PgHotFolderRepository', () => {
  it('creates a folder inside one transaction and round-trips the document', async () => {
    const port = new FakeDbPort();
    const repo = new PgHotFolderRepository(port, clockOf(T0));

    const folder = await repo.create({ id: 'hf-1', name: 'Banners', path: join(PATH_A, '..', 'a'), settings: { defaultPriority: 80 } });

    expect(folder).toMatchObject({
      id: 'hf-1',
      name: 'Banners',
      path: PATH_A,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
      settings: { defaultPriority: 80 },
    });
    expect(port.calls.map(({ sql, inTransaction }) => ({ sql, inTransaction }))).toStrictEqual([
      { sql: SQL.selectByPathKey, inTransaction: true },
      { sql: SQL.insert, inTransaction: true },
    ]);
    expect(port.calls[1]?.params.slice(0, 3)).toStrictEqual(['hf-1', pathKey(PATH_A), T0]);
    expect(port.storedDoc('hf-1')).toStrictEqual(folder);
    expect(await repo.get('hf-1')).toStrictEqual(folder);
    expect(port.calls.at(-1)).toMatchObject({ sql: SQL.selectById, params: ['hf-1'] });
    expect(await repo.findByPath(join(PATH_A, '.'))).toStrictEqual(folder);
    expect(port.calls.at(-1)).toMatchObject({ sql: SQL.selectByPathKey, params: [pathKey(PATH_A)] });
  });

  it('generates an id when none is given', async () => {
    const repo = new PgHotFolderRepository(new FakeDbPort(), clockOf(T0));
    const folder = await repo.create({ name: 'Auto', path: PATH_A, enabled: false });

    expect(folder.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(folder.enabled).toBe(false);
    expect(await repo.get(folder.id)).toStrictEqual(folder);
  });

  it('returns undefined for a missing folder and rejects updating it', async () => {
    const port = new FakeDbPort();
    const repo = new PgHotFolderRepository(port);

    expect(await repo.get('missing')).toBeUndefined();
    expect(await repo.findByPath(PATH_A)).toBeUndefined();
    expect(await repo.list()).toStrictEqual([]);
    await expect(repo.update('missing', { name: 'x' })).rejects.toBeInstanceOf(HotFolderNotFoundError);
    expect(port.calls.some((call) => call.sql === SQL.updateDoc)).toBe(false);
  });

  it('overwrites name, enabled and merged settings, keeping createdAt', async () => {
    const port = new FakeDbPort();
    const repo = new PgHotFolderRepository(port, clockOf(T0, T1, T2));
    const created = await repo.create({ id: 'hf-1', name: 'Banners', path: PATH_A, settings: { defaultPriority: 80 } });

    const renamed = await repo.update('hf-1', { name: 'Posters', settings: { dedupe: false } });
    expect(renamed).toStrictEqual({
      ...created,
      name: 'Posters',
      settings: { ...created.settings, dedupe: false },
      updatedAt: T1,
    });
    expect(port.calls.at(-1)).toMatchObject({ sql: SQL.updateDoc, inTransaction: true });
    expect(port.calls.at(-1)?.params[1]).toBe('hf-1');
    expect(port.storedDoc('hf-1')).toStrictEqual(renamed);

    const disabled = await repo.update('hf-1', { enabled: false });
    expect(disabled).toStrictEqual({ ...renamed, enabled: false, updatedAt: T2 });
    expect(await repo.get('hf-1')).toStrictEqual(disabled);
    expect(await repo.list()).toHaveLength(1);
  });

  it('lists by creation time, then id', async () => {
    const repo = new PgHotFolderRepository(new FakeDbPort(), clockOf(T1, T0, T1));
    await repo.create({ id: 'c', name: 'C', path: PATH_C });
    await repo.create({ id: 'z', name: 'Z', path: PATH_B });
    await repo.create({ id: 'a', name: 'A', path: PATH_A });

    expect((await repo.list()).map((folder) => folder.id)).toStrictEqual(['z', 'a', 'c']);
  });

  it('rejects a second folder for the same path without inserting', async () => {
    const port = new FakeDbPort();
    const repo = new PgHotFolderRepository(port);
    await repo.create({ id: 'hf-1', name: 'First', path: PATH_A });

    const duplicate = repo.create({ id: 'hf-2', name: 'Second', path: join(PATH_A, '..', 'a', '.') });
    await expect(duplicate).rejects.toBeInstanceOf(DuplicateHotFolderError);
    await expect(duplicate).rejects.toMatchObject({ path: PATH_A });

    expect(port.calls.filter((call) => call.sql === SQL.insert)).toHaveLength(1);
    expect(await repo.get('hf-2')).toBeUndefined();
    expect((await repo.list()).map((folder) => folder.id)).toStrictEqual(['hf-1']);
  });

  it('rejects rows whose doc is not a hot folder document', async () => {
    const port = new FakeDbPort();
    const repo = new PgHotFolderRepository(port);
    const valid = {
      id: 'bad',
      name: 'Bad',
      path: PATH_A,
      enabled: true,
      settings: {},
      createdAt: T0,
      updatedAt: T0,
    };

    port.rows.set('bad', badRow(42));
    await expect(repo.get('bad')).rejects.toBeInstanceOf(TypeError);
    await expect(repo.list()).rejects.toBeInstanceOf(TypeError);
    await expect(repo.findByPath(PATH_A)).rejects.toBeInstanceOf(TypeError);
    await expect(repo.update('bad', { name: 'x' })).rejects.toBeInstanceOf(TypeError);

    const broken = [
      'null',
      '[]',
      '"folder"',
      '{"id":"bad"}',
      JSON.stringify({ ...valid, enabled: 'yes' }),
      JSON.stringify({ ...valid, settings: null }),
      JSON.stringify({ ...valid, settings: [] }),
      JSON.stringify({ ...valid, path: 7 }),
    ];
    for (const doc of broken) {
      port.rows.set('bad', badRow(doc));
      await expect(repo.get('bad')).rejects.toBeInstanceOf(TypeError);
    }

    port.rows.set('bad', badRow('not json'));
    await expect(repo.get('bad')).rejects.toBeInstanceOf(SyntaxError);

    port.rows.set('bad', badRow(JSON.stringify(valid)));
    expect(await repo.get('bad')).toStrictEqual(valid);
  });

  it('rolls back writes made inside a port transaction that throws', async () => {
    const port = new FakeDbPort();
    const repo = new PgHotFolderRepository(port, clockOf(T0, T1));
    const kept = await repo.create({ id: 'kept', name: 'Kept', path: PATH_A });
    const pending: Promise<unknown>[] = [];

    expect(() =>
      port.transaction(() => {
        pending.push(repo.create({ id: 'lost', name: 'Lost', path: PATH_B }), repo.update('kept', { name: 'Renamed' }));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    await Promise.all(pending);

    expect(await repo.get('lost')).toBeUndefined();
    expect(await repo.findByPath(PATH_B)).toBeUndefined();
    expect(await repo.get('kept')).toStrictEqual(kept);
  });

  it('rolls back its own transaction when the insert fails', async () => {
    const port = new FakeDbPort();
    const repo = new PgHotFolderRepository(port);
    await repo.create({ id: 'hf-1', name: 'First', path: PATH_A });

    // Same id on a new path: the check passes, then the primary key rejects the insert.
    await expect(repo.create({ id: 'hf-1', name: 'Clash', path: PATH_B })).rejects.toThrow('unique constraint');

    expect(await repo.findByPath(PATH_B)).toBeUndefined();
    expect((await repo.get('hf-1'))?.name).toBe('First');
  });
});
