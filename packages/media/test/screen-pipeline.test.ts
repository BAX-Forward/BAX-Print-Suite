import { describe, expect, it } from 'vitest';
import {
  BAYER_SIZES,
  type InkLimitMethod,
  MAX_SCREEN_PIPELINE_PIXELS,
  SCREEN_DOT_ON,
  type ScreenPipelineInput,
  type ScreenPipelinePlanes,
  type ScreenPipelineScreening,
  type ScreenPlaneOffset,
  type ThresholdArray,
  bayerArray,
  blueNoiseArray,
  composeScreening,
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

const PLANES = ['c', 'm', 'y', 'k'] as const;

function randomImage(rng: () => number): ScreenPipelineInput {
  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
  const width = int(1, 24);
  const height = int(1, 24);
  const plane = (): Uint8Array => Uint8Array.from({ length: width * height }, () => int(0, 255));
  return { width, height, c: plane(), m: plane(), y: plane(), k: plane() };
}

function randomScreening(rng: () => number): ScreenPipelineScreening {
  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
  if (rng() < 0.5) return { kind: 'bayer', size: BAYER_SIZES[int(0, BAYER_SIZES.length - 1)] ?? 2 };
  return { kind: 'blue-noise', size: int(2, 8), seed: int(0, 0xffff_ffff) };
}

function arrayFor(screening: ScreenPipelineScreening): ThresholdArray {
  return screening.kind === 'bayer' ? bayerArray(screening.size) : blueNoiseArray(screening.size, screening.seed);
}

/** Independent reference: on when value * size^2 > threshold(x + ox, y + oy) * 255. */
function referenceScreen(
  plane: Uint8Array,
  width: number,
  height: number,
  array: ThresholdArray,
  offset: ScreenPlaneOffset,
): Uint8Array {
  const s = array.size;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = array.values[((y + offset.y) % s) * s + ((x + offset.x) % s)] ?? 0;
      out[y * width + x] = (plane[y * width + x] ?? 0) * s * s > t * 255 ? SCREEN_DOT_ON : 0;
    }
  }
  return out;
}

function planesOf(source: ScreenPipelinePlanes): Uint8Array[] {
  return [source.c, source.m, source.y, source.k];
}

function coverage(plane: Uint8Array): number {
  let on = 0;
  for (const v of plane) if (v === SCREEN_DOT_ON) on++;
  return on / plane.length;
}

/** Calls the composer the way an untyped caller would, to reach the runtime validation. */
function callUntyped(input: Record<string, unknown>): unknown {
  return Reflect.apply(composeScreening, undefined, [input]);
}

describe('composeScreening properties (seeded)', () => {
  it('returns byte-equal copies without options over 200 random images', () => {
    const rng = seededRng(0x041a);
    for (let trial = 0; trial < 200; trial++) {
      const input = randomImage(rng);
      const out = composeScreening(input);
      expect(planesOf(out)).toEqual(planesOf(input));
      for (const name of PLANES) expect(out[name]).not.toBe(input[name]);
    }
  });

  it('equals limitInk with only an ink limit over 200 random images', () => {
    const rng = seededRng(0x041b);
    for (let trial = 0; trial < 200; trial++) {
      const image = randomImage(rng);
      const method: InkLimitMethod = rng() < 0.5 ? 'proportional' : 'gcr';
      const inkLimit = { limitPercent: 100 + Math.floor(rng() * 301), method };
      const before = planesOf(image).map((p) => p.slice());
      const out = composeScreening({ ...image, inkLimit });
      const expected = limitInk({ ...image, ...inkLimit });
      expect(planesOf(out)).toEqual(planesOf(expected));
      expect(planesOf(image)).toEqual(before);
    }
  });

  it('screens to 0 / 255 matching the shifted-tile reference over 200 random images', () => {
    const rng = seededRng(0x041c);
    const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
    for (let trial = 0; trial < 200; trial++) {
      const image = randomImage(rng);
      const screening = randomScreening(rng);
      const array = arrayFor(screening);
      const offset = (): ScreenPlaneOffset => ({ x: int(0, array.size - 1), y: int(0, array.size - 1) });
      const planeOffsets = { c: offset(), m: offset(), y: offset(), k: offset() };
      const withLimit = rng() < 0.5;
      const inkLimit = { limitPercent: int(100, 400), method: 'gcr' as const };
      const before = planesOf(image).map((p) => p.slice());

      const out = composeScreening({ ...image, screening, planeOffsets, ...(withLimit ? { inkLimit } : {}) });
      const source = withLimit ? limitInk({ ...image, ...inkLimit }) : image;

      expect(planesOf(image)).toEqual(before);
      for (const name of PLANES) {
        for (const v of out[name]) expect(v === 0 || v === SCREEN_DOT_ON).toBe(true);
        expect(out[name]).toEqual(referenceScreen(source[name], image.width, image.height, array, planeOffsets[name]));
      }
    }
  });
});

