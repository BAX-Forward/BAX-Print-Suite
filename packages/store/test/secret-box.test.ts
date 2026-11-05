import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isSealed, SecretBox, SecretDecryptError, SEALED_PREFIX } from '../src/index.js';

const SECRET = 'test-secret-not-real-0000';
const ID = 'sub-1';
const NONCE_START = 1;
const NONCE_END = 13;

function box(version = 1): SecretBox {
  return new SecretBox({ version, key: randomBytes(32) });
}

/** Decodes a sealed value, lets `change` flip bytes, and re-encodes it. */
function tamper(sealed: string, change: (payload: Buffer) => void): string {
  const payload = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64');
  change(payload);
  return SEALED_PREFIX + payload.toString('base64');
}

function flipByte(payload: Buffer, offset: number): void {
  payload.writeUInt8(payload.readUInt8(offset) ^ 0x01, offset);
}

function decryptError(open: () => string): SecretDecryptError {
  try {
    open();
  } catch (error) {
    if (error instanceof SecretDecryptError) return error;
    throw error;
  }
  throw new Error('expected open to throw');
}

describe('SecretBox', () => {
  it('round-trips a secret and seals it in the v1 form', () => {
    const secrets = box();
    const sealed = secrets.seal(SECRET, ID);

    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain(SECRET);
    expect(isSealed(sealed)).toBe(true);
    expect(secrets.open(sealed, ID)).toBe(SECRET);
  });

  it('carries the key version in the first payload byte', () => {
    const sealed = box(7).seal(SECRET, ID);
    expect(Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64').readUInt8(0)).toBe(7);
  });

  it('round-trips empty and non-ASCII secrets', () => {
    const secrets = box();
    expect(secrets.open(secrets.seal('', ID), ID)).toBe('');
    expect(secrets.open(secrets.seal('geheim-äöü-☃', ID), ID)).toBe('geheim-äöü-☃');
  });

  it('fails closed with a different key of the same version', () => {
    const sealed = box().seal(SECRET, ID);
    expect(decryptError(() => box().open(sealed, ID)).reason).toBe('authentication');
  });

  it('fails closed when the value was sealed for another subscription id', () => {
    const secrets = box();
    const sealed = secrets.seal(SECRET, ID);
    expect(decryptError(() => secrets.open(sealed, 'sub-2')).reason).toBe('authentication');
  });

  it('rejects tampered ciphertext', () => {
    const secrets = box();
    const sealed = tamper(secrets.seal(SECRET, ID), (payload) => flipByte(payload, NONCE_END));
    expect(decryptError(() => secrets.open(sealed, ID)).reason).toBe('authentication');
  });

  it('rejects a tampered tag', () => {
    const secrets = box();
    const sealed = tamper(secrets.seal(SECRET, ID), (payload) => flipByte(payload, payload.length - 1));
    expect(decryptError(() => secrets.open(sealed, ID)).reason).toBe('authentication');
  });

  it('rejects a tampered nonce', () => {
    const secrets = box();
    const sealed = tamper(secrets.seal(SECRET, ID), (payload) => flipByte(payload, NONCE_START));
    expect(decryptError(() => secrets.open(sealed, ID)).reason).toBe('authentication');
  });

  it('rejects an unknown key version', () => {
    const sealed = box(1).seal(SECRET, ID);
    expect(decryptError(() => box(2).open(sealed, ID)).reason).toBe('unknown-version');
  });

  it('rejects values that are not in sealed form', () => {
    const secrets = box();
    expect(decryptError(() => secrets.open(SECRET, ID)).reason).toBe('malformed');
    expect(decryptError(() => secrets.open('v1:not base64!', ID)).reason).toBe('malformed');
    expect(decryptError(() => secrets.open('v1:AAAA', ID)).reason).toBe('malformed');
  });

  it('never puts key or secret material in error messages', () => {
    const key = randomBytes(32);
    const sealed = box().seal(SECRET, ID);
    const error = decryptError(() => new SecretBox({ version: 1, key }).open(sealed, ID));
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(key.toString('base64'));
  });

  it('uses a fresh nonce for every seal of the same secret', () => {
    const secrets = box();
    const sealedValues = Array.from({ length: 100 }, () => secrets.seal(SECRET, ID));
    const nonces = sealedValues.map((sealed) =>
      Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64').subarray(NONCE_START, NONCE_END).toString('hex'),
    );

    expect(new Set(nonces).size).toBe(100);
    expect(new Set(sealedValues).size).toBe(100);
    expect(sealedValues.every((sealed) => secrets.open(sealed, ID) === SECRET)).toBe(true);
  });

  it('opens values sealed under an older key it holds and seals with the current one', () => {
    const oldKey = { version: 1, key: randomBytes(32) };
    const sealedOld = new SecretBox(oldKey).seal(SECRET, ID);
    const rotated = new SecretBox({ version: 2, key: randomBytes(32) }, [oldKey]);

    expect(rotated.open(sealedOld, ID)).toBe(SECRET);
    expect(rotated.version).toBe(2);
    expect(Buffer.from(rotated.seal(SECRET, ID).slice(SEALED_PREFIX.length), 'base64').readUInt8(0)).toBe(2);
  });

  it('rejects keys of the wrong length and out-of-range versions', () => {
    expect(() => new SecretBox({ version: 1, key: randomBytes(16) })).toThrow(RangeError);
    expect(() => new SecretBox({ version: 0, key: randomBytes(32) })).toThrow(RangeError);
    expect(() => new SecretBox({ version: 256, key: randomBytes(32) })).toThrow(RangeError);
    expect(
      () => new SecretBox({ version: 1, key: randomBytes(32) }, [{ version: 1, key: randomBytes(32) }]),
    ).toThrow(RangeError);
  });

  it('does not change when the caller later overwrites its key buffer', () => {
    const key = randomBytes(32);
    const secrets = new SecretBox({ version: 1, key });
    const sealed = secrets.seal(SECRET, ID);
    key.fill(0);
    expect(secrets.open(sealed, ID)).toBe(SECRET);
  });
});

describe('isSealed', () => {
  it('recognises only the sealed form', () => {
    expect(isSealed(SECRET)).toBe(false);
    expect(isSealed('')).toBe(false);
    expect(isSealed('v1:')).toBe(false);
    expect(isSealed('v2:' + randomBytes(40).toString('base64'))).toBe(false);
    expect(isSealed('v1:' + randomBytes(40).toString('base64'))).toBe(true);
  });
});
