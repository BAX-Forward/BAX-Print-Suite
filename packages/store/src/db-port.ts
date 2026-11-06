/**
 * Spec 027a: the smallest database port a repository needs. Plain types only, so a repository
 * written against it does not depend on a particular driver.
 */

/** A value bound to a `?` placeholder, in placeholder order. */
export type DbValue = null | number | bigint | string | Uint8Array;

/** One result row, keyed by column name. Values are unchecked; the repository validates them. */
export type DbRow = Readonly<Record<string, unknown>>;

export interface DbPort {
  /** Runs a statement and returns every row it produces. */
  query(sql: string, params?: readonly DbValue[]): DbRow[];
  /** Runs a statement and returns the number of rows it changed. */
  exec(sql: string, params?: readonly DbValue[]): number;
  /** Runs `work` in one transaction: commits when it returns, rolls back and rethrows when it throws. */
  transaction<T>(work: () => T): T;
}
