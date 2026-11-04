import type { Lab } from '@bax-print/core';

/** ICC PCS white (D50), ICC.1 §6.3. */
export const D50_WHITE = Object.freeze({ X: 0.9642, Y: 1.0, Z: 0.8249 });

const EPSILON = (6 / 29) ** 3;
const KAPPA_INV = 1 / (3 * (6 / 29) ** 2);

function f(t: number): number {
  return t > EPSILON ? Math.cbrt(t) : t * KAPPA_INV + 4 / 29;
}

/** CIE XYZ (Y of the white = 1) to CIELAB relative to D50. */
export function xyzToLab(xyz: { X: number; Y: number; Z: number }): Lab {
  const fx = f(xyz.X / D50_WHITE.X);
  const fy = f(xyz.Y / D50_WHITE.Y);
  const fz = f(xyz.Z / D50_WHITE.Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function deltaE76(x: Lab, y: Lab): number {
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
}

export function meanLab(values: readonly Lab[]): Lab {
  if (values.length === 0) throw new RangeError('meanLab: no values');
  const sum = values.reduce((acc, v) => ({ L: acc.L + v.L, a: acc.a + v.a, b: acc.b + v.b }), { L: 0, a: 0, b: 0 });
  return { L: sum.L / values.length, a: sum.a / values.length, b: sum.b / values.length };
}
