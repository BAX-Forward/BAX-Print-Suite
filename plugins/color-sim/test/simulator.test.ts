import { describe, expect, it } from 'vitest';
import { MEASUREMENT_INTERFACE, MEASUREMENT_VERSION, type MeasurementLayout } from '@bax-print/plugin-sdk';
import { cmykToLab, type Cmyk, type Lab } from '../src/ground-truth.js';
import { DEFAULT_NOISE_SIGMA_DE, LabNoise, mulberry32 } from '../src/noise.js';
import { ColorSimulator, DEFAULT_SIM_CONDITION, SIM_INSTRUMENT_ID, type PrintedPatch } from '../src/simulator.js';

const PAPER: Cmyk = { c: 0, m: 0, y: 0, k: 0 };
const SOLID_K: Cmyk = { c: 0, m: 0, y: 0, k: 100 };

const CHART: readonly PrintedPatch[] = [
  { patchId: 'paper', cmyk: PAPER },
  { patchId: 'c100', cmyk: { c: 100, m: 0, y: 0, k: 0 } },
  { patchId: 'm100', cmyk: { c: 0, m: 100, y: 0, k: 0 } },
  { patchId: 'y100', cmyk: { c: 0, m: 0, y: 100, k: 0 } },
  { patchId: 'k100', cmyk: SOLID_K },
  { patchId: 'k50', cmyk: { c: 0, m: 0, y: 0, k: 50 } },
];

function layoutFor(chartId: string, strips: readonly (readonly string[])[]): MeasurementLayout {
  return {
    chartId,
    patchSizeMm: 6,
    strips: strips.map((patchIds, index) => ({ stripId: `s${String(index + 1)}`, patchIds: [...patchIds] })),
  };
}

function printedSimulator(seed: number, sigmaDe?: number): ColorSimulator {
  const sim = new ColorSimulator(sigmaDe === undefined ? { seed } : { seed, sigmaDe });
  sim.printChart('chart-1', CHART);
  return sim;
}

const ALL_PATCHES: readonly string[] = CHART.map((patch) => patch.patchId);

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function labAt(labs: readonly Lab[], index: number): Lab {
  const lab = labs[index];
  if (lab === undefined) {
    throw new Error(`no Lab at index ${String(index)}`);
  }
  return lab;
}

