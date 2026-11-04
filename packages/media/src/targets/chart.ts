import { type Lab, type ProfilingLevel, ValidationError } from '@bax-print/core';
import type { MeasurementLayout } from '@bax-print/plugin-sdk';
import {
  type CgatsHeaderEntry,
  CgatsParseError,
  cgatsHeaderValue,
  cgatsNumber,
  cgatsRecords,
  formatCgatsNumber,
  parseCgats,
  serializeCgats,
} from '../cgats.js';
import { roundTo } from '../color/linearization.js';

export type PatchRole = 'ramp' | 'coverage' | 'profile' | 'verification';
export type ChartKind = 'characterization' | 'verification';

export interface ChartPatch {
  id: string;
  role: PatchRole;
  /** Set for single-channel ramp patches. */
  channel?: string;
  /** 1-based strip (row) on the chart. */
  strip: number;
  /** Nominal raw device values 0..1, one per colorant. */
  device: number[];
  /** Verification charts only: the Lab value the patch is expected to reproduce. */
  reference?: Lab;
}

export interface ChartLayout {
  chartId: string;
  kind: ChartKind;
  title: string;
  colorants: string[];
  patchSizeMm: number;
  pageWidthMm: number;
  strips: number;
  patches: ChartPatch[];
}

export const CHART_MARGIN_MM = 10;
export const CHART_HEADER_MM = 10;
export const STRIP_LABEL_MM = 16;
export const STRIP_GAP_MM = 4;
export const MAX_CHART_PATCHES = 20_000;

const DEVICE_PERCENT_DIGITS = 4;
const KEYWORDS = {
  chartId: 'BPS_CHART_ID',
  kind: 'BPS_CHART_KIND',
  colorants: 'BPS_COLORANTS',
  patchSize: 'BPS_PATCH_SIZE_MM',
  pageWidth: 'BPS_PAGE_WIDTH_MM',
  strip: 'BPS_STRIP',
} as const;

/** Device values are kept at the precision written to the layout file, so files and memory agree. */
export function quantizeDevice(value: number): number {
  return roundTo(Math.min(1, Math.max(0, value)) * 100, DEVICE_PERCENT_DIGITS) / 100;
}

/** `steps` evenly spaced values from 0 to 1; 21 steps are 5 % increments. */
export function rampLevels(steps: number): number[] {
  if (!Number.isInteger(steps) || steps < 2) throw new ValidationError('a ramp needs an integer number of steps >= 2');
  return Array.from({ length: steps }, (_, j) => quantizeDevice(j / (steps - 1)));
}

/** Levels per channel of the profile grid, keeping the chart near or below about 2000 patches. */
export function defaultGridLevels(channelCount: number): number {
  if (channelCount <= 3) return 9;
  if (channelCount === 4) return 6;
  if (channelCount === 5) return 4;
  if (channelCount <= 8) return 3;
  return 2;
}

export function patchesPerStrip(pageWidthMm: number, patchSizeMm: number): number {
  const count = Math.floor((pageWidthMm - 2 * CHART_MARGIN_MM - STRIP_LABEL_MM) / patchSizeMm);
  if (count < 1) throw new ValidationError('the page is too narrow for one patch per strip');
  return count;
}

type PatchSpec = Omit<ChartPatch, 'id' | 'strip'>;

/** Numbers patches 1..n; each group starts a new strip and wraps when a strip is full. */
function assignStrips(groups: PatchSpec[][], perStrip: number): { patches: ChartPatch[]; strips: number } {
  const patches: ChartPatch[] = [];
  let strip = 0;
  for (const group of groups) {
    group.forEach((spec, i) => {
      if (i % perStrip === 0) strip += 1;
      patches.push({ ...spec, id: String(patches.length + 1), strip });
    });
  }
  if (patches.length > MAX_CHART_PATCHES) {
    throw new ValidationError(`the chart would have ${patches.length} patches; the limit is ${MAX_CHART_PATCHES}`);
  }
  return { patches, strips: strip };
}

