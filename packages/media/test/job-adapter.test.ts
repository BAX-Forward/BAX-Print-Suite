import { describe, expect, it } from 'vitest';
import {
  BAYER_SIZES,
  type JobPipelineOptions,
  SCREEN_DOT_ON,
  type ScreenPipelineInput,
  applyPlaneCurves,
  buildCurveLut,
  composeScreening,
  pipelineOptionsFromJob,
} from '../src/index.js';

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Map) return 'Map';
  return typeof value;
}

const WIDTH = 4;
const HEIGHT = 4;

function plane(offset: number): Uint8Array {
  return Uint8Array.from({ length: WIDTH * HEIGHT }, (_, i) => (offset + i * 37) % 256);
}

function image(): ScreenPipelineInput {
  return { width: WIDTH, height: HEIGHT, c: plane(200), m: plane(150), y: plane(100), k: plane(50) };
}

function expectRejected(job: Parameters<typeof pipelineOptionsFromJob>[0], message: RegExp): void {
  expect(() => pipelineOptionsFromJob(job)).toThrow(RangeError);
  expect(() => pipelineOptionsFromJob(job)).toThrow(message);
}

describe('pipelineOptionsFromJob: absent settings', () => {
  it('maps a job without settings to no options', () => {
    expect(pipelineOptionsFromJob({})).toStrictEqual({});
  });

  it('treats undefined settings as absent and omits their keys', () => {
    const options = pipelineOptionsFromJob({ screening: undefined, inkLimit: undefined });
    expect(options).toStrictEqual({});
    expect(Object.keys(options)).toEqual([]);
  });

  it('ignores job fields other than screening and inkLimit', () => {
    const job = { id: 'job-1', copies: 2, screening: undefined };
    expect(pipelineOptionsFromJob(job)).toStrictEqual({});
  });

  it('leaves the image unchanged when composeScreening gets the empty options', () => {
    const input = image();
    const before = image();
    const result = composeScreening({ ...input, ...pipelineOptionsFromJob({}) });
    expect(result).toEqual({ c: before.c, m: before.m, y: before.y, k: before.k });
    expect(input).toEqual(before);
  });
});

describe('pipelineOptionsFromJob: bayer screening', () => {
  for (const size of BAYER_SIZES) {
    it(`maps bayer size ${String(size)} exactly`, () => {
      expect(pipelineOptionsFromJob({ screening: { kind: 'bayer', size } })).toStrictEqual({
        screening: { kind: 'bayer', size },
      });
    });
  }

  for (const size of [3, 32, 0, 4.5, '4', null]) {
    it(`rejects bayer size ${String(size)}`, () => {
      expectRejected({ screening: { kind: 'bayer', size } }, /screening\.size must be one of 2, 4, 8, 16/);
    });
  }

  it('rejects a bayer setting with a seed', () => {
    expectRejected({ screening: { kind: 'bayer', size: 4, seed: 1 } }, /unknown field "seed"/);
  });
});

describe('pipelineOptionsFromJob: blue-noise screening', () => {
  for (const size of [2, 256]) {
    it(`accepts blue-noise size ${String(size)}`, () => {
      expect(pipelineOptionsFromJob({ screening: { kind: 'blue-noise', size, seed: 7 } })).toStrictEqual({
        screening: { kind: 'blue-noise', size, seed: 7 },
      });
    });
  }

  for (const size of [1, 257, 16.5, Number.NaN, '16']) {
    it(`rejects blue-noise size ${String(size)}`, () => {
      expectRejected(
        { screening: { kind: 'blue-noise', size, seed: 7 } },
        /screening\.size must be an integer in 2\.\.256/,
      );
    });
  }

  for (const seed of [0, 4294967295]) {
    it(`accepts seed ${String(seed)}`, () => {
      expect(pipelineOptionsFromJob({ screening: { kind: 'blue-noise', size: 8, seed } })).toStrictEqual({
        screening: { kind: 'blue-noise', size: 8, seed },
      });
    });
  }

  for (const seed of [-1, 4294967296, 1.5, undefined, '1']) {
    it(`rejects seed ${String(seed)}`, () => {
      expectRejected(
        { screening: { kind: 'blue-noise', size: 8, seed } },
        /screening\.seed must be an integer in 0\.\.4294967295/,
      );
    });
  }

  it('rejects an extra blue-noise field', () => {
    expectRejected({ screening: { kind: 'blue-noise', size: 8, seed: 1, angle: 45 } }, /unknown field "angle"/);
  });
});

