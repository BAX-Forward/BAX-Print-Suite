import {
  loadSecretsKey,
  openDatabase,
  preparePrivateDatabaseFile,
  reencryptPlaintextSecrets,
  SecretBox,
  SqliteWebhookSubscriptionRepository,
  type Database,
} from '@bax-print/store';
import { MemoryWebhookSubscriptionStore, type WebhookSubscriptionStore } from './stores.js';

/** Spec 019c/019d: where webhook subscriptions live and whether their secrets are sealed. */

export const DATABASE_ENV = 'BPS_DATABASE';
/** Version byte for keys loaded from the environment; rotation uses `rotateSecretsKey`. */
export const SECRETS_KEY_VERSION = 1;
export const UNENCRYPTED_SECRETS_WARNING =
  'webhook secrets are stored unencrypted in the database (set BPS_SECRETS_KEY or BPS_SECRETS_KEY_FILE to encrypt them at rest)';

export interface WebhookPersistence {
  readonly store: WebhookSubscriptionStore;
  /** Present when `BPS_DATABASE` names a SQLite file; the caller closes it. */
  readonly database?: Database;
  /** Startup warnings for the caller to log. Never contain key material. */
  readonly warnings: readonly string[];
}

/**
 * Loads the secrets key (a present but unusable key throws), creates or narrows the database file
 * to mode 0600, opens it and seals any plaintext secrets left from before a key was configured.
 */
export function openWebhookPersistence(env: Readonly<Record<string, string | undefined>>): WebhookPersistence {
  const key = loadSecretsKey({ env });
  const box = key === undefined ? undefined : new SecretBox({ version: SECRETS_KEY_VERSION, key });
  const databasePath = env[DATABASE_ENV];
  if (!databasePath) {
    // Nothing is stored at rest, so there is nothing to warn about here.
    return { store: new MemoryWebhookSubscriptionStore(), warnings: [] };
  }
  preparePrivateDatabaseFile(databasePath);
  const database = openDatabase(databasePath);
  if (box !== undefined) {
    reencryptPlaintextSecrets(database, box);
  }
  return {
    store: new SqliteWebhookSubscriptionRepository(database, box),
    database,
    warnings: box === undefined ? [UNENCRYPTED_SECRETS_WARNING] : [],
  };
}
