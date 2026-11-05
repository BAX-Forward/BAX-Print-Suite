import { type Lab, ValidationError } from '@bax-print/core';
import { deltaE2000 } from '../color/deltae.js';
import { roundTo } from '../color/linearization.js';
import { percentile } from '../color/stats.js';

/** Version of the accuracy report layout; bump when a field changes meaning. */
export const ACCURACY_REPORT_SCHEMA = 'bps.profiler-accuracy/1';
/** Decimal places of every ΔE2000 value in an accuracy report. */
export const ACCURACY_REPORT_DIGITS = 4;

export interface HoldOutSplit {
  build: string[];
  heldOut: string[];
}

/**
 * Deterministic split: in the given order, every Nth patch (the Nth, 2Nth, ...) is held out and
 * the rest build the profile.
 */
export function splitHoldOut(patchIds: readonly string[], everyNth: number): HoldOutSplit {
  if (!Number.isInteger(everyNth) || everyNth < 2) throw new ValidationError('everyNth must be an integer of at least 2');
  if (new Set(patchIds).size !== patchIds.length) throw new ValidationError('patch ids must be unique');
  const build: string[] = [];
  const heldOut: string[] = [];
  patchIds.forEach((id, i) => ((i + 1) % everyNth === 0 ? heldOut : build).push(id));
  if (build.length === 0 || heldOut.length === 0) {
    throw new ValidationError(`holding out every ${everyNth}th of ${patchIds.length} patch(es) leaves an empty set`, {
      build: build.length,
      heldOut: heldOut.length,
    });
  }
  return { build, heldOut };
}

export interface AccuracyEngineInput {
  name: string;
  /** Lab each engine predicts (or reproduced) per patch id. */
  predicted: ReadonlyMap<string, Lab>;
}

export interface AccuracyInput {
  engines: readonly AccuracyEngineInput[];
  measured: ReadonlyMap<string, Lab>;
  heldOut: readonly string[];
}

export interface EngineAccuracy {
  name: string;
  mean: number;
  median: number;
  p95: number;
  max: number;
  count: number;
}

export interface PatchAccuracy {
  patchId: string;
  measured: Lab;
  perEngine: Record<string, number>;
}

export interface PairwiseAccuracy {
  a: string;
  b: string;
  /** Mean over the held-out patches of |ΔE2000(a) − ΔE2000(b)|. */
  meanAbsDiff: number;
}

export interface AccuracyReport {
  schema: typeof ACCURACY_REPORT_SCHEMA;
  engines: EngineAccuracy[];
  patches: PatchAccuracy[];
  /** Present only when exactly two engines are compared. */
  pairwise?: PairwiseAccuracy;
}

function round(value: number): number {
  return roundTo(value, ACCURACY_REPORT_DIGITS);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

/** Code-unit order, so the report layout does not depend on the host locale. */
function byId(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

function validateInput(input: AccuracyInput): void {
  if (input.engines.length === 0) throw new ValidationError('at least one engine is required');
  const names = input.engines.map((e) => e.name);
  if (names.some((n) => typeof n !== 'string' || n.length === 0)) throw new ValidationError('engine names must be non-empty');
  if (new Set(names).size !== names.length) throw new ValidationError('engine names must be unique');
  if (input.heldOut.length === 0) throw new ValidationError('at least one held-out patch is required');
  if (new Set(input.heldOut).size !== input.heldOut.length) throw new ValidationError('held-out patch ids must be unique');
}

function requireLab(map: ReadonlyMap<string, Lab>, patchId: string, message: string): Lab {
  const lab = map.get(patchId);
  if (lab === undefined) throw new ValidationError(message, { patchId });
  return lab;
}

/**
 * Accuracy of one or more engines on held-out patches: ΔE2000 between the measured Lab and each
 * engine's predicted Lab. Statistics use unrounded differences; every reported ΔE2000 value is
 * rounded to ACCURACY_REPORT_DIGITS decimals. Report only: no pass or fail.
 */
export function accuracyReport(input: AccuracyInput): AccuracyReport {
  validateInput(input);
  const ids = [...input.heldOut].sort(byId);
  const rows = ids.map((patchId) => {
    const measured = requireLab(input.measured, patchId, `held-out patch ${patchId} has no measurement`);
    const des = input.engines.map((engine) => {
      const predicted = requireLab(engine.predicted, patchId, `engine ${engine.name} has no prediction for patch ${patchId}`);
      return deltaE2000(measured, predicted);
    });
    return { patchId, measured, des };
  });

  const engines = input.engines.map((engine, e): EngineAccuracy => {
    const des = rows.map((row) => row.des[e] ?? 0);
    return {
      name: engine.name,
      mean: round(mean(des)),
      median: round(median(des)),
      p95: round(percentile(des, 95)),
      max: round(Math.max(...des)),
      count: des.length,
    };
  });

  const patches = rows.map((row): PatchAccuracy => {
    const perEngine: Record<string, number> = {};
    input.engines.forEach((engine, e) => {
      perEngine[engine.name] = round(row.des[e] ?? 0);
    });
    return { patchId: row.patchId, measured: { L: row.measured.L, a: row.measured.a, b: row.measured.b }, perEngine };
  });

  const report: AccuracyReport = { schema: ACCURACY_REPORT_SCHEMA, engines, patches };
  const [a, b] = input.engines;
  if (input.engines.length !== 2 || a === undefined || b === undefined) return report;
  const diffs = rows.map((row) => Math.abs((row.des[0] ?? 0) - (row.des[1] ?? 0)));
  return { ...report, pairwise: { a: a.name, b: b.name, meanAbsDiff: round(mean(diffs)) } };
}
