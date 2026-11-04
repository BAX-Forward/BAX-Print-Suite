import { ValidationError } from '@bax-print/core';
import { interpolate, isotonicNonDecreasing } from './linearization.js';

export interface CoverageSample {
  /** Total area coverage in percent of one full channel. */
  coveragePercent: number;
  /** Measured lightness L*. */
  L: number;
}

export interface TacProposal {
  proposedPercent: number;
  /** `saturation`: found the knee; `max-measured`: lightness still drops at the highest measured coverage. */
  basis: 'saturation' | 'max-measured';
  stepPercent: number;
  thresholdDeltaL: number;
}

export const TAC_STEP_PERCENT = 10;
export const TAC_THRESHOLD_DELTA_L = 1;
const SCAN_RESOLUTION_PERCENT = 1;

/**
 * Spec 005 FR5: the proposed TAC is the coverage at which the next 10 % adds less than ΔE 1 in
 * lightness. Lightness is made non-increasing (isotonic fit) and interpolated linearly, then
 * scanned at 1 % resolution. This is a proposal; the user accepts or edits it.
 */
export function proposeTac(
  samples: readonly CoverageSample[],
  options: { stepPercent?: number; thresholdDeltaL?: number } = {},
): TacProposal {
  const stepPercent = options.stepPercent ?? TAC_STEP_PERCENT;
  const thresholdDeltaL = options.thresholdDeltaL ?? TAC_THRESHOLD_DELTA_L;
  const sorted = [...samples].sort((p, q) => p.coveragePercent - q.coveragePercent);
  if (sorted.length < 2) throw new ValidationError('a TAC proposal needs at least two coverage samples');
  const xs = sorted.map((s) => s.coveragePercent);
  const ls = isotonicNonDecreasing(sorted.map((s) => -s.L)).map((v) => -v);
  const lightness = (t: number): number => interpolate(xs, ls, t);
  const first = xs[0]!;
  const last = xs[xs.length - 1]!;

  for (let t = first; t + stepPercent <= last + 1e-9; t += SCAN_RESOLUTION_PERCENT) {
    if (lightness(t) - lightness(t + stepPercent) < thresholdDeltaL) {
      return { proposedPercent: Math.round(t), basis: 'saturation', stepPercent, thresholdDeltaL };
    }
  }
  return { proposedPercent: Math.round(last), basis: 'max-measured', stepPercent, thresholdDeltaL };
}
