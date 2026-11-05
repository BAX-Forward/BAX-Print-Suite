import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Spec 019d: webhook signing secrets sealed at rest with AES-256-GCM (NIST SP 800-38D).
 *
 * Sealed form: `v1:` + base64(key version byte || 12-byte nonce || ciphertext || 16-byte tag).
 * The additional authenticated data is a fixed context string plus the subscription id, so a
 * sealed value copied onto another row does not open.
 */

export const SEALED_PREFIX = 'v1:';
export const SECRET_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES;
const MIN_SEALED_BYTES = HEADER_BYTES + TAG_BYTES;
const MAX_KEY_VERSION = 255;
const CIPHER = 'aes-256-gcm';
const AAD_CONTEXT = 'bax-print-suite/webhook-subscription-secret/v1\u0000';
/** Standard alphabet with padding, nothing else: `Buffer.from(..., 'base64')` alone skips junk. */
export const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type SecretDecryptReason = 'malformed' | 'unknown-version' | 'authentication' | 'no-key';

/** A sealed secret could not be opened. Messages never contain key or secret material. */
export class SecretDecryptError extends Error {
  override readonly name = 'SecretDecryptError';

  constructor(
    readonly reason: SecretDecryptReason,
    message: string,
  ) {
    super(message);
  }
}

export interface SecretKey {
  /** 1 to 255; stored in the first byte of every sealed value. */
  readonly version: number;
  /** Exactly 32 bytes. */
  readonly key: Uint8Array;
}

/** The decoded payload of a sealed value, or undefined if `value` is not in sealed form. */
function decodeSealed(value: string): Buffer | undefined {
  if (!value.startsWith(SEALED_PREFIX)) {
    return undefined;
  }
  const body = value.slice(SEALED_PREFIX.length);
  if (!CANONICAL_BASE64.test(body)) {
    return undefined;
  }
  const bytes = Buffer.from(body, 'base64');
  return bytes.length >= MIN_SEALED_BYTES ? bytes : undefined;
}

/** True when `value` has the sealed form. Says nothing about whether any key opens it. */
export function isSealed(value: string): boolean {
  return decodeSealed(value) !== undefined;
}

function additionalData(id: string): Buffer {
  return Buffer.from(AAD_CONTEXT + id, 'utf8');
}

function checkedKey({ version, key }: SecretKey): SecretKey {
  if (!Number.isInteger(version) || version < 1 || version > MAX_KEY_VERSION) {
    throw new RangeError(`secret key version must be an integer from 1 to ${MAX_KEY_VERSION}`);
  }
  if (key.length !== SECRET_KEY_BYTES) {
    throw new RangeError(`secret key must be exactly ${SECRET_KEY_BYTES} bytes`);
  }
  // Copied so later changes to the caller's buffer cannot change the box.
  return Object.freeze({ version, key: Buffer.from(key) });
}

/** Seals with the current key; opens values sealed under the current or any older key it holds. */
export class SecretBox {
  readonly #current: SecretKey;
  readonly #keys: ReadonlyMap<number, SecretKey>;

  constructor(current: SecretKey, older: readonly SecretKey[] = []) {
    this.#current = checkedKey(current);
    const keys = new Map<number, SecretKey>([[this.#current.version, this.#current]]);
    for (const candidate of older) {
      const key = checkedKey(candidate);
      if (keys.has(key.version)) {
        throw new RangeError(`secret key version ${key.version} is given twice`);
      }
      keys.set(key.version, key);
    }
    this.#keys = keys;
  }

  /** The key version new seals carry. */
  get version(): number {
    return this.#current.version;
  }

  seal(plaintext: string, id: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHER, this.#current.key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(additionalData(id));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([Buffer.of(this.#current.version), nonce, ciphertext, cipher.getAuthTag()]);
    return SEALED_PREFIX + payload.toString('base64');
  }

  /** Fails closed: throws `SecretDecryptError` rather than return anything unauthenticated. */
  open(sealed: string, id: string): string {
    const payload = decodeSealed(sealed);
    if (payload === undefined) {
      throw new SecretDecryptError('malformed', 'value is not a sealed secret');
    }
    const version = payload.readUInt8(0);
    const entry = this.#keys.get(version);
    if (entry === undefined) {
      throw new SecretDecryptError('unknown-version', `no key for secret key version ${version}`);
    }
    const nonce = payload.subarray(1, HEADER_BYTES);
    const ciphertext = payload.subarray(HEADER_BYTES, payload.length - TAG_BYTES);
    const tag = payload.subarray(payload.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv(CIPHER, entry.key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(additionalData(id));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretDecryptError('authentication', 'sealed secret failed authentication (wrong key or tampered value)');
    }
  }
}
