import { describe, expect, it } from 'vitest';
import {
  BAYER_SIZES,
  MAX_SCREEN_PIXELS,
  MAX_THRESHOLD_ARRAY_SIZE,
  type ThresholdArray,
  applyThresholdScreen,
  bayerArray,
  blueNoiseArray,
} from '../src/index.js';

/** Local seeded PRNG (mulberry32), floats in [0, 1). */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isPermutation(array: ThresholdArray): boolean {
  const count = array.size * array.size;
  if (array.values.length === count) {
    const sorted = Array.from(array.values).sort((a, b) => a - b);
    return sorted.every((v, i) => v === i);
  }
  return false;
}

function rows(array: ThresholdArray): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < array.size; y++) out.push(Array.from(array.values.subarray(y * array.size, (y + 1) * array.size)));
  return out;
}

function countOn(mask: Uint8Array): number {
  let on = 0;
  for (const v of mask) on += v;
  return on;
}

function flatPlane(width: number, height: number, value: number): Uint8Array {
  return new Uint8Array(width * height).fill(value);
}

/** Calls the functions the way an untyped caller would, to reach the runtime validation. */
function screenUntyped(input: Record<string, unknown>): unknown {
  return Reflect.apply(applyThresholdScreen, undefined, [input]);
}
function bayerUntyped(n: unknown): unknown {
  return Reflect.apply(bayerArray, undefined, [n]);
}
function blueNoiseUntyped(size: unknown, seed: unknown): unknown {
  return Reflect.apply(blueNoiseArray, undefined, [size, seed]);
}

describe('bayerArray', () => {
  it('builds the known 2x2 and 4x4 matrices', () => {
    expect(bayerArray(2)).toMatchObject({ size: 2 });
    expect(rows(bayerArray(2))).toEqual([
      [0, 2],
      [3, 1],
    ]);
    expect(rows(bayerArray(4))).toEqual([
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ]);
  });

  it.each([...BAYER_SIZES])('size %d is a permutation of 0..n*n-1', (n) => {
    const array = bayerArray(n);
    expect(array.size).toBe(n);
    expect(array.values).toBeInstanceOf(Uint16Array);
    expect(isPermutation(array)).toBe(true);
  });

  it('nests: the top-left quarter of size 2n divided by 4 is size n', () => {
    const pairs = [
      [2, 4],
      [4, 8],
      [8, 16],
    ] as const;
    for (const [n, doubled] of pairs) {
      const small = bayerArray(n);
      const big = bayerArray(doubled);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) expect((big.values[y * 2 * n + x] ?? 0) / 4).toBe(small.values[y * n + x]);
      }
    }
  });

  it.each([0, 1, 3, 32, 2.5, Number.NaN, '4', undefined])('rejects n = %j', (bad) => {
    expect(() => bayerUntyped(bad)).toThrow(RangeError);
    expect(() => bayerUntyped(bad)).toThrow(/bayerArray: n must be/);
  });
});

