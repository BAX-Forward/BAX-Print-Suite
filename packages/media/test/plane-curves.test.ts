import { describe, expect, it } from 'vitest';
import {
  MAX_PLANE_CURVE_PIXELS,
  PLANE_CURVE_LUT_SIZE,
  PlaneCurveError,
  type PlaneCurveInterpolation,
  type PlaneCurvePlanes,
  type PlaneCurvePoint,
  applyPlaneCurves,
  buildCurveLut,
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

const INTERPOLATIONS: readonly PlaneCurveInterpolation[] = ['monotone-cubic', 'linear'];
const CASES = 250;
const IDENTITY = Uint8Array.from({ length: PLANE_CURVE_LUT_SIZE }, (_, i) => i);

/** An integer in lo..hi. */
function randomInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** count - 2 distinct interior inputs from 1..254, plus 0 and 255, in increasing order. */
function randomInputs(rng: () => number, count: number): number[] {
  const pool = Array.from({ length: 254 }, (_, i) => i + 1);
  for (let i = 0; i < count - 2; i++) {
    const j = randomInt(rng, i, pool.length - 1);
    const picked = pool[j] ?? 0;
    pool[j] = pool[i] ?? 0;
    pool[i] = picked;
  }
  return [0, ...pool.slice(0, count - 2).sort((a, b) => a - b), 255];
}

/** Random valid control points: mostly a few points, sometimes many; flat runs and steep jumps occur. */
function randomPoints(rng: () => number): PlaneCurvePoint[] {
  const count = rng() < 0.2 ? randomInt(rng, 2, 256) : randomInt(rng, 2, 12);
  const inputs = randomInputs(rng, count);
  const lo = randomInt(rng, 0, 255);
  const hi = randomInt(rng, lo, 255);
  const outputs = inputs.map(() => randomInt(rng, lo, hi)).sort((a, b) => a - b);
  return inputs.map((input, i) => ({ input, output: outputs[i] ?? 0 }));
}

/** Index of the first entry below its predecessor, or -1. */
function firstDecrease(lut: Uint8Array): number {
  for (let x = 1; x < lut.length; x++) if ((lut[x] ?? 0) < (lut[x - 1] ?? 0)) return x;
  return -1;
}

/** Points whose LUT entry differs from the given output. */
function missedPoints(lut: Uint8Array, points: readonly PlaneCurvePoint[]): PlaneCurvePoint[] {
  return points.filter((point) => lut[point.input] === point.output === false);
}

/** The code of the PlaneCurveError thrown by `run`, or undefined when it returns. */
function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof PlaneCurveError) return error.code;
    throw error;
  }
  return undefined;
}

/** Calls the builder the way an untyped caller would, to reach the runtime validation. */
function buildUntyped(...args: unknown[]): unknown {
  return Reflect.apply(buildCurveLut, undefined, args);
}

function applyUntyped(...args: unknown[]): unknown {
  return Reflect.apply(applyPlaneCurves, undefined, args);
}

describe.each(INTERPOLATIONS)('buildCurveLut properties (%s)', (interpolation) => {
  it('returns a 256-entry Uint8Array', () => {
    const lut = buildCurveLut(
      [
        { input: 0, output: 10 },
        { input: 255, output: 200 },
      ],
      { interpolation },
    );
    expect(lut).toBeInstanceOf(Uint8Array);
    expect(lut.length).toBe(PLANE_CURVE_LUT_SIZE);
  });

  it('never decreases', () => {
    const rng = seededRng(0x044a0001);
    for (let n = 0; n < CASES; n++) {
      const points = randomPoints(rng);
      expect(firstDecrease(buildCurveLut(points, { interpolation })), JSON.stringify(points)).toBe(-1);
    }
  });

  it('passes through every given point and stays inside each segment', () => {
    const rng = seededRng(0x044a0002);
    for (let n = 0; n < CASES; n++) {
      const points = randomPoints(rng);
      const lut = buildCurveLut(points, { interpolation });
      expect(missedPoints(lut, points), JSON.stringify(points)).toEqual([]);
      for (let s = 1; s < points.length; s++) {
        const from = points[s - 1] ?? { input: 0, output: 0 };
        const to = points[s] ?? { input: 0, output: 0 };
        const segment = Array.from(lut.subarray(from.input, to.input + 1));
        expect(Math.min(...segment)).toBe(from.output);
        expect(Math.max(...segment)).toBe(to.output);
      }
    }
  });

  it('gives the identity LUT for the two identity endpoints', () => {
    const points = [
      { input: 0, output: 0 },
      { input: 255, output: 255 },
    ];
    expect(buildCurveLut(points, { interpolation })).toEqual(IDENTITY);
  });

  it('gives the identity LUT for random identity subsets', () => {
    const rng = seededRng(0x044a0003);
    for (let n = 0; n < CASES; n++) {
      const count = rng() < 0.2 ? randomInt(rng, 2, 256) : randomInt(rng, 2, 12);
      const points = randomInputs(rng, count).map((input) => ({ input, output: input }));
      expect(buildCurveLut(points, { interpolation }), JSON.stringify(points)).toEqual(IDENTITY);
    }
  });

  it('is deterministic and does not modify the points', () => {
    const rng = seededRng(0x044a0004);
    for (let n = 0; n < CASES; n++) {
      const points = Object.freeze(randomPoints(rng).map((point) => Object.freeze({ ...point })));
      const before = JSON.stringify(points);
      expect(buildCurveLut(points, { interpolation })).toEqual(buildCurveLut(points, { interpolation }));
      expect(JSON.stringify(points)).toBe(before);
    }
  });

  it('keeps a flat run flat', () => {
    const lut = buildCurveLut(
      [
        { input: 0, output: 0 },
        { input: 100, output: 50 },
        { input: 200, output: 50 },
        { input: 255, output: 255 },
      ],
      { interpolation },
    );
    expect(Array.from(lut.subarray(100, 201))).toEqual(Array.from({ length: 101 }, () => 50));
  });

  it('returns a new LUT each call', () => {
    const points = [
      { input: 0, output: 0 },
      { input: 255, output: 255 },
    ];
    expect(buildCurveLut(points, { interpolation })).not.toBe(buildCurveLut(points, { interpolation }));
  });
});

