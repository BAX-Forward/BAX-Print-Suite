import type { Database } from './database.js';
import type { DbPort, DbRow, DbValue } from './db-port.js';

function isRow(value: unknown): value is DbRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Spec 027a: {@link DbPort} over a database handle from `openDatabase`. */
export class SqliteDbPort implements DbPort {
  constructor(private readonly db: Database) {}

  query(sql: string, params: readonly DbValue[] = []): DbRow[] {
    const rows: unknown[] = this.db.prepare(sql).all(...params);
    return rows.map((row) => {
      if (!isRow(row)) {
        throw new TypeError('sqlite returned a row that is not an object');
      }
      return row;
    });
  }

  exec(sql: string, params: readonly DbValue[] = []): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  /** `BEGIN IMMEDIATE` takes the write lock up front, so checks and writes cannot interleave. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
