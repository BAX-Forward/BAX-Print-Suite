/**
 * Deterministic measurement noise for the simulated device.
 *
 * A mulberry32 PRNG feeds a Box-Muller Gaussian. The same seed always gives
 * the same sequence of Lab offsets.
 */
import type { Lab } from './ground-truth.js';

/** Default noise magnitude: RMS color difference (CIE76 dE) per measurement. */
export const DEFAULT_NOISE_SIGMA_DE = 0.3;

/** mulberry32: small 32-bit seeded PRNG. Returns a generator of floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded Gaussian Lab noise. `sigmaDe` is the RMS CIE76 dE of the offset, so each
 * of L, a, b gets an independent zero-mean normal with std `sigmaDe / sqrt(3)`.
 */
export class LabNoise {
  readonly sigmaDe: number;
  private readonly random: () => number;
  private spare: number | undefined;

  constructor(seed: number, sigmaDe: number = DEFAULT_NOISE_SIGMA_DE) {
    if (!Number.isFinite(seed)) {
      throw new RangeError(`seed must be a finite number, got ${String(seed)}`);
    }
    if (!Number.isFinite(sigmaDe) || sigmaDe < 0) {
      throw new RangeError(`sigmaDe must be a finite number >= 0, got ${String(sigmaDe)}`);
    }
    this.sigmaDe = sigmaDe;
    this.random = mulberry32(seed);
    this.spare = undefined;
  }

  /** Next standard normal sample (mean 0, std 1). */
  private nextGaussian(): number {
    if (this.spare !== undefined) {
      const value = this.spare;
      this.spare = undefined;
      return value;
    }
    // 1 - u keeps the log argument in (0, 1].
    const u1 = 1 - this.random();
    const u2 = this.random();
    const radius = Math.sqrt(-2 * Math.log(u1));
    const angle = 2 * Math.PI * u2;
    this.spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }

  /** Next Lab offset. */
  nextOffset(): Lab {
    const axisSigma = this.sigmaDe / Math.sqrt(3);
    return {
      L: this.nextGaussian() * axisSigma,
      a: this.nextGaussian() * axisSigma,
      b: this.nextGaussian() * axisSigma,
    };
  }

  /** Returns a new Lab equal to `lab` plus the next offset. Does not mutate `lab`. */
  apply(lab: Lab): Lab {
    const offset = this.nextOffset();
    return { L: lab.L + offset.L, a: lab.a + offset.a, b: lab.b + offset.b };
  }
}