describe('pipelineOptionsFromJob: screening shape', () => {
  for (const kind of ['fm', 'Bayer', undefined, 1]) {
    it(`rejects kind ${String(kind)}`, () => {
      expectRejected({ screening: { kind, size: 4 } }, /screening\.kind must be one of bayer, blue-noise/);
    });
  }

  for (const value of [null, 'bayer', 4, [], new Map()]) {
    it(`rejects a non-plain screening value (${describeType(value)})`, () => {
      expectRejected({ screening: value }, /screening must be a plain object/);
    });
  }
});

describe('pipelineOptionsFromJob: ink limit', () => {
  for (const method of ['proportional', 'gcr'] as const) {
    it(`maps method ${method}`, () => {
      expect(pipelineOptionsFromJob({ inkLimit: { limitPercent: 300, method } })).toStrictEqual({
        inkLimit: { limitPercent: 300, method },
      });
    });
  }

  for (const limitPercent of [100, 400]) {
    it(`accepts limit ${String(limitPercent)}`, () => {
      expect(pipelineOptionsFromJob({ inkLimit: { limitPercent, method: 'gcr' } })).toStrictEqual({
        inkLimit: { limitPercent, method: 'gcr' },
      });
    });
  }

  for (const limitPercent of [99, 401, 250.5, undefined, '300']) {
    it(`rejects limit ${String(limitPercent)}`, () => {
      expectRejected(
        { inkLimit: { limitPercent, method: 'gcr' } },
        /inkLimit\.limitPercent must be an integer in 100\.\.400/,
      );
    });
  }

  for (const method of ['GCR', 'ucr', undefined, 0]) {
    it(`rejects method ${String(method)}`, () => {
      expectRejected(
        { inkLimit: { limitPercent: 300, method } },
        /inkLimit\.method must be one of proportional, gcr/,
      );
    });
  }

  it('rejects an extra ink-limit field', () => {
    expectRejected(
      { inkLimit: { limitPercent: 300, method: 'gcr', black: 90 } },
      /unknown field "black" in inkLimit/,
    );
  });

  for (const value of [null, 300, 'gcr', [300, 'gcr']]) {
    it(`rejects a non-plain inkLimit value (${describeType(value)})`, () => {
      expectRejected({ inkLimit: value }, /inkLimit must be a plain object/);
    });
  }
});