describe('blueNoiseArray', () => {
  it.each([2, 3, 16, 64])('size %d is a permutation of 0..size*size-1', (size) => {
    const array = blueNoiseArray(size, 0x039a);
    expect(array.size).toBe(size);
    expect(array.values).toBeInstanceOf(Uint16Array);
    expect(isPermutation(array)).toBe(true);
  });

  it('is byte-identical for the same size and seed and differs for another seed', () => {
    const a = blueNoiseArray(64, 12345);
    const b = blueNoiseArray(64, 12345);
    const bytes = (array: ThresholdArray): Uint8Array =>
      new Uint8Array(array.values.buffer, array.values.byteOffset, array.values.byteLength);
    expect(bytes(a)).toEqual(bytes(b));
    expect(a.values).toEqual(b.values);
    expect(blueNoiseArray(64, 12346).values).not.toEqual(a.values);
    expect(blueNoiseArray(16, 0).values).toEqual(blueNoiseArray(16, 0).values);
    expect(blueNoiseArray(16, 0xffff_ffff).values).not.toEqual(blueNoiseArray(16, 0).values);
  });

  it('spreads the first ranks out: no two of the lowest 1/32 thresholds are 4-neighbours', () => {
    const size = 64;
    const { values } = blueNoiseArray(size, 7);
    const limit = (size * size) / 32;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if ((values[y * size + x] ?? limit) >= limit) continue;
        const right = values[y * size + ((x + 1) % size)] ?? limit;
        const down = values[((y + 1) % size) * size + x] ?? limit;
        expect(right).toBeGreaterThanOrEqual(limit);
        expect(down).toBeGreaterThanOrEqual(limit);
      }
    }
  });

  it.each([
    ['size', 1, 0],
    ['size', MAX_THRESHOLD_ARRAY_SIZE + 1, 0],
    ['size', 2.5, 0],
    ['size', Number.NaN, 0],
    ['size', '16', 0],
    ['seed', 16, -1],
    ['seed', 16, 2 ** 32],
    ['seed', 16, 1.5],
    ['seed', 16, Number.POSITIVE_INFINITY],
    ['seed', 16, undefined],
  ])('rejects %s (size %j, seed %j)', (key, size, seed) => {
    expect(() => blueNoiseUntyped(size, seed)).toThrow(RangeError);
    expect(() => blueNoiseUntyped(size, seed)).toThrow(new RegExp(`blueNoiseArray: ${key}`));
  });

  it('exposes the size cap', () => {
    expect(MAX_THRESHOLD_ARRAY_SIZE).toBe(256);
  });
});

describe('applyThresholdScreen', () => {
  const arrays: [string, ThresholdArray][] = [
    ['Bayer 16', bayerArray(16)],
    ['blue noise 64', blueNoiseArray(64, 0x039a)],
  ];

  it.each(arrays)('flat grey 128 on 256 x 256 covers 50%% +- 1%% with %s', (_name, array) => {
    const mask = applyThresholdScreen({ width: 256, height: 256, plane: flatPlane(256, 256, 128), array });
    expect(mask).toHaveLength(256 * 256);
    expect(Math.abs(countOn(mask) / (256 * 256) - 0.5)).toBeLessThanOrEqual(0.01);
  });

  it.each(arrays)('0 turns nothing on and 255 turns everything on with %s', (_name, array) => {
    expect(countOn(applyThresholdScreen({ width: 100, height: 70, plane: flatPlane(100, 70, 0), array }))).toBe(0);
    expect(countOn(applyThresholdScreen({ width: 100, height: 70, plane: flatPlane(100, 70, 255), array }))).toBe(7000);
  });

  it('matches value * size^2 > threshold * 255 on a tiled, non-multiple plane', () => {
    const rng = seededRng(0x039a);
    for (const array of [bayerArray(2), bayerArray(8), blueNoiseArray(5, 1)]) {
      const width = 37;
      const height = 23;
      const plane = new Uint8Array(width * height);
      for (let i = 0; i < plane.length; i++) plane[i] = Math.floor(rng() * 256);
      const mask = applyThresholdScreen({ width, height, plane, array });
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const t = array.values[(y % array.size) * array.size + (x % array.size)] ?? 0;
          const expected = (plane[y * width + x] ?? 0) * array.size * array.size > t * 255 ? 1 : 0;
          expect(mask[y * width + x]).toBe(expected);
        }
      }
    }
  });

  it('turns on exactly the expected count per tile for every grey level and is monotonic', () => {
    const array = bayerArray(4);
    let previous = new Uint8Array(16);
    for (let v = 0; v <= 255; v++) {
      const mask = applyThresholdScreen({ width: 4, height: 4, plane: flatPlane(4, 4, v), array });
      expect(countOn(mask)).toBe(Math.min(16, Math.ceil((v * 16) / 255)));
      previous.forEach((on, i) => {
        if (on === 1) expect(mask[i]).toBe(1);
      });
      previous = mask;
    }
  });
});

