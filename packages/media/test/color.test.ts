import { describe, expect, it } from 'vitest';
import { type RampSample, buildLinearization, computeChannelCorrection, deltaE2000, proposeTac } from '../src/index.js';

describe('CIEDE2000', () => {
  // Reference pairs from the published CIEDE2000 test data (Sharma, Wu and Dalal, 2005).
  const pairs: Array<[[number, number, number], [number, number, number], number]> = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  ];

  it.each(pairs)('%j vs %j = %d', (p, q, expected) => {
    const x = { L: p[0], a: p[1], b: p[2] };
    const y = { L: q[0], a: q[1], b: q[2] };
    expect(deltaE2000(x, y)).toBeCloseTo(expected, 4);
    expect(deltaE2000(y, x)).toBeCloseTo(expected, 4);
  });

  it('is zero for identical colours', () => {
    expect(deltaE2000({ L: 40, a: 10, b: -5 }, { L: 40, a: 10, b: -5 })).toBe(0);
  });
});

/** A synthetic device with strong dot gain: response = 100 · (1 − (1 − n)²). */
const device = (n: number): number => 100 * (1 - (1 - n) ** 2);

function ramp(step = 0.05, noise = 0): RampSample[] {
  const samples: RampSample[] = [];
  for (let i = 0; i <= Math.round(1 / step); i++) {
    const nominal = i * step;
    samples.push({ nominal, response: device(nominal) + (i % 2 === 0 ? noise : -noise) });
  }
  return samples;
}

function expectNonDecreasing(values: number[]): void {
  for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
}

describe('linearization', () => {
  it('yields a monotonic curve that makes the response linear within 1 %', () => {
    const steps = 33;
    const curve = computeChannelCorrection(ramp(), { steps });
    expect(curve).toHaveLength(steps);
    expect(curve[0]).toBe(0);
    expect(curve[steps - 1]).toBe(1);
    expectNonDecreasing(curve);
    curve.forEach((n, j) => {
      const target = (100 * j) / (steps - 1);
      expect(Math.abs(device(n) - target)).toBeLessThanOrEqual(1);
    });
  });

  it('stays monotonic on a noisy, non-monotonic ramp', () => {
    const curve = computeChannelCorrection(ramp(0.05, 0.8), { steps: 21 });
    expectNonDecreasing(curve);
  });

  it('respects a per-channel limit', () => {
    const ramps = { cyan: ramp(), black: ramp() };
    const curves = buildLinearization(ramps, ['cyan', 'black'], {
      steps: 11,
      metric: 'de2000-from-paper',
      channelLimitsPercent: { cyan: 80 },
    });
    expect(curves.inputs).toHaveLength(11);
    expect(curves.channels.cyan?.[10]).toBeCloseTo(0.8, 6);
    expect(curves.channels.black?.[10]).toBe(1);
    expectNonDecreasing(curves.channels.cyan!);
  });

  it('rejects a ramp without the 0 % step', () => {
    expect(() => computeChannelCorrection(ramp().slice(1), { steps: 11 })).toThrow(/0 %/);
  });
});

describe('TAC proposal', () => {
  it('lands within ±5 % of the analytic knee of a saturating ink', () => {
    // L(t) = 20 + 75·e^(−t/k). The next 10 % adds less than ΔL 1 once 75·e^(−t/k)·(1 − e^(−10/k)) < 1.
    const k = 60;
    const lightness = (t: number) => 20 + 75 * Math.exp(-t / k);
    const samples = Array.from({ length: 41 }, (_, i) => ({ coveragePercent: i * 10, L: lightness(i * 10) }));
    const expected = k * Math.log(75 * (1 - Math.exp(-10 / k)));
    const proposal = proposeTac(samples);
    expect(proposal.basis).toBe('saturation');
    expect(Math.abs(proposal.proposedPercent - expected)).toBeLessThanOrEqual(0.05 * expected);
  });

  it('falls back to the highest measured coverage when lightness keeps dropping', () => {
    const samples = Array.from({ length: 31 }, (_, i) => ({ coveragePercent: i * 10, L: 95 - i * 2 }));
    expect(proposeTac(samples)).toMatchObject({ proposedPercent: 300, basis: 'max-measured' });
  });
});
