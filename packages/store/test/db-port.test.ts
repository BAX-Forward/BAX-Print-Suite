import { describe, expect, it } from 'vitest';
import { openDatabase, SqliteDbPort, type DbPort } from '../src/index.js';

function openPort(): DbPort {
  const port = new SqliteDbPort(openDatabase());
  port.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  return port;
}

function count(port: DbPort): unknown {
  return port.query('SELECT COUNT(*) AS n FROM notes')[0]?.n;
}

describe('SqliteDbPort', () => {
  it('binds params in placeholder order and returns rows keyed by column', () => {
    const port = openPort();
    port.exec('INSERT INTO notes (id, body) VALUES (?, ?)', [2, 'second']);
    port.exec('INSERT INTO notes (id, body) VALUES (?, ?)', [1, 'first']);

    expect(port.query('SELECT id, body FROM notes ORDER BY id')).toEqual([
      { id: 1, body: 'first' },
      { id: 2, body: 'second' },
    ]);
    expect(port.query('SELECT body FROM notes WHERE id = ?', [2])).toEqual([{ body: 'second' }]);
    expect(port.query('SELECT body FROM notes WHERE id = ?', [3])).toEqual([]);
  });

  it('returns the number of changed rows from exec', () => {
    const port = openPort();
    expect(port.exec('INSERT INTO notes (id, body) VALUES (?, ?), (?, ?)', [1, 'a', 2, 'b'])).toBe(2);
    expect(port.exec('UPDATE notes SET body = ? WHERE id = ?', ['c', 1])).toBe(1);
    expect(port.exec('DELETE FROM notes WHERE id = ?', [9])).toBe(0);
    expect(port.exec('DELETE FROM notes')).toBe(2);
  });

  it('commits a transaction and returns its result', () => {
    const port = openPort();
    const result = port.transaction(() => {
      port.exec('INSERT INTO notes (id, body) VALUES (?, ?)', [1, 'kept']);
      return 'done';
    });

    expect(result).toBe('done');
    expect(count(port)).toBe(1);
  });

  it('rolls back a transaction that throws and rethrows the error', () => {
    const port = openPort();
    port.exec('INSERT INTO notes (id, body) VALUES (?, ?)', [1, 'before']);
    const failure = new Error('stop');

    expect(() =>
      port.transaction(() => {
        port.exec('INSERT INTO notes (id, body) VALUES (?, ?)', [2, 'discarded']);
        port.exec('UPDATE notes SET body = ? WHERE id = ?', ['changed', 1]);
        throw failure;
      }),
    ).toThrow(failure);

    expect(port.query('SELECT id, body FROM notes ORDER BY id')).toEqual([{ id: 1, body: 'before' }]);
    // The rollback ended the transaction, so a new one can start.
    port.transaction(() => port.exec('INSERT INTO notes (id, body) VALUES (?, ?)', [3, 'after']));
    expect(count(port)).toBe(2);
  });
});
