/**
 * Spec 027g: {@link HotFolderRepository} for PostgreSQL, written only against {@link DbPort}.
 *
 * Not wired into the server, and this build ships no PostgreSQL driver: nothing constructs a
 * port for it yet. The SQL uses `?` placeholders as DbPort documents; a driver adapter maps them
 * to its own form. The table is `hot_folders` from PG_MIGRATIONS version 1.
 *
 * `doc` is JSONB there, so it is read back as `doc::text`: the same document, but PostgreSQL
 * normalizes its whitespace and key order. Rows sort with the "C" collation so `list` orders by
 * code point, as the SQLite repository does. The unique `path_key` rule is checked inside one
 * port transaction with the insert, as the SQLite repository checks it before its insert.
 */
import { resolve } from 'node:path';
import { nextUlid, systemClock, withHotFolderDefaults, type Clock, type HotFolder } from '@bax-print/core';
import type { DbPort, DbRow } from './db-port.js';
import {
  DuplicateHotFolderError,
  HotFolderNotFoundError,
  type HotFolderRepository,
  type HotFolderUpdate,
  type NewHotFolder,
} from './interfaces.js';
import { pathKey } from './sqlite-hotfolders.js';

const SELECT_BY_ID = 'SELECT doc::text AS doc FROM hot_folders WHERE id = ?';

const SELECT_BY_PATH_KEY = 'SELECT doc::text AS doc FROM hot_folders WHERE path_key = ?';

const INSERT = 'INSERT INTO hot_folders (id, path_key, created_at, doc) VALUES (?, ?, ?, ?)';

const UPDATE_DOC = 'UPDATE hot_folders SET doc = ? WHERE id = ?';

const LIST_ALL = 'SELECT doc::text AS doc FROM hot_folders ORDER BY created_at COLLATE "C", id COLLATE "C"';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHotFolderDoc(value: unknown): value is HotFolder {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.path === 'string' &&
    typeof value.enabled === 'boolean' &&
    isRecord(value.settings) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

/** The port returns unchecked rows, so the `doc` column is checked before it becomes a HotFolder. */
function parse(row: DbRow): HotFolder {
  const { doc } = row;
  if (typeof doc !== 'string') {
    throw new TypeError('hot_folders row has no doc text');
  }
  const value: unknown = JSON.parse(doc);
  if (!isHotFolderDoc(value)) {
    throw new TypeError('hot_folders row doc is not a hot folder document');
  }
  return value;
}

export class PgHotFolderRepository implements HotFolderRepository {
  /** The port's database must have PG_MIGRATIONS version 1 applied. */
  constructor(
    private readonly port: DbPort,
    private readonly clock: Clock = systemClock,
  ) {}

  async list(): Promise<HotFolder[]> {
    return this.port.query(LIST_ALL).map(parse);
  }

  async get(id: string): Promise<HotFolder | undefined> {
    return this.selectById(id);
  }

  async findByPath(path: string): Promise<HotFolder | undefined> {
    return this.selectByPath(path);
  }

  async create(input: NewHotFolder): Promise<HotFolder> {
    const path = resolve(input.path);
    return this.port.transaction(() => {
      if (this.selectByPath(path)) {
        throw new DuplicateHotFolderError(path);
      }
      const time = this.clock();
      const timestamp = time.toISOString();
      const folder: HotFolder = {
        id: input.id ?? nextUlid(time.getTime()),
        name: input.name,
        path,
        enabled: input.enabled ?? true,
        settings: withHotFolderDefaults(input.settings),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.port.exec(INSERT, [folder.id, pathKey(path), folder.createdAt, JSON.stringify(folder)]);
      return folder;
    });
  }

  async update(id: string, patch: HotFolderUpdate): Promise<HotFolder> {
    return this.port.transaction(() => {
      const current = this.selectById(id);
      if (!current) {
        throw new HotFolderNotFoundError(id);
      }
      const next: HotFolder = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        settings: patch.settings
          ? withHotFolderDefaults({ ...current.settings, ...patch.settings })
          : current.settings,
        updatedAt: this.clock().toISOString(),
      };
      this.port.exec(UPDATE_DOC, [JSON.stringify(next), id]);
      return next;
    });
  }

  private selectById(id: string): HotFolder | undefined {
    const row = this.port.query(SELECT_BY_ID, [id])[0];
    return row ? parse(row) : undefined;
  }

  private selectByPath(path: string): HotFolder | undefined {
    const row = this.port.query(SELECT_BY_PATH_KEY, [pathKey(path)])[0];
    return row ? parse(row) : undefined;
  }
}
