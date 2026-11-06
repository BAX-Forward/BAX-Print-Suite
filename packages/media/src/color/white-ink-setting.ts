import type { WhiteInkSetting } from '@bax-print/core';
import { DEFAULT_WHITE_SEPARATION_NAME, type WhiteLayerInput } from './white-ink.js';

/** Spec 038b: maps a job's white ink setting onto the spec 038a `planWhiteLayer` input. */
export function whiteLayerInputFromSetting(
  setting: WhiteInkSetting,
  coverage: Uint8Array,
  width: number,
  height: number,
): WhiteLayerInput {
  return {
    width,
    height,
    coverage,
    mode: setting.mode,
    ...(setting.threshold === undefined ? {} : { threshold: setting.threshold }),
    ...(setting.chokePx === undefined ? {} : { chokePx: setting.chokePx }),
    ...(setting.shape === undefined ? {} : { shape: setting.shape }),
    ...(setting.density === undefined ? {} : { density: setting.density }),
    ...(setting.invert === undefined ? {} : { invert: setting.invert }),
    separationName: setting.separationName ?? DEFAULT_WHITE_SEPARATION_NAME,
  };
}