function gridPoints(channels: number, levels: readonly number[]): number[][] {
  const total = levels.length ** channels;
  if (total > MAX_CHART_PATCHES) throw new ValidationError(`a ${levels.length}-level grid over ${channels} channels is too large`);
  const points: number[][] = [];
  for (let index = 0; index < total; index++) {
    const point: number[] = [];
    let rest = index;
    for (let c = 0; c < channels; c++) {
      point.push(levels[rest % levels.length]!);
      rest = Math.floor(rest / levels.length);
    }
    points.push(point);
  }
  return points;
}

export interface CharacterizationChartOptions {
  chartId: string;
  title: string;
  colorants: string[];
  level: ProfilingLevel;
  rampSteps: number;
  gridLevels: number;
  patchSizeMm: number;
  pageWidthMm: number;
}

/**
 * One chart per session: single-channel ramps and an equal-amount coverage ramp (L2/L3), then a
 * multi-dimensional grid for profile building. Everything is printed raw (no curves, no profile).
 */
export function buildCharacterizationChart(options: CharacterizationChartOptions): ChartLayout {
  const { colorants } = options;
  const groups: PatchSpec[][] = [];
  if (options.level !== 'L1') {
    const ramp = rampLevels(options.rampSteps);
    for (const channel of colorants) {
      groups.push(ramp.map((v) => ({ role: 'ramp', channel, device: colorants.map((c) => (c === channel ? v : 0)) })));
    }
    groups.push(ramp.map((v) => ({ role: 'coverage', device: colorants.map(() => v) })));
  }
  const grid = gridPoints(colorants.length, rampLevels(options.gridLevels));
  groups.push(grid.map((device) => ({ role: 'profile', device })));
  const { patches, strips } = assignStrips(groups, patchesPerStrip(options.pageWidthMm, options.patchSizeMm));
  return {
    chartId: options.chartId,
    kind: 'characterization',
    title: options.title,
    colorants: [...colorants],
    patchSizeMm: options.patchSizeMm,
    pageWidthMm: options.pageWidthMm,
    strips,
    patches,
  };
}

export interface VerificationChartOptions {
  chartId: string;
  title: string;
  colorants: string[];
  patchSizeMm: number;
  pageWidthMm: number;
  patches: Array<{ device: number[]; reference: Lab }>;
}

export function buildVerificationChart(options: VerificationChartOptions): ChartLayout {
  const group: PatchSpec[] = options.patches.map((p) => ({
    role: 'verification',
    device: p.device.map(quantizeDevice),
    reference: { ...p.reference },
  }));
  const { patches, strips } = assignStrips([group], patchesPerStrip(options.pageWidthMm, options.patchSizeMm));
  return {
    chartId: options.chartId,
    kind: 'verification',
    title: options.title,
    colorants: [...options.colorants],
    patchSizeMm: options.patchSizeMm,
    pageWidthMm: options.pageWidthMm,
    strips,
    patches,
  };
}

function colorantField(index: number, count: number): string {
  return `${count}CLR_${index + 1}`;
}

function sampleName(patch: ChartPatch): string {
  return patch.channel ? `${patch.role}:${patch.channel}` : patch.role;
}

