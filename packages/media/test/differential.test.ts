/**
 * Spec 005 Testing item 2: a full profiling session against the simulated measurement device.
 * The color-sim plugin prints and measures charts over BPP; ProfilingService drives every step;
 * the verification report must meet the tolerances recorded in thresholds.json.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Lab } from '@bax-print/core';
import type { ColorEngineProfilingApi, MeasurementApi } from '@bax-print/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deltaE2000 } from '../src/color/deltae.js';
import type { VerificationReport } from '../src/profiling/analysis.js';
import { type ChartFiles, ProfilingService } from '../src/profiling/service.js';
import { syncFromDevice } from '../src/index.js';
import { ColorSimHarness, type Cmyk, type PrintedPatch } from './color-sim-harness.js';
import { fixtureDriver, modeReport, testLibrary } from './helpers.js';

type ChartLayout = ChartFiles['layout'];
type InstrumentInfo = Awaited<ReturnType<MeasurementApi['listInstruments']>>[number];
type MeasureStripResult = Awaited<ReturnType<MeasurementApi['measureStrip']>>;
type ProfilePatch = Parameters<NonNullable<ColorEngineProfilingApi['buildProfile']>>[0]['patches'][number];

interface Thresholds {
  meanDe2000: number;
  maxDe2000: number;
}

const THRESHOLDS = JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8')) as Thresholds;
const SEED = 42;
const AUTHOR = 'differential-test';
const DEVICE = 'generic-device';
const STARTUP_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 60_000;
/** Decimal places of ΔE2000 values in a verification report. */
const REPORT_DIGITS = 4;
/** An ES module exporting `colorEngine: ColorEngineProfilingApi`; set only where one is installed. */
const EXTERNAL_PROFILER = process.env.BPS_EXTERNAL_PROFILER;

/** Ink-set colorant → simulator channel; the fixture mode prints cyan, magenta, yellow, black. */
const CHANNELS: Readonly<Record<string, keyof Cmyk>> = { cyan: 'c', magenta: 'm', yellow: 'y', black: 'k' };
const LOOKUP_MEDIA_TYPE = 'application/json';

/** Chart device values (0..1 per colorant) as the simulator's CMYK percentages. */
function printedPatches(layout: ChartLayout): PrintedPatch[] {
  return layout.patches.map((patch) => {
    const cmyk: Cmyk = { c: 0, m: 0, y: 0, k: 0 };
    layout.colorants.forEach((colorant, i) => {
      const channel = CHANNELS[colorant];
      if (channel === undefined) throw new Error(`the simulator cannot print colorant ${colorant}`);
      cmyk[channel] = (patch.device[i] ?? 0) * 100;
    });
    return { patchId: patch.id, cmyk };
  });
}

function measurementDevice(harness: ColorSimHarness): MeasurementApi {
  return {
    listInstruments: () => harness.listInstruments<InstrumentInfo[]>(),
    measureStrip: (layout, options) => harness.measureStrip<MeasureStripResult>(layout, options ?? {}),
  };
}

/**
 * Test-only reference engine: the "profile" is the measured characterization table, and
 * evaluation returns the device values of the nearest measured patch (by ΔE2000). It isolates
 * the workflow (charts, measurement, curves, verification) from profile-fitting quality.
 */
function lookupEngine(): ColorEngineProfilingApi {
  return {
    buildProfile: async (request) => ({
      format: 'other',
      mediaType: LOOKUP_MEDIA_TYPE,
      description: request.options.description,
      colorants: [...request.colorants],
      bytes: new TextEncoder().encode(JSON.stringify(request.patches)),
    }),
    evaluate: async (profile, labs) => {
      const table = JSON.parse(new TextDecoder().decode(profile.bytes)) as ProfilePatch[];
      if (table.length === 0) throw new Error('the lookup profile has no patches');
      const device = labs.map((lab) => nearest(table, lab).device);
      return { device, outOfGamut: labs.map(() => false) };
    },
  };
}

function nearest(table: readonly ProfilePatch[], lab: Lab): ProfilePatch {
  let best = table[0]!;
  let bestDe = deltaE2000(lab, best.lab);
  for (const patch of table) {
    const de = deltaE2000(lab, patch.lab);
    if (de < bestDe) {
      best = patch;
      bestDe = de;
    }
  }
  return best;
}

/** Print chart, measure strip, build profile, print and measure the verification chart. */
async function runSession(harness: ColorSimHarness, colorEngine: ColorEngineProfilingApi): Promise<VerificationReport> {
  await harness.configure({ seed: SEED });
  const { library } = testLibrary();
  await syncFromDevice(library, DEVICE, fixtureDriver(() => [modeReport('a')]));
  const medium = library.listMedia()[0]!;
  const mode = library.listModes(medium.id)[0]!;
  const service = new ProfilingService(library, { colorEngine, measurement: measurementDevice(harness) });

  const session = service.createSession({ outputModeId: mode.id, level: 'L1', author: AUTHOR });
  const target = service.generateTarget(session.id, AUTHOR);
  await harness.printChart(target.layout.chartId, printedPatches(target.layout));
  service.markTargetPrinted(session.id, AUTHOR);
  await service.recordMeasurements(session.id, { kind: 'instrument' }, AUTHOR);
  await service.compute(session.id, { author: AUTHOR });
  const verification = await service.createVerificationTarget(session.id, { author: AUTHOR });
  await harness.printChart(verification.layout.chartId, printedPatches(verification.layout));
  const report = await service.verify(session.id, { kind: 'instrument' }, AUTHOR);
  expect(service.getVerificationReport(session.id)).toEqual(report);
  return report;
}

function summarize(report: VerificationReport): { mean: number; max: number } {
  const des = report.patches.map((p) => deltaE2000(p.reference, p.measured));
  return { mean: des.reduce((s, v) => s + v, 0) / des.length, max: Math.max(...des) };
}

describe('differential: profiling session against the simulated device', () => {
  let harness: ColorSimHarness;

  beforeAll(async () => {
    harness = await ColorSimHarness.start();
  }, STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
  });

  it(
    'verifies within the recorded ΔE2000 thresholds',
    async () => {
      const report = await runSession(harness, lookupEngine());
      expect(report.patches.length).toBeGreaterThan(0);
      // The report stores per-patch ΔE2000 rounded to REPORT_DIGITS decimals.
      for (const patch of report.patches) {
        expect(patch.deltaE2000).toBeCloseTo(deltaE2000(patch.reference, patch.measured), REPORT_DIGITS);
      }
      const { mean, max } = summarize(report);
      expect(report.summary.mean).toBeCloseTo(mean, REPORT_DIGITS);
      expect(mean).toBeLessThanOrEqual(THRESHOLDS.meanDe2000);
      expect(max).toBeLessThanOrEqual(THRESHOLDS.maxDe2000);
    },
    SESSION_TIMEOUT_MS,
  );

  it.skipIf(EXTERNAL_PROFILER === undefined)(
    'reports an external profiler on the same session (report only)',
    async () => {
      const module = (await import(pathToFileURL(EXTERNAL_PROFILER ?? '').href)) as { colorEngine?: ColorEngineProfilingApi };
      if (!module.colorEngine) throw new Error('BPS_EXTERNAL_PROFILER must export colorEngine');
      const { mean, max } = summarize(await runSession(harness, module.colorEngine));
      console.info(
        `external profiler: mean ΔE2000 ${mean.toFixed(2)} (threshold ${THRESHOLDS.meanDe2000}), ` +
          `max ${max.toFixed(2)} (threshold ${THRESHOLDS.maxDe2000})`,
      );
    },
    SESSION_TIMEOUT_MS,
  );
});