describe('ColorSimulator', () => {
  it('matches the Measurement interface name and version from the SDK', async () => {
    expect(MEASUREMENT_INTERFACE).toBe('Measurement');
    expect(MEASUREMENT_VERSION).toBe('1.0');

    const instruments = await new ColorSimulator().listInstruments();
    expect(instruments).toHaveLength(1);
    const instrument = instruments[0];
    if (instrument === undefined) {
      throw new Error('no instrument listed');
    }
    expect(instrument.id).toBe(SIM_INSTRUMENT_ID);
    expect(instrument.conditions).toContain(DEFAULT_SIM_CONDITION);
  });

  it('gives identical readings for the same seed and different readings for another seed', async () => {
    const layout = layoutFor('chart-1', [ALL_PATCHES]);
    const first = await printedSimulator(42).measureStrip(layout);
    const second = await printedSimulator(42).measureStrip(layout);
    const other = await printedSimulator(43).measureStrip(layout);

    expect(second).toEqual(first);
    expect(other.patches.map((patch) => patch.lab)).not.toEqual(first.patches.map((patch) => patch.lab));
  });

  it('restarts the noise stream on reset()', async () => {
    const sim = printedSimulator(7);
    const layout = layoutFor('chart-1', [ALL_PATCHES]);
    const before = await sim.measureStrip(layout);
    const drifted = await sim.measureStrip(layout);
    sim.reset();
    const after = await sim.measureStrip(layout);

    expect(drifted).not.toEqual(before);
    expect(after).toEqual(before);
  });

  it('returns one patch per requested patch, in strip order', async () => {
    const sim = printedSimulator(1);
    const strips = [['k100', 'paper'], ['m100'], ['c100', 'y100', 'k50', 'paper']];
    const result = await sim.measureStrip(layoutFor('chart-1', strips));

    expect(result.instrumentId).toBe(SIM_INSTRUMENT_ID);
    expect(result.condition).toBe(DEFAULT_SIM_CONDITION);
    expect(result.patches.map((patch) => patch.patchId)).toEqual(strips.flat());
    for (const patch of result.patches) {
      expect(Number.isFinite(patch.lab.L)).toBe(true);
      expect(Number.isFinite(patch.lab.a)).toBe(true);
      expect(Number.isFinite(patch.lab.b)).toBe(true);
    }
  });

  it('reports plausible Lab for paper white and solid K without noise', async () => {
    const sim = printedSimulator(1, 0);
    const result = await sim.measureStrip(layoutFor('chart-1', [['paper', 'k50', 'k100']]));
    const labs = result.patches.map((patch) => patch.lab);
    const paper = labAt(labs, 0);
    const k50 = labAt(labs, 1);
    const k100 = labAt(labs, 2);

    expect(paper.L).toBeGreaterThan(93);
    expect(paper.L).toBeLessThan(97);
    expect(Math.abs(paper.a)).toBeLessThan(3);
    expect(paper.b).toBeLessThan(0);
    expect(paper.b).toBeGreaterThan(-5);

    expect(k100.L).toBeLessThan(25);
    expect(k100.L).toBeGreaterThan(5);
    expect(Math.hypot(k100.a, k100.b)).toBeLessThan(5);

    // Lightness falls monotonically with black coverage.
    expect(k50.L).toBeLessThan(paper.L);
    expect(k50.L).toBeGreaterThan(k100.L);

    // sigmaDe 0 is exactly the ground-truth model.
    expect(paper).toEqual(cmykToLab(PAPER));
    expect(k100).toEqual(cmykToLab(SOLID_K));
  });

  it('adds zero-mean noise with the default 0.3 dE RMS over 500 samples', async () => {
    const sampleCount = 500;
    const sim = new ColorSimulator({ seed: 2024 });
    expect(sim.sigmaDe).toBe(DEFAULT_NOISE_SIGMA_DE);
    const patches: PrintedPatch[] = Array.from({ length: sampleCount }, (_, index) => ({
      patchId: `p${String(index)}`,
      cmyk: PAPER,
    }));
    sim.printChart('repeat', patches);
    const result = await sim.measureStrip(layoutFor('repeat', [patches.map((patch) => patch.patchId)]));
    expect(result.patches).toHaveLength(sampleCount);

    const truth = cmykToLab(PAPER);
    const dL = result.patches.map((patch) => patch.lab.L - truth.L);
    const da = result.patches.map((patch) => patch.lab.a - truth.a);
    const db = result.patches.map((patch) => patch.lab.b - truth.b);

    // Per-axis std is 0.3 / sqrt(3) ~ 0.17, so the standard error of each mean is ~0.008.
    expect(Math.abs(mean(dL))).toBeLessThan(0.05);
    expect(Math.abs(mean(da))).toBeLessThan(0.05);
    expect(Math.abs(mean(db))).toBeLessThan(0.05);

    const squared = dL.map((value, index) => value * value + (da[index] ?? 0) ** 2 + (db[index] ?? 0) ** 2);
    const rms = Math.sqrt(mean(squared));
    expect(rms).toBeGreaterThan(0.27);
    expect(rms).toBeLessThan(0.33);
  });

  it('rejects an unprinted chart, an unknown patch and an unknown instrument', async () => {
    const sim = printedSimulator(1);
    await expect(sim.measureStrip(layoutFor('missing', [['paper']]))).rejects.toThrow(RangeError);
    await expect(sim.measureStrip(layoutFor('chart-1', [['paper', 'nope']]))).rejects.toThrow(/nope/);
    await expect(
      sim.measureStrip(layoutFor('chart-1', [['paper']]), { instrumentId: 'other' }),
    ).rejects.toThrow(RangeError);
  });

  it('leaves the noise stream untouched when a measurement fails', async () => {
    const layout = layoutFor('chart-1', [ALL_PATCHES]);
    const clean = await printedSimulator(9).measureStrip(layout);

    const sim = printedSimulator(9);
    await expect(sim.measureStrip(layoutFor('chart-1', [['paper', 'nope']]))).rejects.toThrow();
    expect(await sim.measureStrip(layout)).toEqual(clean);
  });

  it('rejects duplicate patch ids and out-of-range CMYK at print time', () => {
    const sim = new ColorSimulator();
    expect(() =>
      sim.printChart('dup', [
        { patchId: 'a', cmyk: PAPER },
        { patchId: 'a', cmyk: SOLID_K },
      ]),
    ).toThrow(RangeError);
    expect(() => sim.printChart('bad', [{ patchId: 'a', cmyk: { c: 101, m: 0, y: 0, k: 0 } }])).toThrow(RangeError);
    expect(() => sim.printChart('', [])).toThrow(RangeError);
  });
});

describe('noise', () => {
  it('mulberry32 is deterministic per seed and stays in [0, 1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let index = 0; index < 100; index += 1) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('LabNoise rejects a negative sigma and gives zero offsets for sigma 0', () => {
    expect(() => new LabNoise(1, -0.1)).toThrow(RangeError);
    const offset = new LabNoise(1, 0).nextOffset();
    expect(Math.abs(offset.L) + Math.abs(offset.a) + Math.abs(offset.b)).toBe(0);
  });
});
