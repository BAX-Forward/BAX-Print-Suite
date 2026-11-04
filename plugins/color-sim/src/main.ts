#!/usr/bin/env node
/**
 * Process entry point: serves the simulated color device (Measurement/1) over BPP on stdin/stdout.
 *
 * The SDK defines the Measurement/1 API (`listInstruments`, `measureStrip`) but no wire method
 * names or register helper, so this plugin defines them in `ColorSimMethods`. `colorSim/printChart`
 * is plugin-private: it tells the simulator which CMYK value each patch id carries before the
 * host measures the chart. `configure` accepts `{ seed?, sigmaDe? }` and starts a fresh simulator,
 * which drops any printed charts.
 */
import {
  createStderrLogger,
  ErrorCodes,
  INTERFACE_VERSIONS,
  PluginServer,
  RpcError,
  type MeasurementLayout,
  type MeasurementStrip,
  type SdkMeasurementCondition,
} from '@bax-print/plugin-sdk';
import { ColorSimulator, type ColorSimOptions, type PrintedPatch } from './simulator.js';

export const ColorSimMethods = Object.freeze({
  listInstruments: 'measurement/listInstruments',
  measureStrip: 'measurement/measureStrip',
  printChart: 'colorSim/printChart',
});

const CONDITIONS: readonly string[] = ['M0', 'M1', 'M2'];

function invalid(message: string): RpcError {
  return new RpcError(ErrorCodes.InvalidParams, message);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${what} must be a non-empty string`);
  }
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${what} must be a finite number`);
  }
  return value;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(`${what} must be an array`);
  }
  return value;
}

function parseOptions(settings: Record<string, unknown>): ColorSimOptions {
  return {
    ...(settings.seed === undefined ? {} : { seed: asNumber(settings.seed, 'seed') }),
    ...(settings.sigmaDe === undefined ? {} : { sigmaDe: asNumber(settings.sigmaDe, 'sigmaDe') }),
  };
}

function parseStrip(value: unknown, index: number): MeasurementStrip {
  const strip = asObject(value, `layout.strips[${index}]`);
  return {
    stripId: asString(strip.stripId, `layout.strips[${index}].stripId`),
    patchIds: asArray(strip.patchIds, `layout.strips[${index}].patchIds`).map((id, j) =>
      asString(id, `layout.strips[${index}].patchIds[${j}]`),
    ),
  };
}

function parseLayout(value: unknown): MeasurementLayout {
  const layout = asObject(value, 'layout');
  const condition = layout.condition;
  if (condition !== undefined && (typeof condition !== 'string' || !CONDITIONS.includes(condition))) {
    throw invalid(`layout.condition must be one of ${CONDITIONS.join(', ')}`);
  }
  return {
    chartId: asString(layout.chartId, 'layout.chartId'),
    patchSizeMm: asNumber(layout.patchSizeMm, 'layout.patchSizeMm'),
    ...(condition === undefined ? {} : { condition: condition as SdkMeasurementCondition }),
    strips: asArray(layout.strips, 'layout.strips').map(parseStrip),
  };
}

function parsePatch(value: unknown, index: number): PrintedPatch {
  const patch = asObject(value, `patches[${index}]`);
  const cmyk = asObject(patch.cmyk, `patches[${index}].cmyk`);
  return {
    patchId: asString(patch.patchId, `patches[${index}].patchId`),
    cmyk: {
      c: asNumber(cmyk.c, `patches[${index}].cmyk.c`),
      m: asNumber(cmyk.m, `patches[${index}].cmyk.m`),
      y: asNumber(cmyk.y, `patches[${index}].cmyk.y`),
      k: asNumber(cmyk.k, `patches[${index}].cmyk.k`),
    },
  };
}

/** Simulator rejections (unknown chart, patch or instrument, out-of-range CMYK) are caller errors. */
async function asCallerError<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

let simulator: ColorSimulator = new ColorSimulator();

const server: PluginServer = new PluginServer({
  plugin: { id: 'org.bax-print.color.sim', name: 'Simulated Color Device', version: '0.1.0' },
  offers: [{ interface: 'Measurement', version: INTERFACE_VERSIONS.Measurement }],
  log: createStderrLogger('color-sim'),
  onConfigure: (settings): void => {
    simulator = new ColorSimulator(parseOptions(settings));
  },
  // Flush the final response before exiting.
  onExit: (code) => {
    process.stdout.write('', () => process.exit(code));
  },
});

server.onRequest(ColorSimMethods.listInstruments, () => simulator.listInstruments());

server.onRequest(ColorSimMethods.measureStrip, (params) => {
  const checked = asObject(params, 'params');
  const layout = parseLayout(checked.layout);
  const options = checked.options === undefined ? {} : asObject(checked.options, 'options');
  const instrumentId =
    options.instrumentId === undefined ? undefined : asString(options.instrumentId, 'options.instrumentId');
  return asCallerError(() =>
    simulator.measureStrip(layout, instrumentId === undefined ? {} : { instrumentId }),
  );
});

server.onRequest(ColorSimMethods.printChart, (params) => {
  const checked = asObject(params, 'params');
  const chartId = asString(checked.chartId, 'chartId');
  const patches = asArray(checked.patches, 'patches').map(parsePatch);
  return asCallerError(() => {
    simulator.printChart(chartId, patches);
    return null;
  });
});
