import { type Lab, ValidationError } from '@bax-print/core';
import { describe, expect, it } from 'vitest';
import { ACCURACY_REPORT_SCHEMA, accuracyReport, splitHoldOut } from '../src/index.js';

const IDS = ['p1', 'p2', 'p3', 'p4', 'p5'];

/**
 * A neutral pair centred on L* 50 whose ΔE2000 is exactly `de`: with a* = b* = 0 and a mean
 * lightness of 50, CIEDE2000 reduces to the lightness difference.
 */
function pair(de: number): { measured: Lab; predicted: Lab } {
  return { measured: { L: 50 - de / 2, a: 0, b: 0 }, predicted: { L: 50 + de / 2, a: 0, b: 0 } };
}

/** Measured Labs for IDS and an engine named `name` whose ΔE2000 per patch is `des`. */
function fixture(name: string, des: readonly number[]) {
  const measured = new Map<string, Lab>();
  const predicted = new Map<string, Lab>();
  IDS.forEach((id, i) => {
    const p = pair(des[i] ?? 0);
    measured.set(id, p.measured);
    predicted.set(id, p.predicted);
  });
  return { engine: { name, predicted }, measured };
}

describe('splitHoldOut', () => {
  it('holds out every Nth patch, in order', () => {
    expect(splitHoldOut(IDS, 2)).toEqual({ build: ['p1', 'p3', 'p5'], heldOut: ['p2', 'p4'] });
    expect(splitHoldOut(IDS, 5)).toEqual({ build: ['p1', 'p2', 'p3', 'p4'], heldOut: ['p5'] });
  });

  it('is deterministic', () => {
    const ids = Array.from({ length: 50 }, (_, i) => String(i + 1));
    expect(splitHoldOut(ids, 4)).toEqual(splitHoldOut([...ids], 4));
    expect(splitHoldOut(ids, 4).heldOut).toEqual(['4', '8', '12', '16', '20', '24', '28', '32', '36', '40', '44', '48']);
  });

  it('rejects N below 2 or not an integer', () => {
    expect(() => splitHoldOut(IDS, 1)).toThrow(ValidationError);
    expect(() => splitHoldOut(IDS, 0)).toThrow(ValidationError);
    expect(() => splitHoldOut(IDS, 2.5)).toThrow(ValidationError);
  });

  it('rejects a split that leaves an empty set', () => {
    expect(() => splitHoldOut(IDS, 6)).toThrow(ValidationError);
    expect(() => splitHoldOut([], 2)).toThrow(ValidationError);
    expect(() => splitHoldOut(['p1'], 2)).toThrow(ValidationError);
  });

  it('rejects duplicate ids', () => {
    expect(() => splitHoldOut(['p1', 'p1', 'p2'], 2)).toThrow(ValidationError);
  });
});

describe('accuracyReport', () => {
  it('summarizes a hand-made 5-patch set', () => {
    const { engine, measured } = fixture('near', [1, 2, 3, 4, 5]);
    const report = accuracyReport({ engines: [engine], measured, heldOut: ['p3', 'p1', 'p5', 'p2', 'p4'] });
    expect(report.schema).toBe(ACCURACY_REPORT_SCHEMA);
    expect(report.schema).toBe('bps.profiler-accuracy/1');
    expect(report.engines).toEqual([{ name: 'near', mean: 3, median: 3, p95: 5, max: 5, count: 5 }]);
    expect(report.patches.map((p) => p.patchId)).toEqual(IDS);
    expect(report.patches.map((p) => p.perEngine.near)).toEqual([1, 2, 3, 4, 5]);
    expect(report.patches[0]?.measured).toEqual({ L: 49.5, a: 0, b: 0 });
    expect(report.pairwise).toBeUndefined();
  });

  it('takes the mean of the middle pair as the median of an even count', () => {
    const { engine, measured } = fixture('near', [1, 2, 3, 4, 5]);
    const report = accuracyReport({ engines: [engine], measured, heldOut: ['p1', 'p2', 'p3', 'p4'] });
    expect(report.engines[0]).toEqual({ name: 'near', mean: 2.5, median: 2.5, p95: 4, max: 4, count: 4 });
  });

  it('rounds every ΔE2000 value to 4 decimals', () => {
    const { engine, measured } = fixture('near', [1 / 3, 2 / 3, 1, 1, 1]);
    const report = accuracyReport({ engines: [engine], measured, heldOut: IDS });
    expect(report.patches[0]?.perEngine.near).toBe(0.3333);
    expect(report.engines[0]?.mean).toBe(0.8);
  });

  it('compares exactly two engines pairwise', () => {
    const { engine, measured } = fixture('near', [1, 2, 3, 4, 5]);
    // A second engine that predicts every measurement exactly.
    const perfect = { name: 'perfect', predicted: new Map(measured) };
    const report = accuracyReport({ engines: [engine, perfect], measured, heldOut: IDS });
    expect(report.engines.map((e) => e.name)).toEqual(['near', 'perfect']);
    expect(report.engines[1]).toEqual({ name: 'perfect', mean: 0, median: 0, p95: 0, max: 0, count: 5 });
    expect(report.patches[4]?.perEngine).toEqual({ near: 5, perfect: 0 });
    expect(report.pairwise).toEqual({ a: 'near', b: 'perfect', meanAbsDiff: 3 });
  });

  it('omits the pairwise comparison for one or three engines', () => {
    const { engine, measured } = fixture('near', [1, 2, 3, 4, 5]);
    const others = ['mid', 'far'].map((name) => ({ name, predicted: engine.predicted }));
    const three = accuracyReport({ engines: [engine, ...others], measured, heldOut: IDS });
    expect(three.engines).toHaveLength(3);
    expect('pairwise' in three).toBe(false);
    expect('pairwise' in accuracyReport({ engines: [engine], measured, heldOut: IDS })).toBe(false);
  });

  it('names the engine and patch of a missing prediction', () => {
    const { engine, measured } = fixture('near', [1, 2, 3, 4, 5]);
    const predicted = new Map(engine.predicted);
    predicted.delete('p4');
    const input = { engines: [engine, { name: 'other', predicted }], measured, heldOut: IDS };
    expect(() => accuracyReport(input)).toThrow(ValidationError);
    expect(() => accuracyReport(input)).toThrow(/engine other .*patch p4/);
  });

  it('rejects a held-out patch without a measurement', () => {
    const { engine, measured } = fixture('near', [1, 2, 3, 4, 5]);
    expect(() => accuracyReport({ engines: [engine], measured, heldOut: ['p1', 'p9'] })).toThrow(ValidationError);
  });

  it('rejects empty or ambiguous input', () => {
    const { engine, measured } = fixture('near', [1, 2, 3, 4, 5]);
    expect(() => accuracyReport({ engines: [], measured, heldOut: IDS })).toThrow(ValidationError);
    expect(() => accuracyReport({ engines: [engine], measured, heldOut: [] })).toThrow(ValidationError);
    expect(() => accuracyReport({ engines: [engine], measured, heldOut: ['p1', 'p1'] })).toThrow(ValidationError);
    expect(() => accuracyReport({ engines: [engine, engine], measured, heldOut: IDS })).toThrow(ValidationError);
  });
});