describe('applyThresholdScreen validation', () => {
  const ok = { width: 2, height: 2, plane: new Uint8Array(4), array: bayerArray(2) };

  it('accepts a valid input and exposes the pixel cap', () => {
    expect(MAX_SCREEN_PIXELS).toBe(100_000_000);
    expect(screenUntyped(ok)).toEqual(new Uint8Array(4));
    expect(screenUntyped({ ...ok, array: { size: 1, values: Uint16Array.of(0) } })).toEqual(new Uint8Array(4));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_SCREEN_PIXELS + 1, '2', undefined])(
    'rejects width and height %s',
    (bad) => {
      expect(() => screenUntyped({ ...ok, width: bad })).toThrow(RangeError);
      expect(() => screenUntyped({ ...ok, width: bad })).toThrow(/width/);
      expect(() => screenUntyped({ ...ok, height: bad })).toThrow(/height/);
    },
  );

  it('rejects a huge width * height before allocating', () => {
    const started = performance.now();
    const array = bayerArray(2);
    expect(() => applyThresholdScreen({ width: 100_000, height: 100_000, plane: new Uint8Array(1), array })).toThrow(
      /exceeds MAX_SCREEN_PIXELS/,
    );
    expect(() =>
      applyThresholdScreen({ width: MAX_SCREEN_PIXELS, height: MAX_SCREEN_PIXELS, plane: new Uint8Array(1), array }),
    ).toThrow(/exceeds MAX_SCREEN_PIXELS/);
    expect(() => applyThresholdScreen({ width: 10_001, height: 10_000, plane: new Uint8Array(1), array })).toThrow(
      /exceeds MAX_SCREEN_PIXELS/,
    );
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('rejects a plane of the wrong length or type', () => {
    expect(() => screenUntyped({ ...ok, plane: new Uint8Array(3) })).toThrow(/plane has 3 bytes/);
    expect(() => screenUntyped({ ...ok, plane: new Uint8Array(5) })).toThrow(RangeError);
    expect(() => screenUntyped({ ...ok, plane: [0, 0, 0, 0] })).toThrow(/plane must be a Uint8Array/);
    expect(() => screenUntyped({ ...ok, plane: new Uint16Array(4) })).toThrow(/plane must be a Uint8Array/);
  });

  it.each([
    ['missing', undefined, /array must be an object/],
    ['null', null, /array must be an object/],
    ['a number', 4, /array must be an object/],
    ['without values', { size: 2 }, /array must be an object/],
    ['size 0', { size: 0, values: new Uint16Array(0) }, /array.size/],
    ['size 257', { size: 257, values: new Uint16Array(4) }, /array.size/],
    ['size 1.5', { size: 1.5, values: new Uint16Array(4) }, /array.size/],
    ['size as a string', { size: '2', values: Uint16Array.of(0, 1, 2, 3) }, /array.size/],
    ['values as an array', { size: 2, values: [0, 1, 2, 3] }, /array.values must be a Uint16Array/],
    ['values as Uint8Array', { size: 2, values: Uint8Array.of(0, 1, 2, 3) }, /array.values must be a Uint16Array/],
    ['too few values', { size: 2, values: Uint16Array.of(0, 1, 2) }, /array.values has 3 entries/],
    ['too many values', { size: 2, values: Uint16Array.of(0, 1, 2, 3, 4) }, /array.values has 5 entries/],
    ['a duplicate', { size: 2, values: Uint16Array.of(0, 1, 1, 3) }, /permutation of 0..3 \(bad value 1\)/],
    ['an out-of-range value', { size: 2, values: Uint16Array.of(0, 1, 2, 4) }, /permutation of 0..3 \(bad value 4\)/],
  ])('rejects an array %s', (_name, array, message) => {
    expect(() => screenUntyped({ ...ok, array })).toThrow(RangeError);
    expect(() => screenUntyped({ ...ok, array })).toThrow(message);
  });
});

describe('blue noise performance', () => {
  it('builds a 128 x 128 array in under 2 s', () => {
    const started = performance.now();
    const array = blueNoiseArray(128, 0x039a);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(isPermutation(array)).toBe(true);
  }, 30_000);

  it('builds a 256 x 256 array in under 10 s', () => {
    const started = performance.now();
    const array = blueNoiseArray(256, 0x039a);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(isPermutation(array)).toBe(true);
  }, 60_000);
});
