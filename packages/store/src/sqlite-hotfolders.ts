import { resolve } from 'node:path';
import { nextUlid, systemClock, withHotFolderDefaults, type Clock, type HotFolder } from '@bax-print/core';
import type { Database } from './database.js';
import {
  DuplicateHotFolderError,
  HotFolderNotFoundError,
  type HotFolderRepository,
  type HotFolderUpdate,
  type NewHotFolder,
} from './interfaces.js';

interface DocRow {
  doc: string;
}

/** Comparison key for a folder path: resolved, and case-folded on case-insensitive Windows. */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = resolve(path);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export class SqliteHotFolderRepository implements HotFolderRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async list(): Promise<HotFolder[]> {
    const rows = this.db
      .prepare('SELECT doc FROM hot_folders ORDER BY created_at, id')
      .all() as unknown as DocRow[];
    return rows.map((row) => JSON.parse(row.doc) as HotFolder);
  }

  async get(id: string): Promise<HotFolder | undefined> {
    const row = this.db.prepare('SELECT doc FROM hot_folders WHERE id = ?').get(id) as DocRow | undefined;
    return row ? (JSON.parse(row.doc) as HotFolder) : undefined;
  }

  async findByPath(path: string): Promise<HotFolder | undefined> {
    const row = this.db
      .prepare('SELECT doc FROM hot_folders WHERE path_key = ?')
      .get(pathKey(path)) as DocRow | undefined;
    return row ? (JSON.parse(row.doc) as HotFolder) : undefined;
  }

  async create(input: NewHotFolder): Promise<HotFolder> {
    const path = resolve(input.path);
    if (await this.findByPath(path)) {
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
    this.db
      .prepare('INSERT INTO hot_folders (id, path_key, created_at, doc) VALUES (?, ?, ?, ?)')
      .run(folder.id, pathKey(path), folder.createdAt, JSON.stringify(folder));
    return folder;
  }

  async update(id: string, patch: HotFolderUpdate): Promise<HotFolder> {
    const current = await this.get(id);
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
    this.db.prepare('UPDATE hot_folders SET doc = ? WHERE id = ?').run(JSON.stringify(next), id);
    return next;
  }
}