describe('composeScreening screening', () => {
  const width = 32;
  const height = 32;
  const flat = (value: number): Uint8Array => new Uint8Array(width * height).fill(value);
  const image = { width, height, c: flat(64), m: flat(128), y: flat(192), k: flat(32) };
  const bytes = (out: ScreenPipelinePlanes): number[] => planesOf(out).flatMap((p) => Array.from(p));

  it('is byte-identical for the same blue-noise seed and differs for another seed', () => {
    const a = composeScreening({ ...image, screening: { kind: 'blue-noise', size: 16, seed: 0 } });
    const b = composeScreening({ ...image, screening: { kind: 'blue-noise', size: 16, seed: 0 } });
    const other = composeScreening({ ...image, screening: { kind: 'blue-noise', size: 16, seed: 0xffff_ffff } });
    expect(bytes(a)).toEqual(bytes(b));
    expect(bytes(other)).not.toEqual(bytes(a));
  });

  it('shifts only the plane with an offset: it equals the unshifted pattern translated', () => {
    const plane = flat(100);
    const base = { width, height, c: plane, m: plane, y: plane, k: plane };
    const screenings: ScreenPipelineScreening[] = [
      { kind: 'bayer', size: 8 },
      { kind: 'blue-noise', size: 16, seed: 0x041a },
    ];
    for (const screening of screenings) {
      const unshifted = composeScreening({ ...base, screening });
      const offsets: [number, number][] = [
        [1, 0],
        [0, 3],
        [5, 2],
        [screening.size - 1, screening.size - 1],
      ];
      for (const [ox, oy] of offsets) {
        const shifted = composeScreening({ ...base, screening, planeOffsets: { m: { x: ox, y: oy } } });
        expect(shifted.c).toEqual(unshifted.c);
        expect(shifted.y).toEqual(unshifted.y);
        expect(shifted.k).toEqual(unshifted.k);
        expect(shifted.m).not.toEqual(unshifted.m);
        for (let y = 0; y + oy < height; y++) {
          for (let x = 0; x + ox < width; x++) {
            expect(shifted.m[y * width + x]).toBe(unshifted.m[(y + oy) * width + x + ox]);
          }
        }
      }
    }
  });

  it('treats a zero offset like no offset', () => {
    const screening = { kind: 'bayer', size: 4 } as const;
    const zero = { x: 0, y: 0 };
    const out = composeScreening({ ...image, screening, planeOffsets: { c: zero, m: zero, y: zero, k: zero } });
    expect(bytes(out)).toEqual(bytes(composeScreening({ ...image, screening })));
  });
});

