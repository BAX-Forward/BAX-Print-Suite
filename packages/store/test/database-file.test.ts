import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, preparePrivateDatabaseFile } from '../src/index.js';

const isWindows = process.platform === 'win32';

function permissions(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('preparePrivateDatabaseFile (019d)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bps-db-file-'));
    dirs.push(dir);
    return dir;
  }

  it.skipIf(isWindows)('creates a missing database file with mode 0600, including parent directories', () => {
    const path = join(tempDir(), 'nested', 'jobs.db');

    preparePrivateDatabaseFile(path);
    expect(permissions(path)).toBe(0o600);

    const db = openDatabase(path);
    db.exec('CREATE TABLE probe (x INTEGER)');
    db.close();
    expect(permissions(path)).toBe(0o600);
  });

  it.skipIf(isWindows)('narrows an existing database file and its side files to 0600', () => {
    const path = join(tempDir(), 'jobs.db');
    openDatabase(path).close();
    chmodSync(path, 0o644);
    writeFileSync(`${path}-wal`, '');
    chmodSync(`${path}-wal`, 0o644);

    preparePrivateDatabaseFile(path);

    expect(permissions(path)).toBe(0o600);
    expect(permissions(`${path}-wal`)).toBe(0o600);
    expect(existsSync(`${path}-journal`)).toBe(false);
  });

  it('leaves an in-memory database alone', () => {
    expect(() => preparePrivateDatabaseFile(IN_MEMORY)).not.toThrow();
  });
});
