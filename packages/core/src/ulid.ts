import { randomBytes } from 'node:crypto';
import { ulid } from './ids.js';

/** Monotonic ULIDs and ULID parsing (https://github.com/ulid/spec). Encoding lives in ids.ts. */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_BYTES = 10;
const MAX_TIME = 2 ** 48 - 1;
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export type UlidGenerator = (timeMs?: number) => string;

/** Adds one to a big-endian byte array in place; returns false on overflow. */
function incrementBytes(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const value = bytes[i] ?? 0;
    if (value < 0xff) {
      bytes[i] = value + 1;
      return true;
    }
    bytes[i] = 0;
  }
  return false;
}

/**
 * Returns a generator whose ids strictly increase. Within one millisecond, or after the clock
 * steps back, the previous random part is incremented instead of drawn fresh.
 */
export function monotonicUlid(
  randomSource: () => Uint8Array = () => randomBytes(RANDOM_BYTES),
): UlidGenerator {
  let lastTime = -1;
  let lastRandom = new Uint8Array(RANDOM_BYTES);
  return (timeMs: number = Date.now()) => {
    if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME) {
      throw new RangeError(`ulid time out of range: ${timeMs}`);
    }
    if (timeMs > lastTime) {
      const random = randomSource();
      if (random.length < RANDOM_BYTES) {
        throw new RangeError(`ulid needs ${RANDOM_BYTES} random bytes`);
      }
      lastTime = timeMs;
      lastRandom = Uint8Array.from(random.subarray(0, RANDOM_BYTES));
    } else if (!incrementBytes(lastRandom)) {
      throw new RangeError('ulid random component overflow');
    }
    return ulid(lastTime, lastRandom);
  };
}

/** Process-wide monotonic generator for ids created by repositories and intake. */
export const nextUlid: UlidGenerator = monotonicUlid();

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/** Milliseconds encoded in a ULID's timestamp part. */
export function ulidTime(id: string): number {
  if (!isUlid(id)) {
    throw new TypeError(`not a ULID: ${id}`);
  }
  let time = 0;
  for (const char of id.slice(0, TIME_LENGTH)) {
    time = time * 32 + CROCKFORD.indexOf(char);
  }
  return time;
}
