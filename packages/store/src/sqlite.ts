import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);

/**
 * Opens a `node:sqlite` database. Loaded through `createRequire` so bundlers and test runners
 * that do not know the `node:sqlite` builtin leave it to Node. Requires Node 22.13 or later.
 */
export function openDatabase(path: string): DatabaseSync {
  const sqlite = require('node:sqlite') as typeof import('node:sqlite');
  return new sqlite.DatabaseSync(path);
}

export type { DatabaseSync };
