/** Largest threshold array side length accepted anywhere (spec 039a). */
export const MAX_THRESHOLD_ARRAY_SIZE = 256;
/** Upper bound on `width * height` for `applyThresholdScreen`, checked before any allocation. */
export const MAX_SCREEN_PIXELS = 100_000_000;
export const BAYER_SIZES = [2, 4, 8, 16] as const;
/** Gaussian sigma of the void-and-cluster energy filter, in pixels. */
export const BLUE_NOISE_SIGMA = 1.5;
/** The energy kernel is truncated to a disc of this radius, so each update touches a fixed number of pixels. */
export const BLUE_NOISE_KERNEL_RADIUS = 5;
const MAX_SEED = 0xffff_ffff;
/** Kernel weights are scaled to integers so energies are exact and ties break the same way everywhere. */
const KERNEL_SCALE = 65_536;
/** Share of the pixels set in the random starting pattern. */
const INITIAL_MINORITY_DIVISOR = 10;
/** Tree values for leaves outside the set being searched. */
const ONE_EMPTY = -1;
const ZERO_EMPTY = 0x7fff_ffff;
const BAYER_QUADRANT_OFFSETS = [0, 2, 3, 1] as const;

export type BayerSize = (typeof BAYER_SIZES)[number];

export interface ThresholdArray {
  /** Side length; the array covers `size x size` pixels and tiles the plane. */
  size: number;
  /** Row-major thresholds, a permutation of 0..size*size-1. */
  values: Uint16Array;
}

export interface ThresholdScreenInput {
  width: number;
  height: number;
  /** 8-bit coverage, one byte per pixel, row-major. */
  plane: Uint8Array;
  array: ThresholdArray;
}

function fail(fn: string, message: string): never {
  throw new RangeError(`${fn}: ${message}`);
}

function requireIntegerInRange(fn: string, name: string, value: unknown, min: number, max: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return fail(fn, `${name} must be an integer in ${String(min)}..${String(max)} (got ${String(value)})`);
}

/* ------------------------------------------------------------------------------------------------
 * Bayer (ordered dither) arrays
 * ---------------------------------------------------------------------------------------------- */

function requireBayerSize(n: unknown): BayerSize {
  if (n === 2 || n === 4 || n === 8 || n === 16) return n;
  return fail('bayerArray', `n must be 2, 4, 8 or 16 (got ${String(n)})`);
}

/** Standard recursive Bayer matrix: M(2k) = [[4M, 4M+2], [4M+3, 4M+1]], starting from M(1) = [0]. */
export function bayerArray(n: BayerSize): ThresholdArray {
  const target = requireBayerSize(n);
  let size = 1;
  let values = Uint16Array.of(0);
  while (size < target) {
    const next = size * 2;
    const grown = new Uint16Array(next * next);
    for (let y = 0; y < next; y++) {
      for (let x = 0; x < next; x++) {
        const base = values[(y % size) * size + (x % size)] ?? 0;
        const offset = BAYER_QUADRANT_OFFSETS[(y >= size ? 2 : 0) + (x >= size ? 1 : 0)] ?? 0;
        grown[y * next + x] = 4 * base + offset;
      }
    }
    size = next;
    values = grown;
  }
  return { size, values };
}

/* ------------------------------------------------------------------------------------------------
 * Blue-noise arrays by void-and-cluster (Ulichney, 1993)
 * ---------------------------------------------------------------------------------------------- */

/** Local seeded PRNG (mulberry32), floats in [0, 1). */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Toroidal offsets and integer weights of the truncated Gaussian, folded onto a `size x size` torus. */
interface Kernel {
  count: number;
  dx: Int32Array;
  dy: Int32Array;
  weight: Int32Array;
}

function buildKernel(size: number): Kernel {
  const folded = new Int32Array(size * size);
  const r = BLUE_NOISE_KERNEL_RADIUS;
  const twoSigmaSquared = 2 * BLUE_NOISE_SIGMA * BLUE_NOISE_SIGMA;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > r * r) continue;
      const ox = ((dx % size) + size) % size;
      const oy = ((dy % size) + size) % size;
      const i = oy * size + ox;
      folded[i] = (folded[i] ?? 0) + Math.round(KERNEL_SCALE * Math.exp(-distanceSquared / twoSigmaSquared));
    }
  }
  let count = 0;
  for (const w of folded) if (w > 0) count++;
  const kernel: Kernel = { count, dx: new Int32Array(count), dy: new Int32Array(count), weight: new Int32Array(count) };
  let k = 0;
  folded.forEach((w, i) => {
    if (w === 0) return;
    kernel.dx[k] = i % size;
    kernel.dy[k] = Math.floor(i / size);
    kernel.weight[k] = w;
    k++;
  });
  return kernel;
}