describe('buildCurveLut interpolation', () => {
  it('defaults to monotone cubic', () => {
    const rng = seededRng(0x044a0005);
    for (let n = 0; n < CASES; n++) {
      const points = randomPoints(rng);
      expect(buildCurveLut(points)).toEqual(buildCurveLut(points, { interpolation: 'monotone-cubic' }));
    }
  });

  it('linear rounds exact halves up', () => {
    const lut = buildCurveLut(
      [
        { input: 0, output: 0 },
        { input: 128, output: 64 },
        { input: 255, output: 255 },
      ],
      { interpolation: 'linear' },
    );
    // x / 2 for x in 0..4: 0, 0.5, 1, 1.5, 2.
    expect(Array.from(lut.subarray(0, 5))).toEqual([0, 1, 1, 2, 2]);
    expect(lut[128]).toBe(64);
  });

  it('linear matches the exact rational value rounded half up', () => {
    const rng = seededRng(0x044a0006);
    for (let n = 0; n < CASES; n++) {
      const points = randomPoints(rng);
      const lut = buildCurveLut(points, { interpolation: 'linear' });
      for (let s = 1; s < points.length; s++) {
        const from = points[s - 1] ?? { input: 0, output: 0 };
        const to = points[s] ?? { input: 0, output: 0 };
        const h = to.input - from.input;
        for (let x = from.input; x <= to.input; x++) {
          // value + 1/2 = (2 · (y0 · h + dy · (x − x0)) + h) / (2h); floor via integer division.
          const numerator = 2 * (from.output * h + (to.output - from.output) * (x - from.input)) + h;
          expect(lut[x]).toBe((numerator - (numerator % (2 * h))) / (2 * h));
        }
      }
    }
  });

  it('monotone cubic through two points is the straight line', () => {
    const rng = seededRng(0x044a0007);
    for (let n = 0; n < CASES; n++) {
      const lo = randomInt(rng, 0, 255);
      const points = [
        { input: 0, output: lo },
        { input: 255, output: randomInt(rng, lo, 255) },
      ];
      expect(buildCurveLut(points, { interpolation: 'monotone-cubic' })).toEqual(
        buildCurveLut(points, { interpolation: 'linear' }),
      );
    }
  });

  it('monotone cubic does not overshoot next to a steep step', () => {
    const points = [
      { input: 0, output: 0 },
      { input: 10, output: 5 },
      { input: 20, output: 250 },
      { input: 30, output: 252 },
      { input: 255, output: 255 },
    ];
    const lut = buildCurveLut(points);
    expect(firstDecrease(lut)).toBe(-1);
    expect(Math.max(...Array.from(lut.subarray(0, 11)))).toBe(5);
    expect(Math.max(...Array.from(lut.subarray(20, 31)))).toBe(252);
    expect(missedPoints(lut, points)).toEqual([]);
  });
});

