import {
  type ColorSetupContent,
  type Lab,
  type LinearizationMetric,
  ValidationError,
  type VerificationThresholds,
} from '@bax-print/core';
import type { ProfilePatch } from '@bax-print/plugin-sdk';
import { deltaE2000 } from '../color/deltae.js';
import { meanLab } from '../color/lab.js';
import { type RampSample, applyCurves, invertCurves, responseFromLab, roundTo } from '../color/linearization.js';
import { type DeltaSummary, summarize } from '../color/stats.js';
import type { CoverageSample } from '../color/tac.js';
import type { MeasurementSet } from '../measurements.js';
import type { ChartLayout, ChartPatch } from '../targets/chart.js';

export interface PatchMeasurement {
  patch: ChartPatch;
  lab: Lab;
}

/** Every chart patch needs a measurement, and every measurement must name a chart patch. */
export function joinMeasurements(layout: ChartLayout, set: MeasurementSet): PatchMeasurement[] {
  const byId = new Map(set.patches.map((p) => [p.id, p.lab]));
  const chartIds = new Set(layout.patches.map((p) => p.id));
  const unknown = set.patches.filter((p) => !chartIds.has(p.id)).map((p) => p.id);
  if (unknown.length > 0) {
    throw new ValidationError(`${unknown.length} measured patch(es) are not on chart ${layout.chartId}`, {
      unknown: unknown.slice(0, 20),
    });
  }
  const missing = layout.patches.filter((p) => !byId.has(p.id)).map((p) => p.id);
  if (missing.length > 0) {
    throw new ValidationError(`${missing.length} patch(es) of chart ${layout.chartId} were not measured`, {
      missing: missing.slice(0, 20),
    });
  }
  return layout.patches.map((patch) => ({ patch, lab: byId.get(patch.id) as Lab }));
}

/** Mean of every unprinted (all-zero) patch. */
export function paperWhite(joined: readonly PatchMeasurement[]): Lab {
  const paper = joined.filter((m) => m.patch.device.every((v) => v === 0)).map((m) => m.lab);
  if (paper.length === 0) throw new ValidationError('the chart has no unprinted (paper) patch');
  return meanLab(paper);
}

export function rampSamples(
  joined: readonly PatchMeasurement[],
  colorants: readonly string[],
  paper: Lab,
  metric: LinearizationMetric,
): Record<string, RampSample[]> {
  const ramps: Record<string, RampSample[]> = {};
  colorants.forEach((colorant, index) => {
    ramps[colorant] = joined
      .filter((m) => m.patch.role === 'ramp' && m.patch.channel === colorant)
      .map((m) => ({ nominal: m.patch.device[index]!, response: responseFromLab(m.lab, paper, metric) }));
  });
  return ramps;
}

export function coverageSamples(joined: readonly PatchMeasurement[]): CoverageSample[] {
  return joined
    .filter((m) => m.patch.role === 'coverage')
    .map((m) => ({ coveragePercent: roundTo(m.patch.device.reduce((s, v) => s + v, 0) * 100, 4), L: m.lab.L }));
}

/**
 * Profile patches in the space the profile describes: raw device values mapped through the
 * inverse of the linearization curves. Patches beyond a channel limit are dropped.
 */
export function profilePatches(
  joined: readonly PatchMeasurement[],
  colorants: readonly string[],
  curves: ColorSetupContent['curves'],
): { patches: ProfilePatch[]; dropped: number } {
  const patches: ProfilePatch[] = [];
  let dropped = 0;
  for (const m of joined) {
    if (m.patch.role !== 'profile') continue;
    const device = invertCurves(curves, colorants, m.patch.device);
    if (!device) {
      dropped += 1;
      continue;
    }
    patches.push({ id: m.patch.id, device: device.map((v) => roundTo(v)), lab: { ...m.lab } });
  }
  if (patches.length === 0) throw new ValidationError('no profile patches are within the channel limits');
  return { patches, dropped };
}

/**
 * Raw device values for profile-space values: per-channel curves, then the TAC limit by scaling
 * all channels down proportionally. Mirrors what the render-time ColorEngine applies.
 */
export function renderDeviceValues(content: ColorSetupContent, colorants: readonly string[], u: readonly number[]): number[] {
  const n = applyCurves(content.curves, colorants, u).map((v) => Math.min(1, Math.max(0, v)));
  const limit = content.tacLimitPercent === undefined ? undefined : content.tacLimitPercent / 100;
  const total = n.reduce((s, v) => s + v, 0);
  return limit !== undefined && total > limit ? n.map((v) => (v * limit) / total) : n;
}

/** Evenly spaced picks from the measured profile patches, as default verification references. */
export function selectVerificationReferences(patches: readonly ProfilePatch[], max: number): Lab[] {
  if (patches.length <= max) return patches.map((p) => ({ ...p.lab }));
  const picks: Lab[] = [];
  for (let i = 0; i < max; i++) picks.push({ ...patches[Math.floor((i * patches.length) / max)]!.lab });
  return picks;
}

export interface VerificationPatchResult {
  id: string;
  reference: Lab;
  measured: Lab;
  deltaE2000: number;
}

export interface VerificationReport {
  chartId: string;
  condition: MeasurementSet['condition'];
  patches: VerificationPatchResult[];
  summary: DeltaSummary;
  thresholds: VerificationThresholds;
  passed: boolean;
}

export function verificationReport(
  layout: ChartLayout,
  set: MeasurementSet,
  thresholds: VerificationThresholds,
): VerificationReport {
  if (layout.kind !== 'verification') throw new ValidationError('not a verification chart');
  const joined = joinMeasurements(layout, set);
  const patches = joined.map((m): VerificationPatchResult => {
    if (!m.patch.reference) throw new ValidationError(`verification patch ${m.patch.id} has no reference value`);
    return {
      id: m.patch.id,
      reference: m.patch.reference,
      measured: m.lab,
      deltaE2000: roundTo(deltaE2000(m.patch.reference, m.lab), 4),
    };
  });
  const summary = summarize(patches.map((p) => p.deltaE2000));
  return {
    chartId: layout.chartId,
    condition: set.condition,
    patches,
    summary,
    thresholds: { ...thresholds },
    passed: summary.mean <= thresholds.maxMeanDeltaE2000 && summary.p95 <= thresholds.maxP95DeltaE2000,
  };
}
