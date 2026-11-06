import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WHITE_SEPARATION_NAME,
  MAX_WHITE_INK_PIXELS,
  WHITE_INK_BYTES_PER_PIXEL,
  type WhiteChokeShape,
  type WhiteLayerInput,
  planWhiteLayer,
  whiteDensityToLevel,
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

/** `#` = full coverage, `.` = none. */
function grid(rows: readonly string[]): Pick<WhiteLayerInput, 'width' | 'height' | 'coverage'> {
  const width = rows[0]?.length ?? 0;
  const coverage = new Uint8Array(rows.length * width);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) coverage[y * width + x] = row[x] === '#' ? 255 : 0;
  });
  return { width, height: rows.length, coverage };
}

function render(mask: Uint8Array, width: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < mask.length; i += width) {
    rows.push(Array.from(mask.subarray(i, i + width), (v) => (v > 0 ? '#' : '.')).join(''));
  }
  return rows;
}

/** Calls the planner the way an untyped caller would, to reach the runtime validation. */
function callUntyped(input: Record<string, unknown>): unknown {
  return Reflect.apply(planWhiteLayer, undefined, [input]);
}

/** Brute-force erosion: a pixel survives if no uncovered pixel lies within the radius inside the image. */
function referenceChoke(
  spot: Uint8Array,
  width: number,
  height: number,
  radius: number,
  shape: WhiteChokeShape,
): Uint8Array {
  const out = new Uint8Array(spot.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let keep = (spot[i] ?? 0) > 0;
      for (let dy = -radius; dy <= radius && keep; dy++) {
        for (let dx = -radius; dx <= radius && keep; dx++) {
          if (shape === 'diamond' && Math.abs(dx) + Math.abs(dy) > radius) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && spot[ny * width + nx] === 0) keep = false;
        }
      }
      out[i] = keep ? (spot[i] ?? 0) : 0;
    }
  }
  return out;
}

describe('planWhiteLayer modes', () => {
  const artwork = grid(['.....', '.###.', '.##..', '.....']);

  it('flood covers every pixel at full density', () => {
    const layer = planWhiteLayer({ ...artwork, mode: 'flood' });
    expect(layer.coveredPixels).toBe(20);
    expect(Array.from(layer.mask).every((v) => v === 255)).toBe(true);
    expect(layer.separationName).toBe(DEFAULT_WHITE_SEPARATION_NAME);
    expect(layer.separationName).toBe('White');
    expect([layer.width, layer.height]).toEqual([5, 4]);
  });

  it('spot follows the coverage threshold', () => {
    const layer = planWhiteLayer({ ...artwork, mode: 'spot' });
    expect(render(layer.mask, 5)).toEqual(['.....', '.###.', '.##..', '.....']);
    expect(layer.coveredPixels).toBe(5);

    const coverage = Uint8Array.from([0, 1, 99, 100, 200, 255]);
    const at100 = planWhiteLayer({ width: 6, height: 1, coverage, mode: 'spot', threshold: 100 });
    expect(Array.from(at100.mask)).toEqual([0, 0, 0, 255, 255, 255]);
    const at0 = planWhiteLayer({ width: 6, height: 1, coverage, mode: 'spot', threshold: 0 });
    expect(at0.coveredPixels).toBe(6);
    const atDefault = planWhiteLayer({ width: 6, height: 1, coverage, mode: 'spot' });
    expect(Array.from(atDefault.mask)).toEqual([0, 255, 255, 255, 255, 255]);
  });

  it('choke shrinks a block by the radius', () => {
    const block = grid(['.......', '.#####.', '.#####.', '.#####.', '.#####.', '.#####.', '.......']);
    const square = planWhiteLayer({ ...block, mode: 'choke', chokePx: 1 });
    expect(render(square.mask, 7)).toEqual(['.......', '.......', '..###..', '..###..', '..###..', '.......', '.......']);
    const two = planWhiteLayer({ ...block, mode: 'choke', chokePx: 2 });
    expect(two.coveredPixels).toBe(1);
    expect(render(two.mask, 7)[3]).toBe('...#...');
  });

  it('square and diamond chokes grow a hole as a square and a diamond', () => {
    const holed = grid(['#######', '#######', '#######', '###.###', '#######', '#######', '#######']);
    const square = planWhiteLayer({ ...holed, mode: 'choke', chokePx: 2, shape: 'square' });
    expect(render(square.mask, 7)).toEqual(['#######', '#.....#', '#.....#', '#.....#', '#.....#', '#.....#', '#######']);
    const diamond = planWhiteLayer({ ...holed, mode: 'choke', chokePx: 2, shape: 'diamond' });
    expect(render(diamond.mask, 7)).toEqual(['#######', '###.###', '##...##', '#.....#', '##...##', '###.###', '#######']);
    expect(diamond.coveredPixels).toBe(49 - 13);
  });

  it('does not erode from outside the image edge', () => {
    const full = grid(['####', '####', '####']);
    for (const shape of ['square', 'diamond'] as const) {
      expect(planWhiteLayer({ ...full, mode: 'choke', chokePx: 5, shape }).coveredPixels).toBe(12);
    }
  });

  it('choke with radius 0 (the default) equals spot', () => {
    const spot = planWhiteLayer({ ...artwork, mode: 'spot' });
    expect(planWhiteLayer({ ...artwork, mode: 'choke' }).mask).toEqual(spot.mask);
    expect(planWhiteLayer({ ...artwork, mode: 'choke', chokePx: 0, shape: 'diamond' }).mask).toEqual(spot.mask);
  });

  it('invert flips the selection before the choke and the density', () => {
    const inverted = planWhiteLayer({ ...artwork, mode: 'spot', invert: true, density: 50 });
    expect(render(inverted.mask, 5)).toEqual(['#####', '#...#', '#..##', '#####']);
    expect(new Set(Array.from(inverted.mask))).toEqual(new Set([0, 128]));
    expect(inverted.coveredPixels).toBe(15);

    expect(planWhiteLayer({ ...artwork, mode: 'flood', invert: true }).coveredPixels).toBe(0);

    const choked = planWhiteLayer({ ...artwork, mode: 'choke', chokePx: 1, invert: true });
    expect(render(choked.mask, 5)).toEqual(['.....', '.....', '.....', '....#']);
    const wide = grid(['#.....', '......', '......']);
    const chokedWide = planWhiteLayer({ ...wide, mode: 'choke', chokePx: 1, invert: true });
    expect(render(chokedWide.mask, 6)).toEqual(['..####', '..####', '######']);
  });
});

