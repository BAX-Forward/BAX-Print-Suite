import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSecretsKey, SECRETS_KEY_ENV, SECRETS_KEY_FILE_ENV, SecretKeyError } from '../src/index.js';

const isWindows = process.platform === 'win32';

function keyError(load: () => unknown): SecretKeyError {
  try {
    load();
  } catch (error) {
    if (error instanceof SecretKeyError) return error;
    throw error;
  }
  throw new Error('expected loadSecretsKey to throw');
}

describe('loadSecretsKey', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function keyFile(contents: string, mode: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'bps-secrets-key-'));
    dirs.push(dir);
    const path = join(dir, 'secrets.key');
    writeFileSync(path, contents, { mode });
    // The umask can narrow the creation mode; set it exactly.
    chmodSync(path, mode);
    return path;
  }

  it('returns undefined when no key is configured', () => {
    expect(loadSecretsKey({ env: {} })).toBeUndefined();
    expect(loadSecretsKey({ env: { [SECRETS_KEY_FILE_ENV]: '' } })).toBeUndefined();
  });

  it('decodes a base64 key of exactly 32 bytes from the environment', () => {
    const key = randomBytes(32);
    expect(loadSecretsKey({ env: { [SECRETS_KEY_ENV]: key.toString('base64') } })).toEqual(key);
  });

  it('refuses a key that is not valid base64', () => {
    const error = keyError(() => loadSecretsKey({ env: { [SECRETS_KEY_ENV]: 'not*base64*at*all!' } }));
    expect(error.message).toContain(SECRETS_KEY_ENV);
    expect(error.message).toContain('base64');
  });

  it('refuses a key of the wrong length without echoing it', () => {
    for (const length of [16, 31, 33, 64]) {
      const value = randomBytes(length).toString('base64');
      const error = keyError(() => loadSecretsKey({ env: { [SECRETS_KEY_ENV]: value } }));
      expect(error.message).toContain('exactly 32 bytes');
      expect(error.message).not.toContain(value);
    }
  });

  it('refuses an empty key variable instead of running without encryption', () => {
    expect(() => loadSecretsKey({ env: { [SECRETS_KEY_ENV]: '' } })).toThrow(SecretKeyError);
  });

  it.skipIf(isWindows)('accepts a key file with mode 0600', () => {
    const key = randomBytes(32);
    const path = keyFile(`${key.toString('base64')}\n`, 0o600);

    expect(loadSecretsKey({ env: {}, keyFile: path })).toEqual(key);
    expect(loadSecretsKey({ env: { [SECRETS_KEY_FILE_ENV]: path } })).toEqual(key);
  });

  it.skipIf(isWindows)('refuses a key file with mode 0644', () => {
    const key = randomBytes(32).toString('base64');
    const path = keyFile(key, 0o644);

    const error = keyError(() => loadSecretsKey({ env: {}, keyFile: path }));
    expect(error.message).toContain('0644');
    expect(error.message).toContain('0600');
    expect(error.message).not.toContain(key);
  });

  it.skipIf(isWindows)('refuses a key file with the wrong length', () => {
    const path = keyFile(randomBytes(16).toString('base64'), 0o600);
    expect(keyError(() => loadSecretsKey({ env: {}, keyFile: path })).message).toContain('exactly 32 bytes');
  });

  it('refuses a key file that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bps-secrets-key-'));
    dirs.push(dir);
    expect(() => loadSecretsKey({ env: {}, keyFile: join(dir, 'missing.key') })).toThrow(SecretKeyError);
  });

  it.skipIf(isWindows)('prefers the environment variable over the key file', () => {
    const fromEnv = randomBytes(32);
    const path = keyFile(randomBytes(32).toString('base64'), 0o600);

    expect(loadSecretsKey({ env: { [SECRETS_KEY_ENV]: fromEnv.toString('base64') }, keyFile: path })).toEqual(fromEnv);
  });
});