/**
 * Tournament tree over the pixel indices: `top()` is the index with the largest (or smallest) value,
 * the lowest index on ties. `set` is O(log n), `top` is O(1).
 */
class ArgTree {
  private readonly leaves: number;
  private readonly preferMax: boolean;
  private readonly values: Int32Array;
  private readonly winners: Int32Array;

  constructor(count: number, preferMax: boolean, initial: number, empty: number) {
    let leaves = 1;
    while (leaves < count) leaves *= 2;
    this.leaves = leaves;
    this.preferMax = preferMax;
    this.values = new Int32Array(leaves).fill(empty);
    this.values.fill(initial, 0, count);
    this.winners = new Int32Array(2 * leaves);
    for (let i = 0; i < leaves; i++) this.winners[leaves + i] = i;
    for (let node = leaves - 1; node >= 1; node--) this.combine(node);
  }

  top(): number {
    return this.winners[1] ?? 0;
  }

  set(index: number, value: number): void {
    this.values[index] = value;
    for (let node = (index + this.leaves) >> 1; node >= 1; node >>= 1) this.combine(node);
  }

  private combine(node: number): void {
    const left = this.winners[2 * node] ?? 0;
    const right = this.winners[2 * node + 1] ?? 0;
    const a = this.values[left] ?? 0;
    const b = this.values[right] ?? 0;
    this.winners[node] = (this.preferMax ? a >= b : a <= b) ? left : right;
  }
}

/** A binary pattern with its Gaussian energy, kept up to date incrementally. */
interface Field {
  size: number;
  kernel: Kernel;
  bits: Uint8Array;
  energy: Int32Array;
  /** Max-energy search over set pixels: the tightest cluster. */
  ones: ArgTree;
  /** Min-energy search over unset pixels: the largest void. */
  zeros: ArgTree;
}

function blankField(size: number, kernel: Kernel): Field {
  const count = size * size;
  return {
    size,
    kernel,
    bits: new Uint8Array(count),
    energy: new Int32Array(count),
    ones: new ArgTree(count, true, ONE_EMPTY, ONE_EMPTY),
    zeros: new ArgTree(count, false, 0, ZERO_EMPTY),
  };
}

/** Sets or clears pixel `p`, updating the energy of its kernel neighbourhood: O(kernel area · log n). */
function toggle(field: Field, p: number, on: boolean): void {
  const { size, kernel, bits, energy, ones, zeros } = field;
  bits[p] = on ? 1 : 0;
  const sign = on ? 1 : -1;
  const px = p % size;
  const py = (p - px) / size;
  for (let k = 0; k < kernel.count; k++) {
    let x = px + (kernel.dx[k] ?? 0);
    if (x >= size) x -= size;
    let y = py + (kernel.dy[k] ?? 0);
    if (y >= size) y -= size;
    const q = y * size + x;
    const e = (energy[q] ?? 0) + sign * (kernel.weight[k] ?? 0);
    energy[q] = e;
    if (bits[q] === 1) ones.set(q, e);
    else zeros.set(q, e);
  }
  if (on) zeros.set(p, ZERO_EMPTY);
  else ones.set(p, ONE_EMPTY);
}

function fieldFrom(size: number, kernel: Kernel, pattern: Uint8Array): Field {
  const field = blankField(size, kernel);
  pattern.forEach((bit, p) => {
    if (bit === 1) toggle(field, p, true);
  });
  return field;
}

/**
 * Random minority pattern, then swap the tightest cluster into the largest void until the removed
 * pixel is itself the largest void. The swap count is capped at the pixel count.
 */
function initialPattern(size: number, kernel: Kernel, seed: number): Uint8Array {
  const count = size * size;
  const field = blankField(size, kernel);
  const rng = seededRng(seed);
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const minority = Math.max(1, Math.floor(count / INITIAL_MINORITY_DIVISOR));
  for (let i = 0; i < minority; i++) {
    const j = i + Math.floor(rng() * (count - i));
    const picked = order[j] ?? 0;
    order[j] = order[i] ?? 0;
    order[i] = picked;
    toggle(field, picked, true);
  }
  for (let swap = 0; swap < count; swap++) {
    const cluster = field.ones.top();
    toggle(field, cluster, false);
    const largestVoid = field.zeros.top();
    toggle(field, largestVoid, true);
    if (largestVoid === cluster) break;
  }
  return field.bits.slice();
}