describe('pipelineOptionsFromJob: plane curves (spec 044c)', () => {
  const ends = [
    { in: 0, out: 0 },
    { in: 255, out: 255 },
  ];
  const sCurve = [
    { in: 0, out: 0 },
    { in: 64, out: 40 },
    { in: 192, out: 220 },
    { in: 255, out: 255 },
  ];
  const asPoints = (points: readonly { in: number; out: number }[]): { input: number; output: number }[] =>
    points.map((p) => ({ input: p.in, output: p.out }));
  const identity = Uint8Array.from({ length: 256 }, (_, i) => i);

  it('treats an absent or undefined planeCurves as off', () => {
    expect(pipelineOptionsFromJob({})).toStrictEqual({});
    expect(pipelineOptionsFromJob({ planeCurves: undefined })).toStrictEqual({});
  });

  it('maps method monotone to monotone-cubic and linear to linear', () => {
    const options = pipelineOptionsFromJob({
      planeCurves: { c: { points: sCurve, method: 'monotone' }, k: { points: sCurve, method: 'linear' } },
    });
    const monotone = buildCurveLut(asPoints(sCurve), { interpolation: 'monotone-cubic' });
    const linear = buildCurveLut(asPoints(sCurve), { interpolation: 'linear' });
    expect(options).toStrictEqual({ planeCurves: { c: monotone, k: linear } });
    expect(Array.from(monotone)).not.toEqual(Array.from(linear));
  });

  for (const method of ['monotone', 'linear'] as const) {
    it(`maps 2 endpoint points (${method}) to the identity LUT`, () => {
      const options = pipelineOptionsFromJob({ planeCurves: { m: { points: ends, method } } });
      expect(options).toStrictEqual({ planeCurves: { m: identity } });
    });

    it(`maps 256 points (${method}) exactly, one entry per point`, () => {
      const points = Array.from({ length: 256 }, (_, i) => ({ in: i, out: Math.floor((i * i) / 255) }));
      const lut = pipelineOptionsFromJob({ planeCurves: { y: { points, method } } }).planeCurves?.y;
      expect(lut).toStrictEqual(Uint8Array.from(points, (p) => p.out));
    });
  }

  it('sets only the channels the job sets', () => {
    const options = pipelineOptionsFromJob({ planeCurves: { k: { points: ends, method: 'linear' } } });
    expect(Object.keys(options.planeCurves ?? {})).toEqual(['k']);
  });

  it('rejects an empty planeCurves object and one with only undefined channels', () => {
    expectRejected({ planeCurves: {} }, /planeCurves must set at least one of c, m, y, k/);
    expectRejected({ planeCurves: { c: undefined } }, /planeCurves must set at least one of c, m, y, k/);
  });

  for (const value of [null, 'linear', 4, [], new Map()]) {
    it(`rejects a non-plain planeCurves value (${describeType(value)})`, () => {
      expectRejected({ planeCurves: value }, /planeCurves must be a plain object/);
    });
  }

  it('rejects unknown fields at every level', () => {
    expectRejected({ planeCurves: { w: { points: ends, method: 'linear' } } }, /unknown field "w" in planeCurves/);
    expectRejected(
      { planeCurves: { c: { points: ends, method: 'linear', interpolation: 'linear' } } },
      /unknown field "interpolation" in planeCurves\.c/,
    );
    expectRejected(
      { planeCurves: { c: { points: [{ in: 0, out: 0, x: 1 }, ends[1]], method: 'linear' } } },
      /unknown field "x" in planeCurves\.c\.points\[0\]/,
    );
    expectRejected(
      { planeCurves: { c: { points: [{ input: 0, output: 0 }, ends[1]], method: 'linear' } } },
      /unknown field "input" in planeCurves\.c\.points\[0\]/,
    );
  });

  for (const method of ['monotone-cubic', 'cubic', 'Linear', undefined, 1]) {
    it(`rejects method ${String(method)}`, () => {
      expectRejected(
        { planeCurves: { c: { points: ends, method } } },
        /planeCurves\.c\.method must be one of monotone, linear/,
      );
    });
  }

  for (const points of [undefined, null, 'ends', { 0: ends[0], 1: ends[1] }]) {
    it(`rejects points that are not an array (${describeType(points)})`, () => {
      expectRejected({ planeCurves: { c: { points, method: 'linear' } } }, /planeCurves\.c\.points must be an array/);
    });
  }

  for (const count of [0, 1, 257]) {
    it(`rejects ${String(count)} points`, () => {
      const points = Array.from({ length: count }, (_, i) => ({ in: Math.min(i, 255), out: 0 }));
      expectRejected(
        { planeCurves: { m: { points, method: 'linear' } } },
        /planeCurves\.m\.points must have 2\.\.256 entries/,
      );
    });
  }

  for (const bad of [-1, 256, 1.5, Number.NaN, '0', null]) {
    it(`rejects point value ${String(bad)}`, () => {
      expectRejected(
        { planeCurves: { c: { points: [{ in: bad, out: 0 }, ends[1]], method: 'linear' } } },
        /planeCurves\.c\.points\[0\]\.in must be an integer in 0\.\.255/,
      );
      expectRejected(
        { planeCurves: { c: { points: [ends[0], { in: 255, out: bad }], method: 'linear' } } },
        /planeCurves\.c\.points\[1\]\.out must be an integer in 0\.\.255/,
      );
    });
  }

  it('rejects a point that is not a plain object', () => {
    expectRejected(
      { planeCurves: { c: { points: [[0, 0], ends[1]], method: 'linear' } } },
      /planeCurves\.c\.points\[0\] must be a plain object/,
    );
  });

  it('rejects curves without both endpoints', () => {
    const noStart = [
      { in: 1, out: 0 },
      { in: 255, out: 255 },
    ];
    const noEnd = [
      { in: 0, out: 0 },
      { in: 254, out: 255 },
    ];
    for (const method of ['monotone', 'linear'] as const) {
      expectRejected({ planeCurves: { c: { points: noStart, method } } }, /planeCurves\.c: MISSING_ENDPOINT/);
      expectRejected({ planeCurves: { k: { points: noEnd, method } } }, /planeCurves\.k: MISSING_ENDPOINT/);
    }
  });

  it('rejects inputs that do not increase and outputs that decrease', () => {
    const repeated = [
      { in: 0, out: 0 },
      { in: 128, out: 100 },
      { in: 128, out: 120 },
      { in: 255, out: 255 },
    ];
    const reversed = [
      { in: 0, out: 0 },
      { in: 200, out: 100 },
      { in: 100, out: 150 },
      { in: 255, out: 255 },
    ];
    const decreasing = [
      { in: 0, out: 0 },
      { in: 128, out: 200 },
      { in: 192, out: 150 },
      { in: 255, out: 255 },
    ];
    expectRejected({ planeCurves: { y: { points: repeated, method: 'monotone' } } }, /planeCurves\.y: INPUT_NOT_INCREASING/);
    expectRejected({ planeCurves: { y: { points: reversed, method: 'linear' } } }, /planeCurves\.y: INPUT_NOT_INCREASING/);
    expectRejected({ planeCurves: { m: { points: decreasing, method: 'monotone' } } }, /planeCurves\.m: OUTPUT_DECREASING/);
  });

  it('reports the ink-limit error before the plane-curves error', () => {
    expectRejected({ inkLimit: { limitPercent: 99, method: 'gcr' }, planeCurves: {} }, /inkLimit\.limitPercent/);
  });

  it('runs mapped curves through composeScreening like applyPlaneCurves', () => {
    const options = pipelineOptionsFromJob({ planeCurves: { c: { points: sCurve, method: 'monotone' } } });
    const input = image();
    const result = composeScreening({ ...input, ...options });
    const expected = applyPlaneCurves(input, options.planeCurves ?? {});
    expect([result.c, result.m, result.y, result.k]).toEqual([expected.c, expected.m, expected.y, expected.k]);
    expect(result.c).not.toEqual(input.c);
  });
});

