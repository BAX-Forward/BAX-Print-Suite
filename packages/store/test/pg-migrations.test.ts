import { describe, expect, it } from 'vitest';
import { MIGRATIONS, PG_MIGRATIONS } from '../src/index.js';

const MIRRORED_VERSIONS = [1, 2, 3, 4];

const CREATED_OBJECT = /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;

/** `table:name` and `index:name` for every object a migration text creates, in order. */
function createdObjects(sql: string): string[] {
  return [...sql.matchAll(CREATED_OBJECT)].map((match) => `${(match[1] ?? '').toLowerCase()}:${match[2] ?? ''}`);
}

function sqliteSql(version: number): string {
  return MIGRATIONS.find((migration) => migration.version === version)?.sql ?? '';
}

describe('PG_MIGRATIONS (027b)', () => {
  it('lists versions 1-4 in order, matching the sqlite versions', () => {
    expect(PG_MIGRATIONS.map((migration) => migration.version)).toEqual(MIRRORED_VERSIONS);
    const sqliteVersions = MIGRATIONS.map((migration) => migration.version);
    expect(sqliteVersions.slice(0, MIRRORED_VERSIONS.length)).toEqual(MIRRORED_VERSIONS);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PG_MIGRATIONS)).toBe(true);
    for (const migration of PG_MIGRATIONS) expect(Object.isFrozen(migration)).toBe(true);
  });

  it.each(MIRRORED_VERSIONS)('version %i creates every table and index the sqlite version creates', (version) => {
    const expected = createdObjects(sqliteSql(version));
    const pgSql = PG_MIGRATIONS.find((migration) => migration.version === version)?.sql ?? '';

    expect(expected.length).toBeGreaterThan(0);
    expect(createdObjects(pgSql)).toEqual(expected);
  });

  it('contains no sqlite-only syntax', () => {
    for (const { sql } of PG_MIGRATIONS) {
      expect(sql).not.toMatch(/AUTOINCREMENT/i);
      expect(sql).not.toMatch(/PRAGMA/i);
      expect(sql).not.toMatch(/WITHOUT\s+ROWID/i);
      expect(sql).not.toMatch(/datetime\s*\(/i);
    }
  });

  it('ends every statement with a semicolon', () => {
    for (const { sql } of PG_MIGRATIONS) {
      const pieces = sql.split(';');
      // Text after the last semicolon must be blank: no unterminated trailing statement.
      expect(pieces[pieces.length - 1]?.trim()).toBe('');
      // Each terminated piece holds exactly one statement, so none ran into the next.
      for (const statement of pieces.slice(0, -1)) {
        expect(statement.trim()).toMatch(/^CREATE\s/);
        expect(statement.match(/\bCREATE\s/g)).toHaveLength(1);
      }
    }
  });
});