/**
 * Spec 039a: a `size x size` blue-noise threshold array by void-and-cluster with a toroidal Gaussian
 * (sigma 1.5) truncated to a fixed radius. Phase 1 removes the tightest clusters of the starting
 * pattern (ranks below the minority count); phase 2 fills the largest voids up to the last rank.
 * Ulichney's phase 3 (tightest cluster of the unset pixels) is the same choice as the largest void of
 * the set pixels, because each pixel's two energies sum to the kernel total, so phase 2 runs to the end.
 * Total cost is O(size² · kernel area · log size). Same size and seed give byte-identical output.
 */
export function blueNoiseArray(size: number, seed: number): ThresholdArray {
  const n = requireIntegerInRange('blueNoiseArray', 'size', size, 2, MAX_THRESHOLD_ARRAY_SIZE);
  const s = requireIntegerInRange('blueNoiseArray', 'seed', seed, 0, MAX_SEED);
  const count = n * n;
  const kernel = buildKernel(n);
  const pattern = initialPattern(n, kernel, s);
  let minority = 0;
  for (const bit of pattern) minority += bit;

  const values = new Uint16Array(count);
  const removing = fieldFrom(n, kernel, pattern);
  for (let rank = minority - 1; rank >= 0; rank--) {
    const cluster = removing.ones.top();
    toggle(removing, cluster, false);
    values[cluster] = rank;
  }
  const adding = fieldFrom(n, kernel, pattern);
  for (let rank = minority; rank < count; rank++) {
    const largestVoid = adding.zeros.top();
    toggle(adding, largestVoid, true);
    values[largestVoid] = rank;
  }
  return { size: n, values };
}

/* ------------------------------------------------------------------------------------------------
 * Screening
 * ---------------------------------------------------------------------------------------------- */

const SCREEN = 'applyThresholdScreen';

/** Checks each dimension, then the pixel count, without forming an out-of-range product. */
function requirePixelCount(width: unknown, height: unknown): { width: number; height: number } {
  const w = requireIntegerInRange(SCREEN, 'width', width, 1, MAX_SCREEN_PIXELS);
  const h = requireIntegerInRange(SCREEN, 'height', height, 1, MAX_SCREEN_PIXELS);
  if (w <= Math.floor(MAX_SCREEN_PIXELS / h)) return { width: w, height: h };
  return fail(SCREEN, `${String(w)} x ${String(h)} pixels exceeds MAX_SCREEN_PIXELS (${String(MAX_SCREEN_PIXELS)})`);
}

function requirePlane(plane: unknown, pixelCount: number): Uint8Array {
  if (plane instanceof Uint8Array && plane.length === pixelCount) return plane;
  if (plane instanceof Uint8Array) {
    return fail(SCREEN, `plane has ${String(plane.length)} bytes, expected width * height = ${String(pixelCount)}`);
  }
  return fail(SCREEN, 'plane must be a Uint8Array');
}

function requirePermutation(values: unknown, size: number): Uint16Array {
  const count = size * size;
  if (values instanceof Uint16Array && values.length === count) {
    const seen = new Uint8Array(count);
    for (const v of values) {
      if (v >= count || seen[v] === 1) {
        return fail(SCREEN, `array.values must be a permutation of 0..${String(count - 1)} (bad value ${String(v)})`);
      }
      seen[v] = 1;
    }
    return values;
  }
  if (values instanceof Uint16Array) {
    return fail(SCREEN, `array.values has ${String(values.length)} entries, expected size * size = ${String(count)}`);
  }
  return fail(SCREEN, 'array.values must be a Uint16Array');
}

function requireThresholdArray(array: unknown): ThresholdArray {
  if (typeof array === 'object' && array && 'size' in array && 'values' in array) {
    const size = requireIntegerInRange(SCREEN, 'array.size', array.size, 1, MAX_THRESHOLD_ARRAY_SIZE);
    return { size, values: requirePermutation(array.values, size) };
  }
  return fail(SCREEN, 'array must be an object with size and values');
}

/**
 * Spec 039a: screens an 8-bit plane with a tiled threshold array. A pixel is on (1) when
 * `value · size² > threshold · 255`, in integer arithmetic: 0 is never on, 255 is always on.
 * Every input is validated before the mask is allocated.
 */
export function applyThresholdScreen(input: ThresholdScreenInput): Uint8Array {
  const { width, height } = requirePixelCount(input.width, input.height);
  const plane = requirePlane(input.plane, width * height);
  const { size, values } = requireThresholdArray(input.array);
  const levels = size * size;

  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const tileRow = (y % size) * size;
    let tx = 0;
    for (let x = 0; x < width; x++) {
      mask[row + x] = (plane[row + x] ?? 0) * levels > (values[tileRow + tx] ?? 0) * 255 ? 1 : 0;
      tx = tx + 1 === size ? 0 : tx + 1;
    }
  }
  return mask;
}