describe('white ink density', () => {
  it.each([
    [0, 0],
    [1, 3],
    [2, 5],
    [10, 26],
    [50, 128],
    [99, 252],
    [100, 255],
  ])('density %d maps to level %d', (density, level) => {
    expect(whiteDensityToLevel(density)).toBe(level);
    expect(Math.round((255 * density) / 100)).toBe(level);
    const layer = planWhiteLayer({ width: 2, height: 1, coverage: Uint8Array.from([255, 0]), mode: 'spot', density });
    expect(Array.from(layer.mask)).toEqual([level, 0]);
    expect(layer.coveredPixels).toBe(level > 0 ? 1 : 0);
  });

  it('matches round(255 * d / 100) for every integer density', () => {
    for (let d = 0; d <= 100; d++) expect(whiteDensityToLevel(d)).toBe(Math.round((255 * d) / 100));
  });
});

describe('white ink properties (seeded)', () => {
  it('choke is a subset of spot, matches a brute-force erosion, and flood covers all (300 masks)', () => {
    const rng = seededRng(0x038a);
    const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
    for (let trial = 0; trial < 300; trial++) {
      const width = int(1, 24);
      const height = int(1, 24);
      const fill = rng();
      const coverage = new Uint8Array(width * height);
      for (let i = 0; i < coverage.length; i++) coverage[i] = rng() < fill ? int(1, 255) : 0;
      const base = {
        width,
        height,
        coverage,
        threshold: int(0, 255),
        invert: rng() < 0.3,
        density: int(1, 100),
      };
      const chokePx = int(0, 6);
      const shape: WhiteChokeShape = rng() < 0.5 ? 'square' : 'diamond';

      const flood = planWhiteLayer({ ...base, invert: false, mode: 'flood' });
      const spot = planWhiteLayer({ ...base, mode: 'spot' });
      const choke = planWhiteLayer({ ...base, mode: 'choke', chokePx, shape });

      expect(flood.coveredPixels).toBe(width * height);
      expect(choke.coveredPixels).toBeLessThanOrEqual(spot.coveredPixels);
      for (let i = 0; i < coverage.length; i++) {
        if ((choke.mask[i] ?? 0) > 0) expect(spot.mask[i]).toBe(choke.mask[i]);
      }
      expect(choke.mask).toEqual(referenceChoke(spot.mask, width, height, chokePx, shape));

      const larger = planWhiteLayer({ ...base, mode: 'choke', chokePx: chokePx + 1, shape });
      for (let i = 0; i < coverage.length; i++) {
        if ((larger.mask[i] ?? 0) > 0) expect(choke.mask[i]).toBeGreaterThan(0);
      }
    }
  });
});

