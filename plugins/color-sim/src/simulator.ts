/**
 * Simulated color device: a Measurement/1.0 instrument backed by the ground-truth model.
 *
 * The SDK's PrinterDriver/1.1 media subset has no print-patch method, so the simulator
 * exposes its own `printChart`: it records which CMYK value each patch id carries. A later
 * `measureStrip` looks the patches up, runs them through the ground-truth model and adds
 * seeded noise. Same seed and same call sequence give the same readings.
 */
import type {
  InstrumentInfo,
  MeasuredPatch,
  MeasurementApi,
  MeasurementLayout,
  MeasureStripResult,
  SdkMeasurementCondition,
} from '@bax-print/plugin-sdk';
import { cmykToLab, type Cmyk } from './ground-truth.js';
import { DEFAULT_NOISE_SIGMA_DE, LabNoise } from './noise.js';

/** Id of the single simulated instrument. */
export const SIM_INSTRUMENT_ID = 'color-sim';

/** Default PRNG seed when none is configured. */
export const DEFAULT_SIM_SEED = 1;

/** Condition reported when the layout does not request one. */
export const DEFAULT_SIM_CONDITION: SdkMeasurementCondition = 'M1';

const SUPPORTED_CONDITIONS: readonly SdkMeasurementCondition[] = Object.freeze(['M0', 'M1', 'M2']);

export interface PrintedPatch {
  patchId: string;
  cmyk: Cmyk;
}

export interface ColorSimOptions {
  /** PRNG seed for measurement noise. Default `DEFAULT_SIM_SEED`. */
  seed?: number;
  /** RMS CIE76 dE of the noise. Default `DEFAULT_NOISE_SIGMA_DE` (0.3). Use 0 for ground truth. */
  sigmaDe?: number;
}

export class ColorSimulator implements MeasurementApi {
  readonly seed: number;
  readonly sigmaDe: number;
  private noise: LabNoise;
  private readonly charts: Map<string, ReadonlyMap<string, Cmyk>> = new Map();

  constructor(options: ColorSimOptions = {}) {
    this.seed = options.seed ?? DEFAULT_SIM_SEED;
    this.sigmaDe = options.sigmaDe ?? DEFAULT_NOISE_SIGMA_DE;
    this.noise = new LabNoise(this.seed, this.sigmaDe);
  }

  /** Restarts the noise stream from the configured seed. Printed charts are kept. */
  reset(): void {
    this.noise = new LabNoise(this.seed, this.sigmaDe);
  }

  /**
   * Simulates printing a chart. Replaces any chart previously printed under `chartId`.
   * Throws on an empty chart id, a duplicate patch id or an out-of-range CMYK value.
   */
  printChart(chartId: string, patches: readonly PrintedPatch[]): void {
    if (chartId.length === 0) {
      throw new RangeError('chartId must not be empty');
    }
    const byId = new Map<string, Cmyk>();
    for (const patch of patches) {
      if (byId.has(patch.patchId)) {
        throw new RangeError(`duplicate patch id ${patch.patchId} in chart ${chartId}`);
      }
      // Validate now so a bad value fails at print time, not at measurement time.
      cmykToLab(patch.cmyk);
      byId.set(patch.patchId, { ...patch.cmyk });
    }
    this.charts.set(chartId, byId);
  }

  listInstruments(): Promise<InstrumentInfo[]> {
    return Promise.resolve([
      { id: SIM_INSTRUMENT_ID, name: 'Simulated spectrophotometer', conditions: [...SUPPORTED_CONDITIONS] },
    ]);
  }

  measureStrip(layout: MeasurementLayout, options?: { instrumentId?: string }): Promise<MeasureStripResult> {
    try {
      return Promise.resolve(this.measureStripSync(layout, options?.instrumentId));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private measureStripSync(layout: MeasurementLayout, instrumentId: string | undefined): MeasureStripResult {
    if (instrumentId !== undefined && instrumentId !== SIM_INSTRUMENT_ID) {
      throw new RangeError(`unknown instrument ${instrumentId}`);
    }
    const condition = layout.condition ?? DEFAULT_SIM_CONDITION;
    if (!SUPPORTED_CONDITIONS.includes(condition)) {
      throw new RangeError(`unsupported measurement condition ${String(condition)}`);
    }
    const chart = this.charts.get(layout.chartId);
    if (chart === undefined) {
      throw new RangeError(`chart ${layout.chartId} has not been printed`);
    }

    // Resolve every patch before drawing noise, so a failed call leaves the stream untouched.
    const targets: PrintedPatch[] = [];
    for (const strip of layout.strips) {
      for (const patchId of strip.patchIds) {
        const cmyk = chart.get(patchId);
        if (cmyk === undefined) {
          throw new RangeError(`patch ${patchId} (strip ${strip.stripId}) is not in chart ${layout.chartId}`);
        }
        targets.push({ patchId, cmyk });
      }
    }

    const patches: MeasuredPatch[] = targets.map(({ patchId, cmyk }) => ({
      patchId,
      lab: this.noise.apply(cmykToLab(cmyk)),
    }));
    return { instrumentId: SIM_INSTRUMENT_ID, condition, patches };
  }
}
