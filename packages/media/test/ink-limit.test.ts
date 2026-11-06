import { describe, expect, it } from 'vitest';
import {
  INK_PLANE_FULL,
  type InkLimitInput,
  type InkLimitMethod,
  MAX_INK_LIMIT_PERCENT,
  MAX_INK_LIMIT_PIXELS,
  MIN_INK_LIMIT_PERCENT,
  inkLimitToPlaneUnits,
  limitInk,
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

type Pixel = readonly [number, number, number, number];

/** Limits a single pixel and returns it as [c, m, y, k]. */
function limitPixel(pixel: Pixel, limitPercent: number, method: InkLimitMethod): [number, number, number, number] {
  const [c, m, y, k] = pixel;
  const out = limitInk({
    width: 1,
    height: 1,
    c: Uint8Array.of(c),
    m: Uint8Array.of(m),
    y: Uint8Array.of(y),
    k: Uint8Array.of(k),
    limitPercent,
    method,
  });
  return [out.c[0] ?? -1, out.m[0] ?? -1, out.y[0] ?? -1, out.k[0] ?? -1];
}

/** Calls the limiter the way an untyped caller would, to reach the runtime validation. */
function callUntyped(input: Record<string, unknown>): unknown {
  return Reflect.apply(limitInk, undefined, [input]);
}

describe('ink limit in plane units', () => {
  it.each([
    [100, 255],
    [101, 257],
    [250, 637],
    [300, 765],
    [333, 849],
    [400, 1020],
  ])('%d %% is %d plane units', (percent, units) => {
    expect(inkLimitToPlaneUnits(percent)).toBe(units);
  });

  it('matches floor(p * 255 / 100) across the range', () => {
    for (let p = MIN_INK_LIMIT_PERCENT; p <= MAX_INK_LIMIT_PERCENT; p++) {
      expect(inkLimitToPlaneUnits(p)).toBe(Math.floor((p * 255) / 100));
    }
  });
});

describe('limitInk proportional', () => {
  it.each<[Pixel, number, Pixel]>([
    [[255, 255, 255, 255], 300, [191, 191, 191, 191]],
    [[200, 100, 50, 0], 100, [145, 72, 36, 0]],
    [[255, 255, 255, 255], 400, [255, 255, 255, 255]],
    [[100, 50, 50, 55], 100, [100, 50, 50, 55]],
    [[0, 0, 0, 0], 100, [0, 0, 0, 0]],
  ])('%j at %d %% becomes %j', (pixel, limitPercent, expected) => {
    expect(limitPixel(pixel, limitPercent, 'proportional')).toEqual(expected);
  });
});

describe('limitInk gcr', () => {
  it.each<[Pixel, number, Pixel]>([
    // K is already full: no grey can move, so C, M, Y share the remaining 510.
    [[255, 255, 255, 255], 300, [170, 170, 170, 255]],
    // t = ceil(255 / 2) = 128 reaches the limit.
    [[255, 255, 255, 0], 200, [127, 127, 127, 128]],
    // t = ceil(45 / 2) = 23.
    [[100, 100, 100, 0], 100, [77, 77, 77, 23]],
    // All grey (t = 100) moves, then C and M are scaled to 255 - 150 = 105.
    [[200, 150, 100, 50], 100, [70, 35, 0, 150]],
    // No grey component: plain proportional on C, M, Y.
    [[255, 255, 0, 0], 100, [127, 127, 0, 0]],
    // Below the limit: unchanged.
    [[200, 150, 100, 50], 300, [200, 150, 100, 50]],
  ])('%j at %d %% becomes %j', (pixel, limitPercent, expected) => {
    expect(limitPixel(pixel, limitPercent, 'gcr')).toEqual(expected);
  });

  it('caps the grey moved so K never exceeds 255', () => {
    // t = min(170 needed, 5 left in K) = 5, then C, M, Y (195 each) are scaled to 510 - 255 = 255.
    expect(limitPixel([200, 200, 200, 250], 200, 'gcr')).toEqual([85, 85, 85, 255]);
  });
});

describe('limitInk properties (seeded)', () => {
  it('holds the limit and the invariants over 300 random images and limits', () => {
    const rng = seededRng(0x040a);
    const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
    for (let trial = 0; trial < 300; trial++) {
      const width = int(1, 16);
      const height = int(1, 16);
      const n = width * height;
      const floor = int(0, 255);
      const plane = (): Uint8Array => Uint8Array.from({ length: n }, () => int(rng() < 0.2 ? 0 : floor, 255));
      const input: InkLimitInput = {
        width,
        height,
        c: plane(),
        m: plane(),
        y: plane(),
        k: plane(),
        limitPercent: int(MIN_INK_LIMIT_PERCENT, MAX_INK_LIMIT_PERCENT),
        method: rng() < 0.5 ? 'proportional' : 'gcr',
      };
      const before = [input.c.slice(), input.m.slice(), input.y.slice(), input.k.slice()];
      const limit = inkLimitToPlaneUnits(input.limitPercent);
      const out = limitInk(input);
      const again = limitInk(input);

      expect([input.c, input.m, input.y, input.k]).toEqual(before);
      expect([again.c, again.m, again.y, again.k]).toEqual([out.c, out.m, out.y, out.k]);
      expect(again.changedPixels).toBe(out.changedPixels);
      expect(out.c).not.toBe(input.c);

      let above = 0;
      for (let i = 0; i < n; i++) {
        const src = [input.c[i] ?? 0, input.m[i] ?? 0, input.y[i] ?? 0, input.k[i] ?? 0];
        const dst = [out.c[i] ?? -1, out.m[i] ?? -1, out.y[i] ?? -1, out.k[i] ?? -1];
        const srcSum = src.reduce((a, b) => a + b, 0);
        const dstSum = dst.reduce((a, b) => a + b, 0);
        for (const v of dst) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(INK_PLANE_FULL);
        }
        expect(dstSum).toBeLessThanOrEqual(limit);
        expect(dstSum).toBeLessThanOrEqual(srcSum);
        if (srcSum <= limit) {
          expect(dst).toEqual(src);
        } else {
          above++;
        }
        if (input.method === 'gcr') {
          expect(dst[3]).toBeGreaterThanOrEqual(src[3] ?? 0);
          for (let ch = 0; ch < 3; ch++) expect(dst[ch]).toBeLessThanOrEqual(src[ch] ?? 0);
        } else {
          for (let ch = 0; ch < 4; ch++) expect(dst[ch]).toBeLessThanOrEqual(src[ch] ?? 0);
        }
      }
      expect(out.changedPixels).toBe(above);
    }
  });
});

