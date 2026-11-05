import type { Database } from './database.js';

/** Spec 019c: webhook subscriptions in the job database (migration 2). */

/** A subscription with its signing secret, as the dispatcher needs it. */
export interface StoredWebhookSubscription {
  readonly id: string;
  readonly url: string;
  readonly secret: string;
  readonly eventTypes: readonly string[];
  readonly active: boolean;
}

/** A subscription without its secret: what `list` and `get` return. */
export type WebhookSubscriptionSummary = Omit<StoredWebhookSubscription, 'secret'>;

/** Synchronous because the dispatcher reads the list on every event. */
export interface WebhookSubscriptionRepository {
  /** Ordered by id. Never includes secrets. */
  list(): WebhookSubscriptionSummary[];
  get(id: string): WebhookSubscriptionSummary | undefined;
  /** The only read that returns the secret; for delivery, never for API responses. */
  getWithSecret(id: string): StoredWebhookSubscription | undefined;
  /** Inserts or replaces by id. */
  put(subscription: StoredWebhookSubscription): void;
  delete(id: string): boolean;
}

interface SummaryRow {
  id: string;
  url: string;
  event_types: string;
  active: number | bigint;
}

interface SecretRow extends SummaryRow {
  secret: string;
}

const SUMMARY_COLUMNS = 'id, url, event_types, active';

function parseEventTypes(id: string, text: string): readonly string[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new TypeError(`webhook subscription ${id} has malformed event types`);
  }
  return Object.freeze([...value]);
}

function toSummary(row: SummaryRow): WebhookSubscriptionSummary {
  return Object.freeze({
    id: row.id,
    url: row.url,
    eventTypes: parseEventTypes(row.id, row.event_types),
    active: Number(row.active) !== 0,
  });
}

export class SqliteWebhookSubscriptionRepository implements WebhookSubscriptionRepository {
  /** `db` must come from `openDatabase`, which applies the migrations. */
  constructor(private readonly db: Database) {}

  list(): WebhookSubscriptionSummary[] {
    const rows = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM webhook_subscriptions ORDER BY id`)
      .all() as unknown as SummaryRow[];
    return rows.map(toSummary);
  }

  get(id: string): WebhookSubscriptionSummary | undefined {
    const row = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM webhook_subscriptions WHERE id = ?`)
      .get(id) as unknown as SummaryRow | undefined;
    return row ? toSummary(row) : undefined;
  }

  getWithSecret(id: string): StoredWebhookSubscription | undefined {
    const row = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS}, secret FROM webhook_subscriptions WHERE id = ?`)
      .get(id) as unknown as SecretRow | undefined;
    return row ? Object.freeze({ ...toSummary(row), secret: row.secret }) : undefined;
  }

  put(subscription: StoredWebhookSubscription): void {
    this.db
      .prepare(
        `INSERT INTO webhook_subscriptions (id, url, event_types, active, secret) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET url = excluded.url, event_types = excluded.event_types,
           active = excluded.active, secret = excluded.secret`,
      )
      .run(
        subscription.id,
        subscription.url,
        JSON.stringify(subscription.eventTypes),
        subscription.active ? 1 : 0,
        subscription.secret,
      );
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}