describe('composeScreening ink limit + screening on flat grey', () => {
  const size = 128;
  const grey = (value: number): Uint8Array => new Uint8Array(size * size).fill(value);
  const image = { width: size, height: size, c: grey(200), m: grey(200), y: grey(200), k: grey(200) };

  it('proportional 300 %: every plane is limited to 191 and covers about 191 / 255', () => {
    const out = composeScreening({
      ...image,
      inkLimit: { limitPercent: 300, method: 'proportional' },
      screening: { kind: 'bayer', size: 16 },
    });
    for (const plane of planesOf(out)) expect(Math.abs(coverage(plane) - 191 / 255)).toBeLessThanOrEqual(0.01);
  });

  it('gcr 300 %: C, M, Y drop to 182 and K rises to 218, screened with blue noise', () => {
    const out = composeScreening({
      ...image,
      inkLimit: { limitPercent: 300, method: 'gcr' },
      screening: { kind: 'blue-noise', size: 32, seed: 0x041a },
      planeOffsets: { c: { x: 3, y: 7 }, k: { x: 31, y: 0 } },
    });
    for (const plane of [out.c, out.m, out.y]) expect(Math.abs(coverage(plane) - 182 / 255)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(coverage(out.k) - 218 / 255)).toBeLessThanOrEqual(0.01);
    const total = planesOf(out).reduce((sum, plane) => sum + coverage(plane), 0);
    expect(total).toBeLessThanOrEqual(3.0 + 0.01);
  });
});

