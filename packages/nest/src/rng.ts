export type Rng = () => number;

const FALLBACK_SEED = 0x9e3779b9;

/** Seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function createRng(seed: number): Rng {
  let state = (Math.floor(Number.isFinite(seed) ? seed : 0) >>> 0) || FALLBACK_SEED;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
