import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isSealed,
  openDatabase,
  reencryptPlaintextSecrets,
  rotateSecretsKey,
  SecretBox,
  SecretDecryptError,
  SqliteWebhookSubscriptionRepository,
  type Database,
  type StoredWebhookSubscription,
} from '../src/index.js';

const SECRET = 'test-secret-not-real-0000';

function subscription(overrides: Partial<StoredWebhookSubscription> = {}): StoredWebhookSubscription {
  return {
    id: 'sub-1',
    url: 'https://hooks.example.com/bps',
    secret: SECRET,
    eventTypes: ['job.created', 'job.status.changed'],
    active: true,
    ...overrides,
  };
}

describe('SqliteWebhookSubscriptionRepository', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a subscription; only getWithSecret returns the secret', () => {
    const repo = new SqliteWebhookSubscriptionRepository(openDatabase());
    repo.put(subscription());

    expect(repo.getWithSecret('sub-1')).toEqual(subscription());
    expect(repo.get('sub-1')).toEqual({
      id: 'sub-1',
      url: 'https://hooks.example.com/bps',
      eventTypes: ['job.created', 'job.status.changed'],
      active: true,
    });
    expect(repo.get('sub-1')).not.toHaveProperty('secret');
    expect(repo.get('missing')).toBeUndefined();
    expect(repo.getWithSecret('missing')).toBeUndefined();
  });

  it('lists by id without secrets', () => {
    const repo = new SqliteWebhookSubscriptionRepository(openDatabase());
    repo.put(subscription({ id: 'b', active: false, eventTypes: ['*'] }));
    repo.put(subscription({ id: 'a' }));

    const listed = repo.list();
    expect(listed.map((item) => [item.id, item.active])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect(listed.every((item) => !('secret' in item))).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  it('replaces by id and deletes', () => {
    const repo = new SqliteWebhookSubscriptionRepository(openDatabase());
    repo.put(subscription());
    repo.put(subscription({ url: 'https://other.example.com/', secret: 'another-test-secret-0000', active: false }));

    expect(repo.getWithSecret('sub-1')).toMatchObject({ url: 'https://other.example.com/', secret: 'another-test-secret-0000', active: false });
    expect(repo.list()).toHaveLength(1);
    expect(repo.delete('sub-1')).toBe(true);
    expect(repo.delete('sub-1')).toBe(false);
    expect(repo.list()).toEqual([]);
  });

  it('keeps subscriptions across reopening the database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bps-webhooks-'));
    dirs.push(dir);
    const path = join(dir, 'jobs.db');

    const first = openDatabase(path);
    new SqliteWebhookSubscriptionRepository(first).put(subscription());
    first.close();

    const second = openDatabase(path);
    expect(new SqliteWebhookSubscriptionRepository(second).getWithSecret('sub-1')).toEqual(subscription());
    second.close();
  });

  it('rejects a row with malformed event types', () => {
    const db = openDatabase();
    db.prepare('INSERT INTO webhook_subscriptions (id, url, event_types, active, secret) VALUES (?, ?, ?, ?, ?)').run(
      'bad',
      'https://hooks.example.com/',
      '{"not":"a list"}',
      1,
      SECRET,
    );
    expect(() => new SqliteWebhookSubscriptionRepository(db).get('bad')).toThrow(TypeError);
  });
});

function secretsBox(version = 1): SecretBox {
  return new SecretBox({ version, key: randomBytes(32) });
}

/** The secret column exactly as stored, by id. */
function storedSecrets(db: Database): Map<string, string> {
  const rows = db.prepare('SELECT id, secret FROM webhook_subscriptions ORDER BY id').all() as unknown as Array<{
    id: string;
    secret: string;
  }>;
  return new Map(rows.map((row) => [row.id, row.secret]));
}

