import type { SdkLab, SdkMeasurementCondition, SdkRenderingIntent } from './common.js';

/** ColorEngine/1.1 adds the optional `buildProfile` and `evaluate`. */
export const COLOR_ENGINE_INTERFACE = 'ColorEngine';
export const COLOR_ENGINE_PROFILING_VERSION = '1.1';

export interface ProfilePatch {
  id: string;
  /** Device values 0..1 per colorant, in the (linearized) device space the profile describes. */
  device: number[];
  lab: SdkLab;
}

export interface BuildProfileRequest {
  colorants: string[];
  patches: ProfilePatch[];
  measurementCondition: SdkMeasurementCondition;
  options: {
    description: string;
    renderingIntent?: SdkRenderingIntent;
    tacLimitPercent?: number;
  };
}

/**
 * Profile bytes. `format: "icc"` for ICC.1 profiles; engines may return `other` with their own
 * media type for characterization data that only they evaluate. On the BPP wire, bytes are base64.
 */
export interface ProfileData {
  format: 'icc' | 'other';
  mediaType: string;
  description: string;
  colorants: string[];
  bytes: Uint8Array;
}

export interface EvaluateOptions {
  intent?: SdkRenderingIntent;
}

export interface EvaluateResult {
  /** One device vector (0..1 per colorant) per input Lab value. */
  device: number[][];
  /** True where the Lab value is outside the profile's gamut. */
  outOfGamut: boolean[];
}

/** The profiling subset of ColorEngine/1.1. */
export interface ColorEngineProfilingApi {
  buildProfile?(request: BuildProfileRequest): Promise<ProfileData>;
  /** Lab (PCS) → device values through the profile. */
  evaluate?(profile: ProfileData, lab: SdkLab[], options?: EvaluateOptions): Promise<EvaluateResult>;
}