describe('limitInk validation', () => {
  const plane = (): Uint8Array => new Uint8Array(4);
  const ok = { width: 2, height: 2, c: plane(), m: plane(), y: plane(), k: plane(), limitPercent: 300, method: 'gcr' };

  it('exposes the constants and accepts a valid input', () => {
    expect(MAX_INK_LIMIT_PIXELS).toBe(100_000_000);
    expect(MIN_INK_LIMIT_PERCENT).toBe(100);
    expect(MAX_INK_LIMIT_PERCENT).toBe(400);
    expect(callUntyped(ok)).toMatchObject({ changedPixels: 0 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_INK_LIMIT_PIXELS + 1, '2'])(
    'rejects width and height %s',
    (bad) => {
      expect(() => callUntyped({ ...ok, width: bad })).toThrow(RangeError);
      expect(() => callUntyped({ ...ok, width: bad })).toThrow(/width/);
      expect(() => callUntyped({ ...ok, height: bad })).toThrow(/height/);
    },
  );

  it('rejects a huge width * height before allocating', () => {
    const tiny = new Uint8Array(1);
    const huge = (width: number, height: number): unknown =>
      callUntyped({ ...ok, width, height, c: tiny, m: tiny, y: tiny, k: tiny });
    const started = performance.now();
    expect(() => huge(100_000, 100_000)).toThrow(/exceeds MAX_INK_LIMIT_PIXELS/);
    expect(() => huge(MAX_INK_LIMIT_PIXELS, MAX_INK_LIMIT_PIXELS)).toThrow(/exceeds MAX_INK_LIMIT_PIXELS/);
    expect(() => huge(10_001, 10_000)).toThrow(/exceeds MAX_INK_LIMIT_PIXELS/);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it.each(['c', 'm', 'y', 'k'])('rejects plane %s of the wrong length or type', (name) => {
    expect(() => callUntyped({ ...ok, [name]: new Uint8Array(3) })).toThrow(
      new RegExp(`plane ${name} has 3 bytes`),
    );
    expect(() => callUntyped({ ...ok, [name]: new Uint8Array(5) })).toThrow(RangeError);
    expect(() => callUntyped({ ...ok, [name]: [0, 0, 0, 0] })).toThrow(/Uint8Array/);
    expect(() => callUntyped({ ...ok, [name]: new Uint16Array(4) })).toThrow(/Uint8Array/);
    expect(() => callUntyped({ ...ok, [name]: undefined })).toThrow(/Uint8Array/);
  });

  it.each([
    ['limitPercent', 99],
    ['limitPercent', 401],
    ['limitPercent', 250.5],
    ['limitPercent', Number.NaN],
    ['limitPercent', '300'],
    ['limitPercent', undefined],
    ['method', 'ucr'],
    ['method', undefined],
  ])('rejects %s = %j', (key, value) => {
    expect(() => callUntyped({ ...ok, [key]: value })).toThrow(RangeError);
    expect(() => callUntyped({ ...ok, [key]: value })).toThrow(new RegExp(key));
  });

  it('accepts the boundary limits', () => {
    const full = Uint8Array.of(255);
    const base = { width: 1, height: 1, c: full, m: full, y: full, k: full };
    expect(limitInk({ ...base, limitPercent: 400, method: 'proportional' }).changedPixels).toBe(0);
    expect(limitInk({ ...base, limitPercent: 100, method: 'gcr' })).toMatchObject({ changedPixels: 1 });
    expect(() => inkLimitToPlaneUnits(401)).toThrow(RangeError);
  });
});

describe('limitInk performance', () => {
  it.each<InkLimitMethod>(['proportional', 'gcr'])('limits a 4096 x 4096 image (%s) in under 2 s', (method) => {
    const size = 4096;
    const n = size * size;
    const c = new Uint8Array(n);
    const m = new Uint8Array(n);
    const y = new Uint8Array(n);
    const k = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      c[i] = i & 0xff;
      m[i] = (i >> 4) & 0xff;
      y[i] = (i >> 8) & 0xff;
      k[i] = (i >> 12) & 0xff;
    }
    const started = performance.now();
    const out = limitInk({ width: size, height: size, c, m, y, k, limitPercent: 280, method });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(out.changedPixels).toBeGreaterThan(0);
    expect(out.changedPixels).toBeLessThan(n);
  }, 20_000);
});
