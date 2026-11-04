/** CIELAB, D50 / 2° observer (ICC PCS). */
export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** ISO 13655 measurement conditions handled by the profiling workflow. */
export const MEASUREMENT_CONDITIONS = ['M0', 'M1', 'M2'] as const;
export type MeasurementCondition = (typeof MEASUREMENT_CONDITIONS)[number];

export function isMeasurementCondition(value: unknown): value is MeasurementCondition {
  return typeof value === 'string' && (MEASUREMENT_CONDITIONS as readonly string[]).includes(value);
}

/** ICC.1 rendering intents. */
export const RENDERING_INTENTS = [
  'perceptual',
  'relative-colorimetric',
  'saturation',
  'absolute-colorimetric',
] as const;
export type RenderingIntent = (typeof RENDERING_INTENTS)[number];

export function isRenderingIntent(value: unknown): value is RenderingIntent {
  return typeof value === 'string' && (RENDERING_INTENTS as readonly string[]).includes(value);
}

/** Where a profile came from and whether we may ship it to another machine (ARCHITECTURE §4). */
export interface ProfileProvenance {
  source: string;
  license: string;
  redistributable: boolean;
}

/** `icc` for ICC.1 profiles; `other` for engine-specific characterization data. */
export type ProfileFormat = 'icc' | 'other';

/**
 * A reference to profile bytes held in the media library store, addressed by content hash.
 * The archive's reprint view ({@link ProfileRef}) is derived from it.
 */
export interface StoredProfileRef {
  sha256: string;
  description: string;
  format: ProfileFormat;
  mediaType: string;
  colorants: string[];
  provenance: ProfileProvenance;
}

export interface ProfileRecord extends StoredProfileRef {
  sizeBytes: number;
  createdAt: string;
}
