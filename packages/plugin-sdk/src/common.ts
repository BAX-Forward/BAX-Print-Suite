/** CIELAB, D50 / 2° observer. Declared here so the SDK has no imports from other packages. */
export interface SdkLab {
  L: number;
  a: number;
  b: number;
}

/** ISO 13655 measurement conditions. */
export type SdkMeasurementCondition = 'M0' | 'M1' | 'M2';

export type SdkRenderingIntent =
  | 'perceptual'
  | 'relative-colorimetric'
  | 'saturation'
  | 'absolute-colorimetric';
