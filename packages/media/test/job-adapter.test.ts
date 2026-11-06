import { describe, expect, it } from 'vitest';
import {
  BAYER_SIZES,
  type JobPipelineOptions,
  SCREEN_DOT_ON,
  type ScreenPipelineInput,
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
