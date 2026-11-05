import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CANONICAL_BASE64, SECRET_KEY_BYTES } from './secret-box.js';

/** Spec 019d: where the key that seals webhook secrets comes from. */

export const SECRETS_KEY_ENV = 'BPS_SECRETS_KEY';
export const SECRETS_KEY_FILE_ENV = 'BPS_SECRETS_KEY_FILE';
const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;

/** The key could not be loaded. Messages name the source, never the key. */
export class SecretKeyError extends Error {
  override readonly name = 'SecretKeyError';
}

export interface LoadSecretsKeyOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Defaults to the `BPS_SECRETS_KEY_FILE` variable in `env`. */
  readonly keyFile?: string;
}

function decodeKey(text: string, source: string): Buffer {
  const trimmed = text.trim();
  if (!CANONICAL_BASE64.test(trimmed)) {
    throw new SecretKeyError(`${source} is not valid base64`);
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretKeyError(`${source} must decode to exactly ${SECRET_KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

function readKeyFile(path: string): Buffer {
  const absolute = resolve(path);
  let stats;
  try {
    stats = statSync(absolute);
  } catch (error) {
    throw new SecretKeyError(`secrets key file ${absolute} cannot be read`, { cause: error });
  }
  if (!stats.isFile()) {
    throw new SecretKeyError(`secrets key file ${absolute} is not a regular file`);
  }
  // Windows has no POSIX permission bits to check.
  const mode = stats.mode & PERMISSION_BITS;
  if (process.platform !== 'win32' && mode !== PRIVATE_FILE_MODE) {
    throw new SecretKeyError(
      `refusing secrets key file ${absolute}: mode is ${mode.toString(8).padStart(4, '0')}, must be 0600 (run chmod 600 on it)`,
    );
  }
  return decodeKey(readFileSync(absolute, 'utf8'), `secrets key file ${absolute}`);
}

/**
 * `BPS_SECRETS_KEY` (base64 of exactly 32 bytes) wins; otherwise the key file (the same base64
 * text, mode 0600); otherwise undefined. A key that is present but unusable throws
 * `SecretKeyError` rather than fall back to storing secrets unencrypted.
 */
export function loadSecretsKey({ env, keyFile = env[SECRETS_KEY_FILE_ENV] }: LoadSecretsKeyOptions): Buffer | undefined {
  const fromEnv = env[SECRETS_KEY_ENV];
  if (fromEnv !== undefined) {
    return decodeKey(fromEnv, SECRETS_KEY_ENV);
  }
  if (keyFile !== undefined && keyFile !== '') {
    return readKeyFile(keyFile);
  }
  return undefined;
}
