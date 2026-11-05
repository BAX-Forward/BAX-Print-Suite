/**
 * Spec 005 Testing item 2: a full profiling session against the simulated measurement device.
 * The color-sim plugin prints and measures charts over BPP; ProfilingService drives every step;
 * the verification report must meet the tolerances recorded in thresholds.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Lab } from '@bax-print/core';
import type { ColorEngineProfilingApi, MeasurementApi } from '@bax-print/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deltaE2000 } from '../src/color/deltae.js';
import type { VerificationReport } from '../src/profiling/analysis.js';
import { type ChartFiles, ProfilingService } from '../src/profiling/service.js';
import { DEFAULT_MAX_VERIFICATION_PATCHES, accuracyReport, splitHoldOut, syncFromDevice } from '../src/index.js';
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
/** Every Nth measured profile patch is withheld from the profile build and verified instead. */
const HOLD_OUT_EVERY_NTH = 4;

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

interface HoldOut {
  engine: ColorEngineProfilingApi;
  /** Held-out profile patches captured at build time (at most DEFAULT_MAX_VERIFICATION_PATCHES). */
  patches: () => ProfilePatch[];
}

/**
 * Wraps an engine so its profile is built without every Nth measured profile patch; the first
 * held-out patches (up to the verification chart limit) become the verification references.
 */
function holdingOut(engine: ColorEngineProfilingApi): HoldOut {
  let heldOut: ProfilePatch[] = [];
  return {
    engine: {
      buildProfile: async (request) => {
        if (engine.buildProfile === undefined) throw new Error('the color engine cannot build profiles');
        const split = splitHoldOut(
          request.patches.map((p) => p.id),
          HOLD_OUT_EVERY_NTH,
        );
        const build = new Set(split.build);
        const verified = new Set(split.heldOut.slice(0, DEFAULT_MAX_VERIFICATION_PATCHES));
        heldOut = request.patches.filter((p) => verified.has(p.id));
        return engine.buildProfile({ ...request, patches: request.patches.filter((p) => build.has(p.id)) });
      },
      evaluate: async (profile, labs, options) => {
        if (engine.evaluate === undefined) throw new Error('the color engine cannot evaluate profiles');
        return engine.evaluate(profile, labs, options);
      },
    },
    patches: () => heldOut,
  };
}

/** Print chart, measure strip, build profile, print and measure the verification chart. */
async function runSession(
  harness: ColorSimHarness,
  colorEngine: ColorEngineProfilingApi,
  references?: () => Lab[],
): Promise<VerificationReport> {
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
  const verification = await service.createVerificationTarget(
    session.id,
    references === undefined ? { author: AUTHOR } : { author: AUTHOR, references: references() },
  );
  await harness.printChart(verification.layout.chartId, printedPatches(verification.layout));
  const report = await service.verify(session.id, { kind: 'instrument' }, AUTHOR);
  expect(service.getVerificationReport(session.id)).toEqual(report);
  return report;
}

function summarize(report: VerificationReport): { mean: number; max: number } {
  const des = report.patches.map((p) => deltaE2000(p.reference, p.measured));
  return { mean: des.reduce((s, v) => s + v, 0) / des.length, max: Math.max(...des) };
}

interface HeldOutRun {
  /** Held-out profile patches with their characterization measurement. */
  heldOut: ProfilePatch[];
  /** Held-out patch id → Lab measured on the verification chart that reproduced it. */
  reproduced: Map<string, Lab>;
}

/** A session whose verification chart reproduces the patches held out of the profile build. */
async function runHeldOutSession(harness: ColorSimHarness, colorEngine: ColorEngineProfilingApi): Promise<HeldOutRun> {
  const holdOut = holdingOut(colorEngine);
  const report = await runSession(harness, holdOut.engine, () => holdOut.patches().map((p) => ({ ...p.lab })));
  const heldOut = holdOut.patches();
  if (report.patches.length !== heldOut.length) throw new Error('the verification chart does not match the held-out patches');
  // The verification chart keeps the reference order, so patch i reproduces held-out patch i.
  const reproduced = new Map<string, Lab>();
  heldOut.forEach((patch, i) => {
    const result = report.patches[i];
    if (result === undefined) throw new Error(`no verification patch for held-out patch ${patch.id}`);
    reproduced.set(patch.id, result.measured);
  });
  return { heldOut, reproduced };
}

/**
 * Accuracy report of the lookup engine and an external engine on the same held-out patches:
 * the characterization measurement of each held-out patch against the Lab measured where the
 * engine reproduced it on the verification chart.
 */
async function heldOutAccuracy(harness: ColorSimHarness, external: ColorEngineProfilingApi) {
  const lookup = await runHeldOutSession(harness, lookupEngine());
  const other = await runHeldOutSession(harness, external);
  const ids = lookup.heldOut.map((p) => p.id);
  if (ids.join('\n') !== other.heldOut.map((p) => p.id).join('\n')) {
    throw new Error('the two sessions held out different patches');
  }
  return accuracyReport({
    engines: [
      { name: 'lookup', predicted: lookup.reproduced },
      { name: 'external', predicted: other.reproduced },
    ],
    measured: new Map(lookup.heldOut.map((p) => [p.id, p.lab])),
    heldOut: ids,
  });
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
      // Report only: the accuracy numbers are written out, never asserted.
      const accuracy = await heldOutAccuracy(harness, module.colorEngine);
      const path = join(tmpdir(), `bps-profiler-accuracy-${process.pid}.json`);
      writeFileSync(path, `${JSON.stringify(accuracy, null, 2)}\n`);
      console.info(`profiler accuracy report (${accuracy.schema}): ${path}`);
    },
    // The plain session plus one held-out session per engine.
    3 * SESSION_TIMEOUT_MS,
  );
});