/** CGATS.17 layout file: patch ids, strips and nominal device values in percent. */
export function chartToCgats(layout: ChartLayout): string {
  const n = layout.colorants.length;
  const header: CgatsHeaderEntry[] = [
    { keyword: 'ORIGINATOR', value: 'BAX Print Suite' },
    { keyword: 'DESCRIPTOR', value: layout.title.replace(/"/g, "'") },
  ];
  const custom: Array<[string, string]> = [
    [KEYWORDS.chartId, layout.chartId],
    [KEYWORDS.kind, layout.kind],
    [KEYWORDS.colorants, layout.colorants.join(',')],
    [KEYWORDS.patchSize, formatCgatsNumber(layout.patchSizeMm, 3)],
    [KEYWORDS.pageWidth, formatCgatsNumber(layout.pageWidthMm, 3)],
  ];
  for (const [keyword, value] of custom) header.push({ keyword: 'KEYWORD', value: keyword }, { keyword, value });
  header.push({ keyword: 'KEYWORD', value: KEYWORDS.strip });
  const withReference = layout.kind === 'verification';
  const fields = [
    'SAMPLE_ID',
    'SAMPLE_NAME',
    KEYWORDS.strip,
    ...layout.colorants.map((_, i) => colorantField(i, n)),
    ...(withReference ? ['LAB_L', 'LAB_A', 'LAB_B'] : []),
  ];
  const rows = layout.patches.map((p) => [
    p.id,
    sampleName(p),
    String(p.strip),
    ...p.device.map((v) => formatCgatsNumber(v * 100, DEVICE_PERCENT_DIGITS)),
    ...(withReference && p.reference
      ? [formatCgatsNumber(p.reference.L, 4), formatCgatsNumber(p.reference.a, 4), formatCgatsNumber(p.reference.b, 4)]
      : []),
  ]);
  return serializeCgats({ identifier: 'CGATS.17', header, fields, rows });
}

function requireHeader(value: string | undefined, keyword: string): string {
  if (value === undefined || value === '') throw new CgatsParseError(`layout file has no ${keyword}`);
  return value;
}

export function chartFromCgats(text: string): ChartLayout {
  const doc = parseCgats(text);
  const kind = requireHeader(cgatsHeaderValue(doc, KEYWORDS.kind), KEYWORDS.kind);
  if (kind !== 'characterization' && kind !== 'verification') throw new CgatsParseError(`unknown chart kind ${kind}`);
  const colorants = requireHeader(cgatsHeaderValue(doc, KEYWORDS.colorants), KEYWORDS.colorants).split(',');
  const patchSizeMm = Number(requireHeader(cgatsHeaderValue(doc, KEYWORDS.patchSize), KEYWORDS.patchSize));
  const pageWidthMm = Number(requireHeader(cgatsHeaderValue(doc, KEYWORDS.pageWidth), KEYWORDS.pageWidth));
  if (!(patchSizeMm > 0) || !(pageWidthMm > 0)) throw new CgatsParseError('invalid patch size or page width');
  let strips = 0;
  const patches = cgatsRecords(doc).map((record): ChartPatch => {
    const [role = '', channel] = (record.SAMPLE_NAME ?? '').split(':');
    if (!['ramp', 'coverage', 'profile', 'verification'].includes(role)) throw new CgatsParseError(`unknown patch role ${role}`);
    const strip = cgatsNumber(record, KEYWORDS.strip);
    strips = Math.max(strips, strip);
    const patch: ChartPatch = {
      id: record.SAMPLE_ID!,
      role: role as PatchRole,
      strip,
      device: colorants.map((_, i) => cgatsNumber(record, colorantField(i, colorants.length)) / 100),
    };
    if (channel) patch.channel = channel;
    if (kind === 'verification') {
      patch.reference = { L: cgatsNumber(record, 'LAB_L'), a: cgatsNumber(record, 'LAB_A'), b: cgatsNumber(record, 'LAB_B') };
    }
    return patch;
  });
  return {
    chartId: requireHeader(cgatsHeaderValue(doc, KEYWORDS.chartId), KEYWORDS.chartId),
    kind,
    title: cgatsHeaderValue(doc, 'DESCRIPTOR') ?? '',
    colorants,
    patchSizeMm,
    pageWidthMm,
    strips,
    patches,
  };
}

/** The Measurement/1 request for a chart: one strip per chart row. */
export function measurementLayout(layout: ChartLayout, condition?: MeasurementLayout['condition']): MeasurementLayout {
  const strips = new Map<number, string[]>();
  for (const patch of layout.patches) strips.set(patch.strip, [...(strips.get(patch.strip) ?? []), patch.id]);
  const result: MeasurementLayout = {
    chartId: layout.chartId,
    patchSizeMm: layout.patchSizeMm,
    strips: [...strips.entries()].sort((a, b) => a[0] - b[0]).map(([strip, patchIds]) => ({ stripId: String(strip), patchIds })),
  };
  if (condition) result.condition = condition;
  return result;
}