describe('buildCurveLut validation', () => {
  const ends = [
    { input: 0, output: 0 },
    { input: 255, output: 255 },
  ];

  it.each<[string, unknown, string]>([
    ['not an array', 'points', 'INVALID_POINTS'],
    ['undefined', undefined, 'INVALID_POINTS'],
    ['an array-like object', { length: 2, 0: ends[0], 1: ends[1] }, 'INVALID_POINTS'],
    ['empty', [], 'POINT_COUNT'],
    ['one point', [{ input: 0, output: 0 }], 'POINT_COUNT'],
    ['257 points', Array.from({ length: 257 }, (_, i) => ({ input: i, output: 0 })), 'POINT_COUNT'],
    ['a null point', [null, ends[1]], 'INVALID_POINT'],
    ['a number point', [0, ends[1]], 'INVALID_POINT'],
    ['a missing input', [{ output: 0 }, ends[1]], 'INVALID_INPUT'],
    ['a string input', [{ input: '0', output: 0 }, ends[1]], 'INVALID_INPUT'],
    ['a fractional input', [ends[0], { input: 7.5, output: 9 }, ends[1]], 'INVALID_INPUT'],
    ['a negative input', [{ input: -1, output: 0 }, ends[1]], 'INVALID_INPUT'],
    ['an input above 255', [ends[0], { input: 256, output: 255 }], 'INVALID_INPUT'],
    ['a NaN input', [ends[0], { input: Number.NaN, output: 9 }, ends[1]], 'INVALID_INPUT'],
    ['a missing output', [{ input: 0 }, ends[1]], 'INVALID_OUTPUT'],
    ['a fractional output', [{ input: 0, output: 0.5 }, ends[1]], 'INVALID_OUTPUT'],
    ['a negative output', [{ input: 0, output: -1 }, ends[1]], 'INVALID_OUTPUT'],
    ['an output above 255', [ends[0], { input: 255, output: 256 }], 'INVALID_OUTPUT'],
    ['an infinite output', [ends[0], { input: 255, output: Number.POSITIVE_INFINITY }], 'INVALID_OUTPUT'],
    ['a duplicate input', [ends[0], { input: 9, output: 9 }, { input: 9, output: 9 }, ends[1]], 'INPUT_NOT_INCREASING'],
    ['decreasing inputs', [ends[0], { input: 200, output: 9 }, { input: 100, output: 9 }, ends[1]], 'INPUT_NOT_INCREASING'],
    ['decreasing outputs', [ends[0], { input: 100, output: 200 }, { input: 200, output: 100 }, ends[1]], 'OUTPUT_DECREASING'],
    ['a falling curve', [{ input: 0, output: 255 }, { input: 255, output: 0 }], 'OUTPUT_DECREASING'],
    ['no point at input 0', [{ input: 1, output: 0 }, ends[1]], 'MISSING_ENDPOINT'],
    ['no point at input 255', [ends[0], { input: 254, output: 255 }], 'MISSING_ENDPOINT'],
  ])('rejects %s', (_name, points, code) => {
    expect(errorCode(() => buildUntyped(points))).toBe(code);
  });

  it.each<[string, unknown]>([
    ['null options', null],
    ['string options', 'linear'],
    ['an unknown interpolation', { interpolation: 'cubic' }],
    ['a null interpolation', { interpolation: null }],
    ['an unknown option', { interpolation: 'linear', clamp: true }],
  ])('rejects %s', (_name, options) => {
    expect(errorCode(() => buildUntyped(ends, options))).toBe('INVALID_OPTION');
  });

  it('accepts undefined options and an undefined interpolation', () => {
    expect(buildUntyped(ends, undefined)).toEqual(IDENTITY);
    expect(buildUntyped(ends, { interpolation: undefined })).toEqual(IDENTITY);
  });

  it('accepts 256 points', () => {
    const points = Array.from({ length: 256 }, (_, i) => ({ input: i, output: 255 - Math.floor((255 - i) / 2) }));
    expect(missedPoints(buildCurveLut(points), points)).toEqual([]);
  });

  it('throws a PlaneCurveError with the code in its message', () => {
    expect(() => buildUntyped([ends[0]])).toThrow(PlaneCurveError);
    expect(() => buildUntyped([ends[0]])).toThrow(/^POINT_COUNT: /);
  });
});

function planesOf(width: number, height: number, seed: number): PlaneCurvePlanes {
  const rng = seededRng(seed);
  const plane = (): Uint8Array => Uint8Array.from({ length: width * height }, () => randomInt(rng, 0, 255));
  return { width, height, c: plane(), m: plane(), y: plane(), k: plane() };
}

