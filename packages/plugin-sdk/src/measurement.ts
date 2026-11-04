import type { SdkLab, SdkMeasurementCondition } from './common.js';

/** New optional plugin interface for spectrophotometers. */
export const MEASUREMENT_INTERFACE = 'Measurement';
export const MEASUREMENT_VERSION = '1.0';

export interface InstrumentInfo {
  id: string;
  name: string;
  conditions: SdkMeasurementCondition[];
}

export interface MeasurementStrip {
  stripId: string;
  patchIds: string[];
}

export interface MeasurementLayout {
  chartId: string;
  patchSizeMm: number;
  condition?: SdkMeasurementCondition;
  strips: MeasurementStrip[];
}

export interface MeasuredPatch {
  patchId: string;
  lab: SdkLab;
}

export interface MeasureStripResult {
  instrumentId: string;
  condition: SdkMeasurementCondition;
  patches: MeasuredPatch[];
}

export interface MeasurementApi {
  listInstruments(): Promise<InstrumentInfo[]>;
  measureStrip(layout: MeasurementLayout, options?: { instrumentId?: string }): Promise<MeasureStripResult>;
}