describe('planWhiteLayer validation', () => {
  const ok = { width: 2, height: 2, coverage: new Uint8Array(4), mode: 'spot' };

  it('exposes the size constants', () => {
    expect(WHITE_INK_BYTES_PER_PIXEL).toBe(1);
    expect(MAX_WHITE_INK_PIXELS).toBe(100_000_000);
    expect(callUntyped(ok)).toMatchObject({ width: 2, height: 2, coveredPixels: 0 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_WHITE_INK_PIXELS + 1, '2'])(
    'rejects width and height %s',
    (bad) => {
      expect(() => callUntyped({ ...ok, width: bad })).toThrow(RangeError);
      expect(() => callUntyped({ ...ok, width: bad })).toThrow(/width/);
      expect(() => callUntyped({ ...ok, height: bad })).toThrow(/height/);
    },
  );

  it('rejects a huge width * height before allocating', () => {
    const started = performance.now();
    expect(() => planWhiteLayer({ width: 100_000, height: 100_000, coverage: new Uint8Array(1), mode: 'flood' })).toThrow(
      /exceeds MAX_WHITE_INK_PIXELS/,
    );
    expect(() =>
      planWhiteLayer({ width: MAX_WHITE_INK_PIXELS, height: MAX_WHITE_INK_PIXELS, coverage: new Uint8Array(1), mode: 'flood' }),
    ).toThrow(/exceeds MAX_WHITE_INK_PIXELS/);
    expect(() => planWhiteLayer({ width: 10_001, height: 10_000, coverage: new Uint8Array(1), mode: 'flood' })).toThrow(
      /exceeds MAX_WHITE_INK_PIXELS/,
    );
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('rejects coverage of the wrong length or type', () => {
    expect(() => callUntyped({ ...ok, coverage: new Uint8Array(3) })).toThrow(/coverage has 3 bytes/);
    expect(() => callUntyped({ ...ok, coverage: new Uint8Array(5) })).toThrow(RangeError);
    expect(() => callUntyped({ ...ok, coverage: [0, 0, 0, 0] })).toThrow(/Uint8Array/);
    expect(() => callUntyped({ ...ok, coverage: new Uint16Array(4) })).toThrow(/Uint8Array/);
  });

  it.each([
    ['mode', 'bogus'],
    ['mode', undefined],
    ['threshold', -1],
    ['threshold', 256],
    ['threshold', 1.5],
    ['chokePx', -1],
    ['chokePx', 65],
    ['chokePx', 2.5],
    ['shape', 'circle'],
    ['density', -1],
    ['density', 101],
    ['density', 50.5],
    ['invert', 'yes'],
    ['separationName', ''],
    ['separationName', '   '],
    ['separationName', 'W'.repeat(64)],
    ['separationName', 'Weiß'],
    ['separationName', 'White\tInk'],
    ['separationName', 42],
  ])('rejects %s = %j', (key, value) => {
    expect(() => callUntyped({ ...ok, [key]: value })).toThrow(RangeError);
    expect(() => callUntyped({ ...ok, [key]: value })).toThrow(new RegExp(key));
  });

  it('accepts the boundary values and a printable ASCII override', () => {
    const layer = planWhiteLayer({
      width: 2,
      height: 2,
      coverage: new Uint8Array(4),
      mode: 'choke',
      threshold: 255,
      chokePx: 64,
      density: 0,
      separationName: 'W'.repeat(63),
    });
    expect(layer.separationName).toHaveLength(63);
    expect(planWhiteLayer({ ...grid(['#']), mode: 'spot', separationName: 'Underbase 1' }).separationName).toBe(
      'Underbase 1',
    );
    expect(() => whiteDensityToLevel(101)).toThrow(RangeError);
  });
});

describe('white ink performance', () => {
  it('chokes a 4096 x 4096 mask with radius 32 in under 2 s', () => {
    const size = 4096;
    const coverage = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) coverage[y * size + x] = ((x >> 7) + (y >> 7)) % 3 === 0 ? 0 : 200;
    }
    const started = performance.now();
    const layer = planWhiteLayer({ width: size, height: size, coverage, mode: 'choke', chokePx: 32 });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(layer.coveredPixels).toBeGreaterThan(0);
    expect(layer.coveredPixels).toBeLessThan(size * size);
  }, 20_000);
});
