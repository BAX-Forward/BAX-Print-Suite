/**
 * Ground-truth model of the simulated CMYK color device.
 *
 * Pure and deterministic: CMYK percent -> per-channel TRC (dot gain) -> effective
 * coverage -> 3x4 density matrix -> CIE XYZ (relative to the paper) -> CIE Lab D50.
 *
 * The model is a simple Beer-Lambert style approximation, not a physical ink model.
 * Its constants are chosen so the solids land near typical coated-stock values,
 * which is enough for profiling round-trip tests.
 */

export interface Cmyk {
  /** Coverage in percent, 0..100. */
  c: number;
  m: number;
  y: number;
  k: number;
}

export interface Xyz {
  X: number;
  Y: number;
  Z: number;
}

/** Structurally identical to the plugin-sdk `SdkLab`. */
export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** CIE D50 reference white (Y = 1), as used by ICC profile connection space. */
export const D50_WHITE: Readonly<Xyz> = Object.freeze({ X: 0.9642, Y: 1.0, Z: 0.8251 });

/** Unprinted substrate under D50, about Lab (95, 0, -2). */
export const PAPER_WHITE_XYZ: Readonly<Xyz> = Object.freeze({ X: 0.8448, Y: 0.8762, Z: 0.7459 });

/**
 * TRC exponent per channel: effective coverage = 1 - (1 - x)^gamma for x in 0..1.
 * A gamma above 1 models dot gain, e.g. 1.5 turns a 50 % tint into about 65 %.
 */
export const DEVICE_TRC_GAMMA: Readonly<Cmyk> = Object.freeze({ c: 1.45, m: 1.5, y: 1.4, k: 1.6 });

/**
 * Optical density contributed by each channel at 100 % effective coverage.
 * Rows are X, Y, Z. Columns are C, M, Y, K. Solids land near
 * C (55, -37, -50), M (48, 74, -3), Y (89, -5, 93), K (16, 0, 0).
 */
export const DEVICE_DENSITY_MATRIX: Readonly<{
  X: readonly [number, number, number, number];
  Y: readonly [number, number, number, number];
  Z: readonly [number, number, number, number];
}> = Object.freeze({
  X: Object.freeze([0.75, 0.41, 0.09, 1.62] as const),
  Y: Object.freeze([0.58, 0.72, 0.07, 1.62] as const),
  Z: Object.freeze([0.15, 0.7, 1.03, 1.63] as const),
});

/** CIE constants for the Lab transfer function (exact rational forms). */
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

function assertPercent(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${name} must be a finite percent in 0..100, got ${String(value)}`);
  }
}

/** Applies one channel's TRC. `percent` is 0..100; the result is a fraction in 0..1. */
export function applyTrc(percent: number, gamma: number): number {
  const x = percent / 100;
  return 1 - Math.pow(1 - x, gamma);
}

/** CMYK percent to CIE XYZ (D50, Y of the reference white = 1). */
export function cmykToXyz(cmyk: Cmyk): Xyz {
  assertPercent('c', cmyk.c);
  assertPercent('m', cmyk.m);
  assertPercent('y', cmyk.y);
  assertPercent('k', cmyk.k);

  const c = applyTrc(cmyk.c, DEVICE_TRC_GAMMA.c);
  const m = applyTrc(cmyk.m, DEVICE_TRC_GAMMA.m);
  const y = applyTrc(cmyk.y, DEVICE_TRC_GAMMA.y);
  const k = applyTrc(cmyk.k, DEVICE_TRC_GAMMA.k);

  const density = (row: readonly [number, number, number, number]): number =>
    row[0] * c + row[1] * m + row[2] * y + row[3] * k;

  return {
    X: PAPER_WHITE_XYZ.X * Math.pow(10, -density(DEVICE_DENSITY_MATRIX.X)),
    Y: PAPER_WHITE_XYZ.Y * Math.pow(10, -density(DEVICE_DENSITY_MATRIX.Y)),
    Z: PAPER_WHITE_XYZ.Z * Math.pow(10, -density(DEVICE_DENSITY_MATRIX.Z)),
  };
}

function labF(t: number): number {
  return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

/** CIE XYZ to CIE Lab relative to `white` (default D50). */
export function xyzToLab(xyz: Xyz, white: Readonly<Xyz> = D50_WHITE): Lab {
  const fx = labF(xyz.X / white.X);
  const fy = labF(xyz.Y / white.Y);
  const fz = labF(xyz.Z / white.Z);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/** Noise-free device response: CMYK percent to CIE Lab D50. */
export function cmykToLab(cmyk: Cmyk): Lab {
  return xyzToLab(cmykToXyz(cmyk));
}
