import type { Database } from './database.js';
import { isSealed, SecretDecryptError, type SecretBox } from './secret-box.js';

/**
 * Spec 019c: webhook subscriptions in the job database (migration 2).
 * Spec 019d: with a `SecretBox`, secrets are sealed at rest.
 */

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

/** A stored secret as plaintext. A sealed value with no box to open it fails closed. */
function openSecret(id: string, stored: string, box: SecretBox | undefined): string {
  if (!isSealed(stored)) {
    return stored;
  }
  if (box === undefined) {
    throw new SecretDecryptError('no-key', `webhook subscription ${id} has a sealed secret and no secrets key is configured`);
  }
  return box.open(stored, id);
}

/** Runs `work` in one transaction: every row changes or none does. */
function inTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

interface StoredSecretRow {
  id: string;
  secret: string;
}

/** Rewrites every secret through `reseal`, in one transaction. Returns how many rows changed. */
function rewriteSecrets(db: Database, reseal: (row: StoredSecretRow) => string | undefined): number {
  return inTransaction(db, () => {
    const rows = db.prepare('SELECT id, secret FROM webhook_subscriptions ORDER BY id').all() as unknown as StoredSecretRow[];
    const update = db.prepare('UPDATE webhook_subscriptions SET secret = ? WHERE id = ?');
    let changed = 0;
    for (const row of rows) {
      const next = reseal(row);
      if (next !== undefined) {
        update.run(next, row.id);
        changed += 1;
      }
    }
    return changed;
  });
}

/** Seals every plaintext secret under `box`; already sealed rows are left alone. Run at startup. */
export function reencryptPlaintextSecrets(db: Database, box: SecretBox): number {
  return rewriteSecrets(db, (row) => (isSealed(row.secret) ? undefined : box.seal(row.secret, row.id)));
}

/**
 * Re-seals every secret under `newBox`'s key version: sealed rows are opened with `oldBox`,
 * plaintext rows are sealed too. Any row that `oldBox` cannot open aborts the whole rotation.
 */
export function rotateSecretsKey(db: Database, oldBox: SecretBox, newBox: SecretBox): number {
  if (oldBox.version === newBox.version) {
    throw new RangeError('the new secrets key must have a different key version from the old one');
  }
  return rewriteSecrets(db, (row) => newBox.seal(openSecret(row.id, row.secret, oldBox), row.id));
}

export class SqliteWebhookSubscriptionRepository implements WebhookSubscriptionRepository {
  /**
   * `db` must come from `openDatabase`, which applies the migrations. Without `box`, secrets are
   * stored as plaintext (and sealed rows cannot be read).
   */
  constructor(
    private readonly db: Database,
    private readonly box?: SecretBox,
  ) {}

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
    return row ? Object.freeze({ ...toSummary(row), secret: openSecret(row.id, row.secret, this.box) }) : undefined;
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
        this.box ? this.box.seal(subscription.secret, subscription.id) : subscription.secret,
      );
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}
