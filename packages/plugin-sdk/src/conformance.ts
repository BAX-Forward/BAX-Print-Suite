import type { SdkLab } from './common.js';
import type { BuildProfileRequest, ColorEngineProfilingApi } from './color-engine.js';
import type { MeasurementApi, MeasurementLayout } from './measurement.js';
import type { OutputModeReport, PrinterDriverMediaApi } from './printer-driver.js';

export interface ConformanceResult {
  passed: boolean;
  failures: string[];
}

const COLORANT_ID = /^[A-Za-z0-9_-]+$/;
const CONDITIONS = ['M0', 'M1', 'M2'];

function result(failures: string[]): ConformanceResult {
  return { passed: failures.length === 0, failures };
}

function isFiniteLab(lab: SdkLab | undefined): boolean {
  return lab !== undefined && [lab.L, lab.a, lab.b].every((v) => typeof v === 'number' && Number.isFinite(v));
}

export function checkOutputModeReport(mode: OutputModeReport, where: string): string[] {
  const failures: string[] = [];
  if (typeof mode.modeKey !== 'string' || mode.modeKey.length === 0) failures.push(`${where}: modeKey must be a non-empty string`);
  if (typeof mode.name !== 'string' || mode.name.length === 0) failures.push(`${where}: name must be a non-empty string`);
  const dpi = mode.resolutionDpi;
  if (!dpi || !(dpi.x > 0) || !(dpi.y > 0)) failures.push(`${where}: resolutionDpi.x and .y must be positive`);
  if (!Number.isInteger(mode.passes) || mode.passes < 1) failures.push(`${where}: passes must be an integer >= 1`);
  if (!Array.isArray(mode.inkSet) || mode.inkSet.length === 0) {
    failures.push(`${where}: inkSet must be a non-empty array`);
  } else {
    for (const colorant of mode.inkSet) {
      if (typeof colorant !== 'string' || !COLORANT_ID.test(colorant)) failures.push(`${where}: invalid colorant id ${String(colorant)}`);
    }
    if (new Set(mode.inkSet).size !== mode.inkSet.length) failures.push(`${where}: inkSet has duplicate colorants`);
  }
  if (mode.direction !== 'unidirectional' && mode.direction !== 'bidirectional') failures.push(`${where}: invalid direction`);
  return failures;
}

/** PrinterDriver/1.1 media conformance: well-formed reports and stable mode keys. */
export async function runPrinterDriverMediaConformance(driver: PrinterDriverMediaApi): Promise<ConformanceResult> {
  const failures: string[] = [];
  const media = await driver.listMedia();
  if (!Array.isArray(media)) return result(['listMedia() must return an array']);
  const keys = media.map((m) => m.mediumKey);
  if (keys.some((k) => typeof k !== 'string' || k.length === 0)) failures.push('listMedia(): every mediumKey must be a non-empty string');
  if (new Set(keys).size !== keys.length) failures.push('listMedia(): mediumKey values must be unique');

  if (!driver.listModes) return result(failures);
  for (const medium of media) {
    const first = await driver.listModes(medium.mediumKey);
    const second = await driver.listModes(medium.mediumKey);
    if (!Array.isArray(first)) {
      failures.push(`listModes(${medium.mediumKey}) must return an array`);
      continue;
    }
    first.forEach((mode, i) => failures.push(...checkOutputModeReport(mode, `listModes(${medium.mediumKey})[${i}]`)));
    const firstKeys = first.map((m) => m.modeKey);
    if (new Set(firstKeys).size !== firstKeys.length) failures.push(`listModes(${medium.mediumKey}): modeKey values must be unique`);
    const secondKeys = second.map((m) => m.modeKey);
    if (JSON.stringify([...firstKeys].sort()) !== JSON.stringify([...secondKeys].sort())) {
      failures.push(`listModes(${medium.mediumKey}): modeKey values must be stable across calls`);
    }
  }
  return result(failures);
}

/** Measurement/1 conformance: instruments are declared and every requested patch is returned. */
export async function runMeasurementConformance(
  plugin: MeasurementApi,
  layout: MeasurementLayout,
): Promise<ConformanceResult> {
  const failures: string[] = [];
  const instruments = await plugin.listInstruments();
  if (!Array.isArray(instruments) || instruments.length === 0) return result(['listInstruments() must return at least one instrument']);
  for (const instrument of instruments) {
    if (!instrument.id) failures.push('listInstruments(): every instrument needs an id');
    if (!Array.isArray(instrument.conditions) || instrument.conditions.some((c) => !CONDITIONS.includes(c))) {
      failures.push(`instrument ${instrument.id}: conditions must be M0, M1 or M2`);
    }
  }
  const instrument = instruments[0];
  if (!instrument) return result(['listInstruments() must return at least one instrument']);
  const measured = await plugin.measureStrip(layout, { instrumentId: instrument.id });
  if (!measured || !Array.isArray(measured.patches)) return result([...failures, 'measureStrip(): patches must be an array']);
  if (!CONDITIONS.includes(measured.condition)) failures.push('measureStrip(): condition must be M0, M1 or M2');
  if (layout.condition && measured.condition !== layout.condition) failures.push('measureStrip(): must honor the requested condition');
  const requested = layout.strips.flatMap((s) => s.patchIds);
  const byId = new Map(measured.patches.map((p) => [p.patchId, p]));
  for (const id of requested) {
    if (!byId.has(id)) failures.push(`measureStrip(): patch ${id} missing`);
    else if (!isFiniteLab(byId.get(id)?.lab)) failures.push(`measureStrip(): patch ${id} has a non-finite Lab value`);
  }
  return result(failures);
}

/** ColorEngine/1.1 profiling conformance against a caller-supplied characterization data set. */
export async function runColorEngineProfilingConformance(
  engine: ColorEngineProfilingApi,
  request: BuildProfileRequest,
): Promise<ConformanceResult> {
  if (!engine.buildProfile || !engine.evaluate) return result(['buildProfile and evaluate must both be implemented']);
  const failures: string[] = [];
  const profile = await engine.buildProfile(request);
  if (!(profile.bytes instanceof Uint8Array) || profile.bytes.length === 0) failures.push('buildProfile(): bytes must be non-empty');
  if (profile.format !== 'icc' && profile.format !== 'other') failures.push('buildProfile(): format must be icc or other');
  if (JSON.stringify(profile.colorants) !== JSON.stringify(request.colorants)) failures.push('buildProfile(): colorants must match the request');

  const labs = request.patches.slice(0, 8).map((p) => p.lab);
  const evaluated = await engine.evaluate(profile, labs);
  if (evaluated.device.length !== labs.length || evaluated.outOfGamut.length !== labs.length) {
    failures.push('evaluate(): must return one result per input');
  }
  for (const [i, device] of evaluated.device.entries()) {
    if (device.length !== request.colorants.length) failures.push(`evaluate()[${i}]: wrong channel count`);
    if (device.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) failures.push(`evaluate()[${i}]: values must be within 0..1`);
  }
  return result(failures);
}