describe('pipelineOptionsFromJob: composeScreening', () => {
  const jobs: { name: string; job: Parameters<typeof pipelineOptionsFromJob>[0] }[] = [
    { name: 'bayer only', job: { screening: { kind: 'bayer', size: 8 } } },
    { name: 'blue-noise only', job: { screening: { kind: 'blue-noise', size: 4, seed: 12345 } } },
    { name: 'ink limit only', job: { inkLimit: { limitPercent: 100, method: 'proportional' } } },
    {
      name: 'ink limit and screening',
      job: { inkLimit: { limitPercent: 240, method: 'gcr' }, screening: { kind: 'bayer', size: 2 } },
    },
  ];

  for (const { name, job } of jobs) {
    it(`runs the mapped options (${name}) through composeScreening`, () => {
      const options: JobPipelineOptions = pipelineOptionsFromJob(job);
      expect(() => composeScreening({ ...image(), ...options })).not.toThrow();
      const result = composeScreening({ ...image(), ...options });
      for (const planeValues of [result.c, result.m, result.y, result.k]) {
        expect(planeValues).toHaveLength(WIDTH * HEIGHT);
        if (options.screening) expect(planeValues.every((v) => v === 0 || v === SCREEN_DOT_ON)).toBe(true);
      }
    });
  }

  it('reports the screening error before the ink-limit error', () => {
    expectRejected(
      { screening: { kind: 'bayer', size: 3 }, inkLimit: { limitPercent: 99, method: 'gcr' } },
      /screening\.size/,
    );
  });
});