describe('composeScreening validation', () => {
  const plane = (): Uint8Array => new Uint8Array(4);
  const ok = { width: 2, height: 2, c: plane(), m: plane(), y: plane(), k: plane() };
  const bayer = { kind: 'bayer', size: 4 };

  it('exposes the pixel cap and accepts a valid input', () => {
    expect(MAX_SCREEN_PIPELINE_PIXELS).toBe(100_000_000);
    expect(SCREEN_DOT_ON).toBe(255);
    expect(callUntyped({ ...ok, screening: bayer })).toEqual({ c: plane(), m: plane(), y: plane(), k: plane() });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_SCREEN_PIPELINE_PIXELS + 1, '2', undefined])(
    'rejects width and height %s',
    (bad) => {
      expect(() => callUntyped({ ...ok, width: bad })).toThrow(RangeError);
      expect(() => callUntyped({ ...ok, width: bad })).toThrow(/composeScreening: width/);
      expect(() => callUntyped({ ...ok, height: bad })).toThrow(/composeScreening: height/);
    },
  );

  it('rejects a huge width * height before allocating or building an array', () => {
    const tiny = new Uint8Array(1);
    const huge = (width: number, height: number): unknown =>
      callUntyped({
        width,
        height,
        c: tiny,
        m: tiny,
        y: tiny,
        k: tiny,
        inkLimit: { limitPercent: 300, method: 'gcr' },
        screening: { kind: 'blue-noise', size: 256, seed: 1 },
      });
    const started = performance.now();
    expect(() => huge(100_000, 100_000)).toThrow(/exceeds MAX_SCREEN_PIPELINE_PIXELS/);
    expect(() => huge(MAX_SCREEN_PIPELINE_PIXELS, MAX_SCREEN_PIPELINE_PIXELS)).toThrow(
      /exceeds MAX_SCREEN_PIPELINE_PIXELS/,
    );
    expect(() => huge(10_001, 10_000)).toThrow(/exceeds MAX_SCREEN_PIPELINE_PIXELS/);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it.each(['c', 'm', 'y', 'k'])('rejects plane %s of the wrong length or type', (name) => {
    expect(() => callUntyped({ ...ok, [name]: new Uint8Array(3) })).toThrow(new RegExp(`plane ${name} has 3 bytes`));
    expect(() => callUntyped({ ...ok, [name]: new Uint8Array(5) })).toThrow(RangeError);
    expect(() => callUntyped({ ...ok, [name]: [0, 0, 0, 0] })).toThrow(/Uint8Array/);
    expect(() => callUntyped({ ...ok, [name]: undefined })).toThrow(/Uint8Array/);
  });

  it.each([
    ['not an object', 300, /inkLimit must be an object/],
    ['null', null, /inkLimit must be an object/],
    ['limitPercent 99', { limitPercent: 99, method: 'gcr' }, /inkLimit.limitPercent/],
    ['limitPercent 401', { limitPercent: 401, method: 'gcr' }, /inkLimit.limitPercent/],
    ['limitPercent 250.5', { limitPercent: 250.5, method: 'gcr' }, /inkLimit.limitPercent/],
    ['missing limitPercent', { method: 'gcr' }, /inkLimit.limitPercent/],
    ['method ucr', { limitPercent: 300, method: 'ucr' }, /inkLimit.method/],
    ['missing method', { limitPercent: 300 }, /inkLimit.method/],
  ])('rejects an ink limit %s', (_name, inkLimit, message) => {
    expect(() => callUntyped({ ...ok, inkLimit })).toThrow(RangeError);
    expect(() => callUntyped({ ...ok, inkLimit })).toThrow(message);
  });

  it.each([
    ['not an object', 'bayer', /screening must be an object with a kind/],
    ['null', null, /screening must be an object with a kind/],
    ['without a kind', { size: 4 }, /screening must be an object with a kind/],
    ['of unknown kind', { kind: 'am', size: 4 }, /screening.kind must be bayer or blue-noise/],
    ['bayer 3', { kind: 'bayer', size: 3 }, /screening.size must be 2, 4, 8, 16/],
    ['bayer 32', { kind: 'bayer', size: 32 }, /screening.size/],
    ['bayer without size', { kind: 'bayer' }, /screening.size/],
    ['blue noise 1', { kind: 'blue-noise', size: 1, seed: 0 }, /screening.size/],
    ['blue noise 257', { kind: 'blue-noise', size: 257, seed: 0 }, /screening.size/],
    ['blue noise seed -1', { kind: 'blue-noise', size: 8, seed: -1 }, /screening.seed/],
    ['blue noise seed 2^32', { kind: 'blue-noise', size: 8, seed: 2 ** 32 }, /screening.seed/],
    ['blue noise without seed', { kind: 'blue-noise', size: 8 }, /screening.seed/],
  ])('rejects screening %s', (_name, screening, message) => {
    expect(() => callUntyped({ ...ok, screening })).toThrow(RangeError);
    expect(() => callUntyped({ ...ok, screening })).toThrow(message);
  });

  it.each([
    ['x = size', { c: { x: 4, y: 0 } }, /planeOffsets.c.x must be an integer in 0..3/],
    ['y = size', { m: { x: 0, y: 4 } }, /planeOffsets.m.y must be an integer in 0..3/],
    ['negative x', { y: { x: -1, y: 0 } }, /planeOffsets.y.x/],
    ['fractional y', { k: { x: 0, y: 1.5 } }, /planeOffsets.k.y/],
    ['string x', { c: { x: '1', y: 0 } }, /planeOffsets.c.x/],
    ['missing y', { c: { x: 1 } }, /planeOffsets.c.y/],
    ['a non-object plane entry', { m: 2 }, /planeOffsets.m must be an object/],
    ['a non-object', 2, /planeOffsets must be an object/],
    ['null', null, /planeOffsets must be an object/],
  ])('rejects offsets with %s', (_name, planeOffsets, message) => {
    expect(() => callUntyped({ ...ok, screening: bayer, planeOffsets })).toThrow(RangeError);
    expect(() => callUntyped({ ...ok, screening: bayer, planeOffsets })).toThrow(message);
  });

  it('rejects offsets without screening, and bad offsets even with an ink limit', () => {
    expect(() => callUntyped({ ...ok, planeOffsets: {} })).toThrow(/planeOffsets requires screening/);
    expect(() =>
      callUntyped({
        ...ok,
        inkLimit: { limitPercent: 300, method: 'gcr' },
        screening: { kind: 'blue-noise', size: 8, seed: 1 },
        planeOffsets: { k: { x: 8, y: 0 } },
      }),
    ).toThrow(/planeOffsets.k.x must be an integer in 0..7/);
  });
});
