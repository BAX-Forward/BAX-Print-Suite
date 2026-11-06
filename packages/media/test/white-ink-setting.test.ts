import { parseWhiteInkSetting, type WhiteInkSetting } from '@bax-print/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WHITE_SEPARATION_NAME, planWhiteLayer, whiteLayerInputFromSetting } from '../src/index.js';

const WIDTH = 7;
const HEIGHT = 5;

/** Fixed coverage ramp, so threshold, invert and choke all change the mask. */
function coverage(): Uint8Array {
  const bytes = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 1; y < HEIGHT - 1; y++) {
    for (let x = 1; x < WIDTH - 1; x++) bytes[y * WIDTH + x] = 40 * x;
  }
  return bytes;
}

const SETTINGS: readonly WhiteInkSetting[] = [
  { mode: 'flood' },
  { mode: 'flood', density: 50, invert: true },
  { mode: 'spot', threshold: 100 },
  { mode: 'spot', threshold: 0, invert: true, separationName: 'Opaque' },
  { mode: 'choke', chokePx: 1 },
  { mode: 'choke', threshold: 80, chokePx: 1, shape: 'diamond', density: 75 },
];

describe('whiteLayerInputFromSetting (spec 038b)', () => {
  it.each(SETTINGS)('produces the same layer as calling planWhiteLayer directly: %o', (setting) => {
    const viaSetting = planWhiteLayer(whiteLayerInputFromSetting(setting, coverage(), WIDTH, HEIGHT));
    const direct = planWhiteLayer({ width: WIDTH, height: HEIGHT, coverage: coverage(), ...setting });
    expect(viaSetting).toEqual(direct);
  });

  it('round-trips a parsed setting into the planner', () => {
    const setting = parseWhiteInkSetting({ mode: 'spot', threshold: 120, density: 100 });
    expect(setting).toBeDefined();
    if (setting === undefined) return;
    const layer = planWhiteLayer(whiteLayerInputFromSetting(setting, coverage(), WIDTH, HEIGHT));
    expect(layer).toEqual(planWhiteLayer({ width: WIDTH, height: HEIGHT, coverage: coverage(), mode: 'spot', threshold: 120 }));
    expect(layer.coveredPixels).toBeGreaterThan(0);
  });

  it('defaults the separation name to "White"', () => {
    const input = whiteLayerInputFromSetting({ mode: 'flood' }, coverage(), WIDTH, HEIGHT);
    expect(input.separationName).toBe(DEFAULT_WHITE_SEPARATION_NAME);
    expect(input.separationName).toBe('White');
    expect(planWhiteLayer(input).separationName).toBe('White');
  });

  it('passes only the fields the setting has', () => {
    const input = whiteLayerInputFromSetting({ mode: 'choke', chokePx: 2 }, coverage(), WIDTH, HEIGHT);
    expect(Object.keys(input).sort()).toEqual(['chokePx', 'coverage', 'height', 'mode', 'separationName', 'width']);
  });

  it('keeps an explicit separation name', () => {
    const input = whiteLayerInputFromSetting({ mode: 'spot', separationName: 'Opaque' }, coverage(), WIDTH, HEIGHT);
    expect(planWhiteLayer(input).separationName).toBe('Opaque');
  });
});
