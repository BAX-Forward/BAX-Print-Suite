import { describe, expect, it } from 'vitest';
import { isUlid, monotonicUlid, nextUlid, ulid, ulidTime } from '../src/index.js';

const T = Date.UTC(2026, 0, 2, 3, 4, 5, 678);

function fixedRandom(bytes: number[]): () => Uint8Array {
  return () => Uint8Array.from(bytes);
}

describe('ulid', () => {
  it('encodes 26 Crockford base32 characters and round-trips the time', () => {
    const id = ulid(T, new Uint8Array(10));
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(ulidTime(id)).toBe(T);
    expect(id.slice(10)).toBe('0'.repeat(16));
  });

  it('rejects malformed ids and out-of-range times', () => {
    expect(isUlid('not-a-ulid')).toBe(false);
    expect(isUlid('8ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
    expect(() => ulidTime('nope')).toThrow(TypeError);
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => monotonicUlid()(Number.NaN)).toThrow(RangeError);
  });
});

describe('monotonic ulid', () => {
  it('increments the random part within the same millisecond', () => {
    const next = monotonicUlid(fixedRandom([0, 0, 0, 0, 0, 0, 0, 0, 0, 0xfe]));
    const a = next(T);
    const b = next(T);
    const c = next(T);
    expect(a < b && b < c).toBe(true);
    expect([a, b, c].map(ulidTime)).toEqual([T, T, T]);
    // 0xfe → 0xff → carry into the next byte.
    expect(c).toBe(ulid(T, Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 0])));
  });

  it('stays monotonic when the clock steps back', () => {
    const next = monotonicUlid(fixedRandom([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]));
    const a = next(T);
    const b = next(T - 1_000);
    expect(b > a).toBe(true);
    expect(ulidTime(b)).toBe(T);
  });

  it('draws fresh randomness when time moves forward', () => {
    const next = monotonicUlid(fixedRandom([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    const a = next(T);
    const b = next(T + 1);
    expect(b > a).toBe(true);
    expect(ulidTime(b)).toBe(T + 1);
  });

  it('throws instead of wrapping when the random part overflows', () => {
    const next = monotonicUlid(fixedRandom([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    next(T);
    expect(() => next(T)).toThrow(/overflow/);
  });

  it('produces strictly increasing ids from the shared generator', () => {
    const ids = Array.from({ length: 2_000 }, () => nextUlid(T));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every(isUlid)).toBe(true);
  });
});
