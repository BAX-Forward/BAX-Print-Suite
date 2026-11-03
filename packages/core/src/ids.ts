import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIME = 2 ** 48 - 1;
const RANDOM_BYTES = 10;

/**
 * ULID: 48-bit millisecond time + 80 random bits, Crockford base32 (26 chars).
 * Lexicographic order follows creation time.
 */
export function ulid(timeMs: number = Date.now(), random: Uint8Array = randomBytes(RANDOM_BYTES)): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME) {
    throw new RangeError(`ulid time out of range: ${timeMs}`);
  }
  if (random.length < RANDOM_BYTES) {
    throw new RangeError(`ulid needs ${RANDOM_BYTES} random bytes`);
  }

  let time = '';
  let remaining = timeMs;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }

  let randomPart = '';
  let buffered = 0;
  let bits = 0;
  for (let i = 0; i < RANDOM_BYTES; i++) {
    buffered = (buffered << 8) | random[i];
    bits += 8;
    while (bits >= 5) {
      randomPart += CROCKFORD[(buffered >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffered &= (1 << bits) - 1;
  }

  return time + randomPart;
}
