import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebhookSubscription } from '@bax-print/events';
import {
  isSealed,
  openDatabase,
  SECRETS_KEY_ENV,
  SecretKeyError,
  SqliteWebhookSubscriptionRepository,
  type Database,
} from '@bax-print/store';
import { MemoryWebhookSubscriptionStore } from '../src/stores.js';
import {
  DATABASE_ENV,
  openWebhookPersistence,
  UNENCRYPTED_SECRETS_WARNING,
  type WebhookPersistence,
} from '../src/webhook-persistence.js';

const SECRET = 'test-secret-not-real-0000';
const isWindows = process.platform === 'win32';

const SUBSCRIPTION: WebhookSubscription = {
  id: 'sub-1',
  url: 'https://hooks.example.com/bps',
  secret: SECRET,
  eventTypes: ['job.created'],
  active: true,
};

function storedSecret(db: Database, id: string): string | undefined {
  const row = db.prepare('SELECT secret FROM webhook_subscriptions WHERE id = ?').get(id) as unknown as
    | { secret: string }
    | undefined;
  return row?.secret;
}

describe('openWebhookPersistence (019d)', () => {
  const dirs: string[] = [];
  const opened: WebhookPersistence[] = [];

  afterEach(() => {
    for (const persistence of opened.splice(0)) persistence.database?.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function databasePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bps-webhook-persistence-'));
    dirs.push(dir);
    return join(dir, 'jobs.db');
  }

  function open(env: Record<string, string | undefined>): WebhookPersistence {
    const persistence = openWebhookPersistence(env);
    opened.push(persistence);
    return persistence;
  }

  it('keeps subscriptions in memory without a database and warns about nothing', () => {
    const persistence = open({});
    expect(persistence.store).toBeInstanceOf(MemoryWebhookSubscriptionStore);
    expect(persistence.database).toBeUndefined();
    expect(persistence.warnings).toEqual([]);
  });

  it('warns once that secrets are unencrypted when a database has no key', () => {
    const persistence = open({ [DATABASE_ENV]: databasePath() });
    expect(persistence.warnings).toEqual([UNENCRYPTED_SECRETS_WARNING]);

    persistence.store.put(SUBSCRIPTION);
    const database = persistence.database;
    expect(database).toBeDefined();
    if (database !== undefined) expect(storedSecret(database, 'sub-1')).toBe(SECRET);
  });

  it('seals secrets and does not warn when a key is configured', () => {
    const key = randomBytes(32).toString('base64');
    const persistence = open({ [DATABASE_ENV]: databasePath(), [SECRETS_KEY_ENV]: key });
    expect(persistence.warnings).toEqual([]);

    persistence.store.put(SUBSCRIPTION);
    const database = persistence.database;
    expect(database).toBeDefined();
    if (database !== undefined) expect(isSealed(storedSecret(database, 'sub-1') ?? '')).toBe(true);
    expect(persistence.store.getWithSecret('sub-1')?.secret).toBe(SECRET);
  });

  it('seals plaintext rows left from before a key was configured', () => {
    const path = databasePath();
    const before = openDatabase(path);
    new SqliteWebhookSubscriptionRepository(before).put(SUBSCRIPTION);
    before.close();

    const persistence = open({ [DATABASE_ENV]: path, [SECRETS_KEY_ENV]: randomBytes(32).toString('base64') });
    const database = persistence.database;
    expect(database).toBeDefined();
    if (database !== undefined) expect(isSealed(storedSecret(database, 'sub-1') ?? '')).toBe(true);
    expect(persistence.store.getWithSecret('sub-1')?.secret).toBe(SECRET);
  });

  it('refuses to start with a key that is present but unusable', () => {
    const key = randomBytes(16).toString('base64');
    expect(() => openWebhookPersistence({ [DATABASE_ENV]: databasePath(), [SECRETS_KEY_ENV]: key })).toThrow(SecretKeyError);
  });

  it.skipIf(isWindows)('creates the database file with mode 0600', () => {
    const path = databasePath();
    open({ [DATABASE_ENV]: path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
