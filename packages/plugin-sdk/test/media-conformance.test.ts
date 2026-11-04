import { describe, expect, it } from 'vitest';
import {
  type BuildProfileRequest,
  type ColorEngineProfilingApi,
  type MeasurementApi,
  type OutputModeReport,
  type PrinterDriverMediaApi,
  runColorEngineProfilingConformance,
  runMeasurementConformance,
  runPrinterDriverMediaConformance,
} from '../src/index.js';

const mode = (modeKey: string, extra: Partial<OutputModeReport> = {}): OutputModeReport => ({
  modeKey,
  name: `Mode ${modeKey}`,
  resolutionDpi: { x: 600, y: 600 },
  passes: 8,
  inkSet: ['cyan', 'magenta', 'yellow', 'black'],
  direction: 'bidirectional',
  ...extra,
});

describe('PrinterDriver/1.1 media conformance', () => {
  it('passes a well-formed driver', async () => {
    const driver: PrinterDriverMediaApi = {
      listMedia: async () => [{ mediumKey: 'm1', name: 'Generic film' }],
      listModes: async () => [mode('a'), mode('b')],
    };
    expect(await runPrinterDriverMediaConformance(driver)).toEqual({ passed: true, failures: [] });
  });

  it('passes a 1.0 driver without listModes', async () => {
    const driver: PrinterDriverMediaApi = { listMedia: async () => [{ mediumKey: 'm1', name: 'Generic film' }] };
    expect((await runPrinterDriverMediaConformance(driver)).passed).toBe(true);
  });

  it('fails on unstable mode keys, bad colorants and bad pass counts', async () => {
    let call = 0;
    const driver: PrinterDriverMediaApi = {
      listMedia: async () => [{ mediumKey: 'm1', name: 'Generic film' }],
      listModes: async () => {
        call += 1;
        return [mode(`k${call}`, { inkSet: ['cyan', 'bad id'], passes: 0 })];
      },
    };
    const outcome = await runPrinterDriverMediaConformance(driver);
    expect(outcome.passed).toBe(false);
    expect(outcome.failures.some((f) => f.includes('stable'))).toBe(true);
    expect(outcome.failures.some((f) => f.includes('invalid colorant'))).toBe(true);
    expect(outcome.failures.some((f) => f.includes('passes'))).toBe(true);
  });
});

describe('Measurement/1 conformance', () => {
  const layout = { chartId: 'c1', patchSizeMm: 10, condition: 'M1' as const, strips: [{ stripId: 's1', patchIds: ['p1', 'p2'] }] };

  it('passes an instrument that returns every patch', async () => {
    const plugin: MeasurementApi = {
      listInstruments: async () => [{ id: 'i1', name: 'Test', conditions: ['M1'] }],
      measureStrip: async (l) => ({
        instrumentId: 'i1',
        condition: 'M1',
        patches: l.strips.flatMap((s) => s.patchIds).map((patchId) => ({ patchId, lab: { L: 50, a: 0, b: 0 } })),
      }),
    };
    expect((await runMeasurementConformance(plugin, layout)).passed).toBe(true);
  });

  it('fails when patches are missing or the condition is ignored', async () => {
    const plugin: MeasurementApi = {
      listInstruments: async () => [{ id: 'i1', name: 'Test', conditions: ['M0'] }],
      measureStrip: async () => ({ instrumentId: 'i1', condition: 'M0', patches: [{ patchId: 'p1', lab: { L: 50, a: 0, b: 0 } }] }),
    };
    const outcome = await runMeasurementConformance(plugin, layout);
    expect(outcome.passed).toBe(false);
    expect(outcome.failures).toContain('measureStrip(): patch p2 missing');
    expect(outcome.failures).toContain('measureStrip(): must honor the requested condition');
  });

  it('fails without instruments or with a malformed result', async () => {
    const empty: MeasurementApi = {
      listInstruments: async () => [],
      measureStrip: async () => ({ instrumentId: 'i1', condition: 'M1', patches: [] }),
    };
    expect((await runMeasurementConformance(empty, layout)).failures).toEqual([
      'listInstruments() must return at least one instrument',
    ]);

    const malformed = {
      listInstruments: async () => [{ id: 'i1', name: 'Test', conditions: ['M1'] }],
      measureStrip: async () => ({ instrumentId: 'i1', condition: 'M1' }),
    } as unknown as MeasurementApi;
    expect((await runMeasurementConformance(malformed, layout)).failures).toEqual([
      'measureStrip(): patches must be an array',
    ]);
  });

  it('fails on non-finite Lab values', async () => {
    const plugin: MeasurementApi = {
      listInstruments: async () => [{ id: 'i1', name: 'Test', conditions: ['M1'] }],
      measureStrip: async () => ({
        instrumentId: 'i1',
        condition: 'M1',
        patches: [
          { patchId: 'p1', lab: { L: 50, a: 0, b: 0 } },
          { patchId: 'p2', lab: { L: Number.NaN, a: 0, b: 0 } },
        ],
      }),
    };
    expect((await runMeasurementConformance(plugin, layout)).failures).toEqual([
      'measureStrip(): patch p2 has a non-finite Lab value',
    ]);
  });
});

describe('ColorEngine/1.1 profiling conformance', () => {
  const request: BuildProfileRequest = {
    colorants: ['cyan', 'magenta', 'yellow', 'black'],
    patches: [
      { id: 'w', device: [0, 0, 0, 0], lab: { L: 95, a: 0, b: -2 } },
      { id: 'k', device: [0, 0, 0, 1], lab: { L: 15, a: 0, b: 0 } },
    ],
    measurementCondition: 'M1',
    options: { description: 'test profile' },
  };

  const engine = (channels: number, value: number): ColorEngineProfilingApi => ({
    buildProfile: async (r) => ({
      format: 'other',
      mediaType: 'application/octet-stream',
      description: r.options.description,
      colorants: r.colorants,
      bytes: new Uint8Array([1]),
    }),
    evaluate: async (_profile, labs) => ({
      device: labs.map(() => new Array<number>(channels).fill(value)),
      outOfGamut: labs.map(() => false),
    }),
  });

  it('passes a well-formed engine', async () => {
    expect(await runColorEngineProfilingConformance(engine(4, 0.5), request)).toEqual({ passed: true, failures: [] });
  });

  it('fails on missing methods, wrong channel counts and out-of-range values', async () => {
    expect((await runColorEngineProfilingConformance({}, request)).passed).toBe(false);
    const outcome = await runColorEngineProfilingConformance(engine(3, 2), request);
    expect(outcome.failures).toContain('evaluate()[0]: wrong channel count');
    expect(outcome.failures).toContain('evaluate()[0]: values must be within 0..1');
  });
});