describe('applyPlaneCurves', () => {
  const invert = Uint8Array.from(IDENTITY, (v) => 255 - v);

  it('maps each channel through its LUT and copies channels without a curve', () => {
    const rng = seededRng(0x044a0008);
    for (let n = 0; n < CASES; n++) {
      const width = randomInt(rng, 1, 8);
      const height = randomInt(rng, 1, 8);
      const planes = planesOf(width, height, n);
      const lut = buildCurveLut(randomPoints(rng), { interpolation: n % 2 === 0 ? 'linear' : 'monotone-cubic' });
      const out = applyPlaneCurves(planes, { m: lut });
      expect(out.width).toBe(width);
      expect(out.height).toBe(height);
      expect(out.m).toEqual(Uint8Array.from(planes.m, (v) => lut[v] ?? -1));
      expect(out.c).toEqual(planes.c);
      expect(out.y).toEqual(planes.y);
      expect(out.k).toEqual(planes.k);
    }
  });

  it('returns new planes and leaves the input untouched', () => {
    const planes = planesOf(4, 3, 1);
    const before = { c: planes.c.slice(), m: planes.m.slice(), y: planes.y.slice(), k: planes.k.slice() };
    const out = applyPlaneCurves(planes, { c: invert, y: invert });
    for (const channel of ['c', 'm', 'y', 'k'] as const) expect(out[channel]).not.toBe(planes[channel]);
    expect(planes).toEqual({ width: 4, height: 3, ...before });
    expect(out.c).toEqual(Uint8Array.from(before.c, (v) => 255 - v));
    expect(out.k).toEqual(before.k);
  });

  it('applies all four curves', () => {
    const planes = planesOf(2, 2, 2);
    const out = applyPlaneCurves(planes, { c: invert, m: invert, y: invert, k: invert });
    expect(out.k).toEqual(Uint8Array.from(planes.k, (v) => 255 - v));
  });

  it('treats an identity LUT and no curve the same', () => {
    const planes = planesOf(5, 5, 3);
    expect(applyPlaneCurves(planes, { c: IDENTITY, m: IDENTITY, y: IDENTITY, k: IDENTITY })).toEqual(
      applyPlaneCurves(planes, {}),
    );
  });

  const tiny = planesOf(1, 1, 4);

  it.each<[string, Record<string, unknown>, string]>([
    ['a zero width', { width: 0 }, 'INVALID_SIZE'],
    ['a negative height', { height: -1 }, 'INVALID_SIZE'],
    ['a fractional width', { width: 1.5 }, 'INVALID_SIZE'],
    ['a string height', { height: '1' }, 'INVALID_SIZE'],
    ['a NaN width', { width: Number.NaN }, 'INVALID_SIZE'],
    ['a width above the cap', { width: MAX_PLANE_CURVE_PIXELS + 1 }, 'INVALID_SIZE'],
    ['a pixel count above the cap', { width: 20_000, height: 20_000 }, 'TOO_MANY_PIXELS'],
    ['a pixel count one above the cap', { width: MAX_PLANE_CURVE_PIXELS / 4 + 1, height: 4 }, 'TOO_MANY_PIXELS'],
    ['a short plane', { y: new Uint8Array(0) }, 'INVALID_PLANE'],
    ['a long plane', { k: new Uint8Array(2) }, 'INVALID_PLANE'],
    ['an array plane', { c: [0] }, 'INVALID_PLANE'],
    ['a missing plane', { m: undefined }, 'INVALID_PLANE'],
  ])('rejects %s', (_name, override, code) => {
    expect(errorCode(() => applyUntyped({ ...tiny, ...override }, { c: invert }))).toBe(code);
  });

  it('checks the size and plane lengths before allocating planes for the cap', () => {
    // 10 000 x 10 000 is within the cap; the 1-byte planes are rejected without allocating 100 MB.
    expect(errorCode(() => applyUntyped({ ...tiny, width: 10_000, height: 10_000 }, {}))).toBe('INVALID_PLANE');
  });

  it('checks the planes before the curves', () => {
    expect(errorCode(() => applyUntyped({ ...tiny, c: new Uint8Array(5) }, { c: 'bad' }))).toBe('INVALID_PLANE');
  });

  it.each<[string, unknown, string]>([
    ['null curves', null, 'INVALID_CURVES'],
    ['undefined curves', undefined, 'INVALID_CURVES'],
    ['an unknown channel', { w: IDENTITY }, 'INVALID_CURVES'],
    ['a short LUT', { c: new Uint8Array(255) }, 'INVALID_LUT'],
    ['a long LUT', { m: new Uint8Array(257) }, 'INVALID_LUT'],
    ['an array LUT', { y: Array.from(IDENTITY) }, 'INVALID_LUT'],
    ['a 16-bit LUT', { k: new Uint16Array(256) }, 'INVALID_LUT'],
    ['a null LUT', { c: null }, 'INVALID_LUT'],
  ])('rejects %s', (_name, curves, code) => {
    expect(errorCode(() => applyUntyped(tiny, curves))).toBe(code);
  });
});
