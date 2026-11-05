import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, SqliteWebhookSubscriptionRepository, type StoredWebhookSubscription } from '../src/index.js';

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
