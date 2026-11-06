import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ERROR_DIFFUSION_KERNELS,
  SCREEN_DOT_ON,
  type ScreenPipelineInput,
  applyErrorDiffusion,
  composeScreening,
  pipelineOptionsFromJob,
} from '../src/index.js';
import { SCREEN_DOT_ON as DOT_MODULE_DOT_ON } from '../src/screening/dot.js';

const WIDTH = 6;
const HEIGHT = 5;

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

describe('pipelineOptionsFromJob: error-diffusion screening (spec 045c)', () => {
  for (const kernel of ERROR_DIFFUSION_KERNELS) {
    it(`maps kernel ${kernel} without serpentine exactly`, () => {
      expect(pipelineOptionsFromJob({ screening: { kind: 'error-diffusion', kernel } })).toStrictEqual({
        screening: { kind: 'error-diffusion', kernel },
      });
    });

    for (const serpentine of [true, false]) {
      it(`maps kernel ${kernel} with serpentine ${String(serpentine)} exactly`, () => {
        expect(pipelineOptionsFromJob({ screening: { kind: 'error-diffusion', kernel, serpentine } })).toStrictEqual({
          screening: { kind: 'error-diffusion', kernel, serpentine },
        });
      });
    }
  }

  for (const kernel of [undefined, 'atkinson', 'Floyd-Steinberg', 1, null]) {
    it(`rejects kernel ${String(kernel)}`, () => {
      expectRejected(
        { screening: { kind: 'error-diffusion', kernel } },
        /screening\.kernel must be one of floyd-steinberg, jarvis-judice-ninke for error-diffusion/,
      );
    });
  }

  for (const serpentine of ['true', 1, 0, null, undefined]) {
    it(`rejects serpentine ${String(serpentine)}`, () => {
      expectRejected(
        { screening: { kind: 'error-diffusion', kernel: 'floyd-steinberg', serpentine } },
        /screening\.serpentine must be a boolean for error-diffusion/,
      );
    });
  }

  for (const field of ['size', 'seed', 'extra']) {
    it(`rejects an error-diffusion setting with ${field}`, () => {
      expectRejected(
        { screening: { kind: 'error-diffusion', kernel: 'floyd-steinberg', [field]: 4 } },
        new RegExp(`unknown field "${field}" in screening \\(error-diffusion\\)`),
      );
    });
  }

  it('rejects error-diffusion fields on a threshold kind', () => {
    expectRejected({ screening: { kind: 'bayer', size: 4, kernel: 'floyd-steinberg' } }, /unknown field "kernel"/);
    expectRejected({ screening: { kind: 'blue-noise', size: 8, seed: 1, serpentine: true } }, /unknown field "serpentine"/);
  });

  for (const kernel of ERROR_DIFFUSION_KERNELS) {
    for (const serpentine of [undefined, true, false]) {
      it(`screens like applyErrorDiffusion per plane (${kernel}, serpentine ${String(serpentine)})`, () => {
        const setting = serpentine === undefined ? { kind: 'error-diffusion', kernel } : { kind: 'error-diffusion', kernel, serpentine };
        const input = image();
        const out = composeScreening({ ...input, ...pipelineOptionsFromJob({ screening: setting }) });
        const options = { kernel, serpentine: serpentine ?? false };
        for (const name of ['c', 'm', 'y', 'k'] as const) {
          const source = input[name];
          expect(out[name]).toEqual(applyErrorDiffusion({ width: WIDTH, height: HEIGHT, plane: source }, options));
          expect(out[name].every((v) => v === 0 || v === SCREEN_DOT_ON)).toBe(true);
        }
      });
    }
  }
});

describe('SCREEN_DOT_ON module layout (spec 045c)', () => {
  it('is defined in dot.ts and re-exported unchanged', () => {
    expect(SCREEN_DOT_ON).toBe(255);
    expect(DOT_MODULE_DOT_ON).toBe(SCREEN_DOT_ON);
  });

  it('error-diffusion.ts does not import ./pipeline', () => {
    const source = readFileSync(new URL('../src/screening/error-diffusion.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"]\.\/pipeline(\.js)?['"]/);
    expect(source).not.toMatch(/import\s*\(\s*['"]\.\/pipeline(\.js)?['"]\s*\)/);
    expect(source).toMatch(/from\s+['"]\.\/dot\.js['"]/);
  });
});