describe('SqliteWebhookSubscriptionRepository with a SecretBox (019d)', () => {
  it('stores sealed secrets and opens them on read', () => {
    const db = openDatabase();
    const box = secretsBox();
    const repo = new SqliteWebhookSubscriptionRepository(db, box);
    repo.put(subscription());

    const stored = storedSecrets(db).get('sub-1') ?? '';
    expect(isSealed(stored)).toBe(true);
    expect(stored).not.toContain(SECRET);
    expect(box.open(stored, 'sub-1')).toBe(SECRET);
    expect(repo.getWithSecret('sub-1')).toEqual(subscription());
    expect(repo.list()).toHaveLength(1);
  });

  it('fails closed when the configured key does not match the stored secrets', () => {
    const db = openDatabase();
    new SqliteWebhookSubscriptionRepository(db, secretsBox()).put(subscription());

    expect(() => new SqliteWebhookSubscriptionRepository(db, secretsBox()).getWithSecret('sub-1')).toThrow(SecretDecryptError);
  });

  it('fails closed when a sealed secret is read without a key', () => {
    const db = openDatabase();
    new SqliteWebhookSubscriptionRepository(db, secretsBox()).put(subscription());

    const repo = new SqliteWebhookSubscriptionRepository(db);
    expect(() => repo.getWithSecret('sub-1')).toThrow(SecretDecryptError);
    // Summaries do not need the secret.
    expect(repo.get('sub-1')).toMatchObject({ id: 'sub-1' });
  });

  it('rejects a sealed secret moved onto another row', () => {
    const db = openDatabase();
    const box = secretsBox();
    const repo = new SqliteWebhookSubscriptionRepository(db, box);
    repo.put(subscription({ id: 'a' }));
    repo.put(subscription({ id: 'b', secret: 'other-test-secret-0000' }));

    db.prepare('UPDATE webhook_subscriptions SET secret = ? WHERE id = ?').run(storedSecrets(db).get('a') ?? '', 'b');
    expect(() => repo.getWithSecret('b')).toThrow(SecretDecryptError);
  });
});

describe('reencryptPlaintextSecrets', () => {
  it('seals every plaintext row and leaves sealed rows alone', () => {
    const db = openDatabase();
    const plain = new SqliteWebhookSubscriptionRepository(db);
    plain.put(subscription({ id: 'a', secret: 'first-test-secret-0000' }));
    plain.put(subscription({ id: 'b', secret: 'second-test-secret-0000' }));
    const box = secretsBox();

    expect(reencryptPlaintextSecrets(db, box)).toBe(2);
    const stored = storedSecrets(db);
    expect([...stored.values()].every(isSealed)).toBe(true);
    expect(JSON.stringify([...stored.values()])).not.toContain('test-secret');

    const sealedRepo = new SqliteWebhookSubscriptionRepository(db, box);
    expect(sealedRepo.getWithSecret('a')?.secret).toBe('first-test-secret-0000');
    expect(sealedRepo.getWithSecret('b')?.secret).toBe('second-test-secret-0000');

    // A second run finds nothing to do and does not re-seal.
    expect(reencryptPlaintextSecrets(db, box)).toBe(0);
    expect(storedSecrets(db)).toEqual(stored);
  });

  it('is a no-op on an empty table', () => {
    expect(reencryptPlaintextSecrets(openDatabase(), secretsBox())).toBe(0);
  });
});

describe('rotateSecretsKey', () => {
  it('re-seals every row under the new key version', () => {
    const db = openDatabase();
    const oldBox = secretsBox(1);
    const newBox = secretsBox(2);
    const repo = new SqliteWebhookSubscriptionRepository(db, oldBox);
    repo.put(subscription({ id: 'a', secret: 'first-test-secret-0000' }));
    repo.put(subscription({ id: 'b', secret: 'second-test-secret-0000' }));

    expect(rotateSecretsKey(db, oldBox, newBox)).toBe(2);

    for (const [id, stored] of storedSecrets(db)) {
      expect(isSealed(stored)).toBe(true);
      expect(() => oldBox.open(stored, id)).toThrow(SecretDecryptError);
    }
    expect(() => repo.getWithSecret('a')).toThrow(SecretDecryptError);
    const rotated = new SqliteWebhookSubscriptionRepository(db, newBox);
    expect(rotated.getWithSecret('a')?.secret).toBe('first-test-secret-0000');
    expect(rotated.getWithSecret('b')?.secret).toBe('second-test-secret-0000');
  });

  it('also seals rows that were still plaintext', () => {
    const db = openDatabase();
    new SqliteWebhookSubscriptionRepository(db).put(subscription());
    const newBox = secretsBox(2);

    expect(rotateSecretsKey(db, secretsBox(1), newBox)).toBe(1);
    expect(new SqliteWebhookSubscriptionRepository(db, newBox).getWithSecret('sub-1')?.secret).toBe(SECRET);
  });

  it('changes nothing when any row cannot be opened with the old key', () => {
    const db = openDatabase();
    const oldBox = secretsBox(1);
    new SqliteWebhookSubscriptionRepository(db, oldBox).put(subscription({ id: 'a' }));
    new SqliteWebhookSubscriptionRepository(db, secretsBox(1)).put(subscription({ id: 'b' }));
    const before = storedSecrets(db);

    expect(() => rotateSecretsKey(db, oldBox, secretsBox(2))).toThrow(SecretDecryptError);
    expect(storedSecrets(db)).toEqual(before);
    expect(new SqliteWebhookSubscriptionRepository(db, oldBox).getWithSecret('a')?.secret).toBe(SECRET);
  });

  it('refuses a new key with the same version as the old one', () => {
    expect(() => rotateSecretsKey(openDatabase(), secretsBox(1), secretsBox(1))).toThrow(RangeError);
  });
});
