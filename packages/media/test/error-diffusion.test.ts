import { describe, expect, it } from 'vitest';
import {
  ERROR_DIFFUSION_KERNELS,
  type ErrorDiffusionKernel,
  MAX_SCREEN_PIXELS,
  applyErrorDiffusion,
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

function randomPlane(width: number, height: number, seed: number): Uint8Array {
  const rng = seededRng(seed);
  const plane = new Uint8Array(width * height);
  for (let i = 0; i < plane.length; i++) plane[i] = Math.floor(rng() * 256);
  return plane;
}

function flatPlane(width: number, height: number, value: number): Uint8Array {
  return new Uint8Array(width * height).fill(value);
}

function coverage(out: Uint8Array): number {
  let on = 0;
  for (const v of out) if (v === 255) on++;
  return on / out.length;
}

/** Calls the function the way an untyped caller would, to reach the runtime validation. */
function diffuseUntyped(input: unknown, options: unknown): unknown {
  return Reflect.apply(applyErrorDiffusion, undefined, [input, options]);
}

const CONFIGS: { kernel: ErrorDiffusionKernel; serpentine: boolean }[] = ERROR_DIFFUSION_KERNELS.flatMap((kernel) => [
  { kernel, serpentine: false },
  { kernel, serpentine: true },
]);
const SEEDS = [1, 7, 42, 2024, 0xdead_beef];
const LEVELS = [32, 64, 128, 192, 224];
const COVERAGE_TOLERANCE = 0.02;

describe('applyErrorDiffusion', () => {
  describe.each(CONFIGS)('$kernel, serpentine $serpentine', (options) => {
    it('outputs only 0 and 255', () => {
      for (const seed of SEEDS) {
        const out = applyErrorDiffusion({ width: 37, height: 23, plane: randomPlane(37, 23, seed) }, options);
        expect(out).toHaveLength(37 * 23);
        expect(out.every((v) => v === 0 || v === 255)).toBe(true);
      }
    });

    it('is deterministic', () => {
      for (const seed of SEEDS) {
        const plane = randomPlane(40, 30, seed);
        const a = applyErrorDiffusion({ width: 40, height: 30, plane }, options);
        const b = applyErrorDiffusion({ width: 40, height: 30, plane: plane.slice() }, { ...options });
        expect(b).toEqual(a);
      }
    });

    it('leaves all-0 and all-255 planes unchanged', () => {
      for (const value of [0, 255]) {
        const plane = flatPlane(19, 11, value);
        expect(applyErrorDiffusion({ width: 19, height: 11, plane }, options)).toEqual(plane);
      }
    });

    it.each(LEVELS)('keeps the mean coverage of a flat 64 x 64 patch at level %i within 2 %', (level) => {
      const out = applyErrorDiffusion({ width: 64, height: 64, plane: flatPlane(64, 64, level) }, options);
      expect(Math.abs(coverage(out) - level / 255)).toBeLessThanOrEqual(COVERAGE_TOLERANCE);
    });

    it('does not mutate the input plane', () => {
      const plane = randomPlane(25, 17, 99);
      const copy = plane.slice();
      applyErrorDiffusion({ width: 25, height: 17, plane }, options);
      expect(plane).toEqual(copy);
    });

    it('handles single-row and single-column images', () => {
      for (const [width, height] of [
        [1, 1],
        [1, 9],
        [9, 1],
        [2, 2],
      ] as const) {
        const out = applyErrorDiffusion({ width, height, plane: randomPlane(width, height, 5) }, options);
        expect(out).toHaveLength(width * height);
        expect(out.every((v) => v === 0 || v === 255)).toBe(true);
      }
    });
  });

  it('defaults to raster order', () => {
    const plane = randomPlane(32, 32, 3);
    for (const kernel of ERROR_DIFFUSION_KERNELS) {
      expect(applyErrorDiffusion({ width: 32, height: 32, plane }, { kernel })).toEqual(
        applyErrorDiffusion({ width: 32, height: 32, plane }, { kernel, serpentine: false }),
      );
    }
  });

  it('gives different results for serpentine and raster order on random planes', () => {
    for (const kernel of ERROR_DIFFUSION_KERNELS) {
      for (const seed of SEEDS) {
        const plane = randomPlane(32, 32, seed);
        const raster = applyErrorDiffusion({ width: 32, height: 32, plane }, { kernel, serpentine: false });
        const serpentine = applyErrorDiffusion({ width: 32, height: 32, plane }, { kernel, serpentine: true });
        expect(serpentine).not.toEqual(raster);
      }
    }
  });

  it('mirrors the kernel on odd serpentine rows', () => {
    // With an error-free first row, serpentine row 1 is raster row 1 of the mirrored image, mirrored back.
    const width = 24;
    const row = randomPlane(width, 1, 11);
    const reversed = row.slice().reverse();
    for (const kernel of ERROR_DIFFUSION_KERNELS) {
      const plane = new Uint8Array(2 * width);
      plane.set(row, width);
      const mirroredPlane = new Uint8Array(2 * width);
      mirroredPlane.set(reversed, width);
      const serpentine = applyErrorDiffusion({ width, height: 2, plane }, { kernel, serpentine: true });
      const raster = applyErrorDiffusion({ width, height: 2, plane: mirroredPlane }, { kernel });
      expect(Array.from(serpentine.subarray(width))).toEqual(Array.from(raster.subarray(width)).reverse());
    }
  });

  it('diffuses Floyd-Steinberg error to the right with weight 7/16', () => {
    // 100 -> 0 leaves error 100; the next pixel gets round(700 / 16) = 44 and 100 + 44 >= 128.
    const out = applyErrorDiffusion(
      { width: 2, height: 1, plane: Uint8Array.of(100, 100) },
      { kernel: 'floyd-steinberg' },
    );
    expect(Array.from(out)).toEqual([0, 255]);
  });

  it('diffuses Floyd-Steinberg error downwards with weight 5/16', () => {
    // 1 x 2 image: 200 -> 255 leaves error -55; below gets round(-275 / 16) = -17, and 140 - 17 < 128.
    const out = applyErrorDiffusion(
      { width: 1, height: 2, plane: Uint8Array.of(200, 140) },
      { kernel: 'floyd-steinberg' },
    );
    expect(Array.from(out)).toEqual([255, 0]);
  });

  it('diffuses Jarvis-Judice-Ninke error two pixels ahead', () => {
    // 100 -> 0 leaves error 100 (500 to x = 2, 700 to x = 1); 0 + round(700 / 48) = 15 -> 0 adds 7 · 15 = 105
    // to x = 2, which gets round(605 / 48) = 13, and 120 + 13 >= 128.
    const out = applyErrorDiffusion(
      { width: 3, height: 1, plane: Uint8Array.of(100, 0, 120) },
      { kernel: 'jarvis-judice-ninke' },
    );
    expect(Array.from(out)).toEqual([0, 0, 255]);
  });

  it('thresholds at 128 without diffused error', () => {
    for (const kernel of ERROR_DIFFUSION_KERNELS) {
      const below = applyErrorDiffusion({ width: 1, height: 1, plane: Uint8Array.of(127) }, { kernel });
      const at = applyErrorDiffusion({ width: 1, height: 1, plane: Uint8Array.of(128) }, { kernel });
      expect(Array.from(below)).toEqual([0]);
      expect(Array.from(at)).toEqual([255]);
    }
  });

  describe('validation', () => {
    const plane = new Uint8Array(4);
    const options = { kernel: 'floyd-steinberg' };

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', undefined, MAX_SCREEN_PIXELS + 1])(
      'rejects width %s',
      (width) => {
        expect(() => diffuseUntyped({ width, height: 2, plane }, options)).toThrow(RangeError);
        expect(() => diffuseUntyped({ width, height: 2, plane }, options)).toThrow(/applyErrorDiffusion: width/);
      },
    );

    it.each([0, -3, 2.5, Number.NaN, null, MAX_SCREEN_PIXELS + 1])('rejects height %s', (height) => {
      expect(() => diffuseUntyped({ width: 2, height, plane }, options)).toThrow(/applyErrorDiffusion: height/);
    });

    it('rejects pixel counts above MAX_SCREEN_PIXELS before looking at the plane', () => {
      for (const [width, height] of [
        [MAX_SCREEN_PIXELS, 2],
        [100_000, 100_000],
        [MAX_SCREEN_PIXELS, MAX_SCREEN_PIXELS],
      ]) {
        expect(() => diffuseUntyped({ width, height, plane }, options)).toThrow(/exceeds MAX_SCREEN_PIXELS/);
      }
    });

    it('rejects a plane of the wrong length or type', () => {
      expect(() => diffuseUntyped({ width: 2, height: 2, plane: new Uint8Array(3) }, options)).toThrow(
        /plane has 3 bytes, expected width \* height = 4/,
      );
      for (const bad of [new Uint8ClampedArray(4), [0, 0, 0, 0], new Uint16Array(4), undefined]) {
        expect(() => diffuseUntyped({ width: 2, height: 2, plane: bad }, options)).toThrow(
          /plane must be a Uint8Array/,
        );
      }
    });

    it('rejects a missing input object', () => {
      for (const bad of [null, undefined, 4, 'image']) {
        expect(() => diffuseUntyped(bad, options)).toThrow(/applyErrorDiffusion: input must be an object/);
      }
    });

    it('rejects unknown or missing kernels', () => {
      for (const kernel of ['atkinson', 'Floyd-Steinberg', '', undefined, 1]) {
        expect(() => diffuseUntyped({ width: 2, height: 2, plane }, { kernel })).toThrow(/options.kernel must be/);
      }
      expect(() => diffuseUntyped({ width: 2, height: 2, plane }, {})).toThrow(/options.kernel must be/);
    });

    it('rejects unknown option keys', () => {
      expect(() =>
        diffuseUntyped({ width: 2, height: 2, plane }, { kernel: 'floyd-steinberg', threshold: 100 }),
      ).toThrow(/options has unknown key threshold/);
    });

    it('rejects a non-boolean serpentine flag', () => {
      for (const serpentine of [1, 'true', null]) {
        expect(() =>
          diffuseUntyped({ width: 2, height: 2, plane }, { kernel: 'floyd-steinberg', serpentine }),
        ).toThrow(/options.serpentine must be a boolean/);
      }
    });

    it('rejects missing options', () => {
      for (const bad of [undefined, null, 'floyd-steinberg']) {
        expect(() => diffuseUntyped({ width: 2, height: 2, plane }, bad)).toThrow(/options must be an object/);
      }
    });
  });
});
