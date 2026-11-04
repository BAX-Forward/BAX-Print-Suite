import { type Lab, type LinearizationCurves, type LinearizationMetric, ValidationError } from '@bax-print/core';
import { deltaE2000 } from './deltae.js';
import { deltaE76 } from './lab.js';

export interface RampSample {
  /** Device value 0..1 as printed. */
  nominal: number;
  /** Measured response, increasing with colorant amount (e.g. ΔE from paper). */
  response: number;
}

const EPS = 1e-9;

export function roundTo(value: number, digits = 6): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Pool-adjacent-violators: the closest non-decreasing sequence in the least-squares sense. */
export function isotonicNonDecreasing(values: readonly number[]): number[] {
  const blocks: Array<{ mean: number; count: number }> = [];
  for (const value of values) {
    blocks.push({ mean: value, count: 1 });
    while (blocks.length >= 2 && blocks[blocks.length - 2]!.mean > blocks[blocks.length - 1]!.mean) {
      const last = blocks.pop()!;
      const prev = blocks.pop()!;
      const count = prev.count + last.count;
      blocks.push({ mean: (prev.mean * prev.count + last.mean * last.count) / count, count });
    }
  }
  return blocks.flatMap((block) => Array<number>(block.count).fill(block.mean));
}

/** Piecewise-linear interpolation over increasing `xs`, clamped at both ends. */
export function interpolate(xs: readonly number[], ys: readonly number[], x: number): number {
  if (x <= xs[0]!) return ys[0]!;
  const last = xs.length - 1;
  if (x >= xs[last]!) return ys[last]!;
  for (let k = 0; k < last; k++) {
    if (x <= xs[k + 1]!) {
      const span = xs[k + 1]! - xs[k]!;
      return span <= 0 ? ys[k + 1]! : ys[k]! + ((x - xs[k]!) / span) * (ys[k + 1]! - ys[k]!);
    }
  }
  return ys[last]!;
}

/** Inverse of a non-decreasing piecewise-linear function; flat runs resolve to their start. */
function inverseMonotone(xs: readonly number[], ys: readonly number[], y: number): number {
  const last = xs.length - 1;
  if (y <= ys[0]!) return xs[0]!;
  if (y >= ys[last]!) {
    for (let k = 0; k <= last; k++) if (ys[k]! >= ys[last]!) return xs[k]!;
  }
  for (let k = 0; k < last; k++) {
    if (ys[k + 1]! >= y && ys[k + 1]! > ys[k]!) {
      return xs[k]! + ((y - ys[k]!) / (ys[k + 1]! - ys[k]!)) * (xs[k + 1]! - xs[k]!);
    }
  }
  return xs[last]!;
}

export function applyCurve(inputs: readonly number[], outputs: readonly number[], u: number): number {
  return interpolate(inputs, outputs, Math.min(1, Math.max(0, u)));
}

/** Input that produces device value `n`, or undefined when `n` is beyond the curve's range (a limit). */
export function invertCurve(inputs: readonly number[], outputs: readonly number[], n: number): number | undefined {
  if (n < outputs[0]! - EPS || n > outputs[outputs.length - 1]! + EPS) return undefined;
  return inverseMonotone(inputs, outputs, n);
}

export function responseFromLab(lab: Lab, paper: Lab, metric: LinearizationMetric): number {
  return metric === 'de2000-from-paper' ? deltaE2000(paper, lab) : deltaE76(paper, lab);
}

/**
 * Correction curve for one channel, sampled at `steps` uniform inputs. Composed with the device
 * (device(correction(u))) it yields a response proportional to u, from paper up to the response
 * at `limit` (the L3 channel maximum, 0..1; 1 for L2).
 */
export function computeChannelCorrection(
  samples: readonly RampSample[],
  options: { steps: number; limit?: number },
): number[] {
  const limit = options.limit ?? 1;
  if (!(limit > 0 && limit <= 1)) throw new ValidationError('channel limit must be within (0, 1]');
  if (!Number.isInteger(options.steps) || options.steps < 2) throw new ValidationError('steps must be an integer >= 2');
  const sorted = [...samples].sort((p, q) => p.nominal - q.nominal);
  if (sorted.length < 2 || sorted.some((s) => !Number.isFinite(s.nominal) || !Number.isFinite(s.response))) {
    throw new ValidationError('a ramp needs at least two finite samples');
  }
  if (Math.abs(sorted[0]!.nominal) > EPS) throw new ValidationError('a ramp must include the 0 % step');
  if (sorted[sorted.length - 1]!.nominal < limit - EPS) throw new ValidationError('a ramp must reach the channel limit');

  const xs = sorted.map((s) => s.nominal);
  const ys = isotonicNonDecreasing(sorted.map((s) => s.response));
  const r0 = ys[0]!;
  const rMax = interpolate(xs, ys, limit);
  if (!(rMax - r0 > EPS)) throw new ValidationError('the ramp shows no measurable response');

  const px: number[] = [];
  const py: number[] = [];
  xs.forEach((x, i) => {
    if (x < limit - EPS) {
      px.push(x);
      py.push(ys[i]!);
    }
  });
  px.push(limit);
  py.push(rMax);

  const outputs: number[] = [];
  for (let j = 0; j < options.steps; j++) {
    const u = j / (options.steps - 1);
    const n = roundTo(Math.min(limit, Math.max(0, inverseMonotone(px, py, r0 + u * (rMax - r0)))));
    outputs.push(j === 0 ? n : Math.max(n, outputs[j - 1]!));
  }
  return outputs;
}

export function uniformInputs(steps: number): number[] {
  return Array.from({ length: steps }, (_, j) => roundTo(j / (steps - 1)));
}

export function buildLinearization(
  ramps: Readonly<Record<string, readonly RampSample[]>>,
  colorants: readonly string[],
  options: { steps: number; metric: LinearizationMetric; channelLimitsPercent?: Readonly<Record<string, number>> },
): LinearizationCurves {
  const channels: Record<string, number[]> = {};
  for (const colorant of colorants) {
    const samples = ramps[colorant];
    if (!samples) throw new ValidationError(`no ramp measured for colorant ${colorant}`);
    const limitPercent = options.channelLimitsPercent?.[colorant] ?? 100;
    channels[colorant] = computeChannelCorrection(samples, { steps: options.steps, limit: limitPercent / 100 });
  }
  return { metric: options.metric, inputs: uniformInputs(options.steps), channels };
}

/** Device values after the per-channel curves (identity when no curves). */
export function applyCurves(curves: LinearizationCurves | undefined, colorants: readonly string[], u: readonly number[]): number[] {
  if (!curves) return [...u];
  return colorants.map((c, i) => applyCurve(curves.inputs, curves.channels[c]!, u[i]!));
}

/** Linearized-space values for raw device values, or undefined if any channel is beyond its limit. */
export function invertCurves(
  curves: LinearizationCurves | undefined,
  colorants: readonly string[],
  n: readonly number[],
): number[] | undefined {
  if (!curves) return [...n];
  const out: number[] = [];
  for (const [i, c] of colorants.entries()) {
    const u = invertCurve(curves.inputs, curves.channels[c]!, n[i]!);
    if (u === undefined) return undefined;
    out.push(u);
  }
  return out;
}
