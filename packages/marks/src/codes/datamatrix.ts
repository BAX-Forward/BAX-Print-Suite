/**
 * Data Matrix ECC 200 encoder (ISO/IEC 16022:2006): ASCII encodation with
 * digit-pair compaction, Reed–Solomon over GF(256) with polynomial 0x12D,
 * and the standard module placement. Square symbols 10 × 10 to 64 × 64.
 */
import { MarkSpecError } from "../errors.js";

interface SymbolSize {
  readonly size: number;
  /** Data region edge (modules, without finder pattern). */
  readonly region: number;
  /** Data regions per side. */
  readonly regions: number;
  readonly dataCodewords: number;
  readonly eccCodewords: number;
  readonly blocks: number;
}

const s = (size: number, region: number, regions: number, data: number, ecc: number, blocks = 1): SymbolSize => ({
  size,
  region,
  regions,
  dataCodewords: data,
  eccCodewords: ecc,
  blocks,
});

/** ISO/IEC 16022 Table 7, square ECC 200 symbols. */
const SIZES: readonly SymbolSize[] = [
  s(10, 8, 1, 3, 5),
  s(12, 10, 1, 5, 7),
  s(14, 12, 1, 8, 10),
  s(16, 14, 1, 12, 12),
  s(18, 16, 1, 18, 14),
  s(20, 18, 1, 22, 18),
  s(22, 20, 1, 30, 20),
  s(24, 22, 1, 36, 24),
  s(26, 24, 1, 44, 28),
  s(32, 14, 2, 62, 36),
  s(36, 16, 2, 86, 42),
  s(40, 18, 2, 114, 48),
  s(44, 20, 2, 144, 56),
  s(48, 22, 2, 174, 68),
  s(52, 24, 2, 204, 84, 2),
  s(64, 14, 4, 280, 112, 2),
];

const PAD = 129;
const UPPER_SHIFT = 235;
const DIGIT_PAIR_BASE = 130;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x12d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** Generator polynomial (highest degree first) with roots α^1 … α^n. */
function generator(n: number): number[] {
  let poly = [1];
  for (let i = 1; i <= n; i++) {
    const root = EXP[i]!;
    const next = new Array<number>(poly.length + 1).fill(0);
    poly.forEach((c, j) => {
      next[j] = next[j]! ^ c;
      next[j + 1] = next[j + 1]! ^ gfMul(c, root);
    });
    poly = next;
  }
  return poly;
}

export function reedSolomon(data: readonly number[], n: number): number[] {
  const g = generator(n);
  const ecc = new Array<number>(n).fill(0);
  for (const d of data) {
    const factor = d ^ ecc[0]!;
    for (let i = 0; i < n - 1; i++) ecc[i] = ecc[i + 1]! ^ gfMul(factor, g[i + 1]!);
    ecc[n - 1] = gfMul(factor, g[n]!);
  }
  return ecc;
}

/** ASCII encodation (§5.2.3) of the UTF-8 bytes of `text`. */
export function encodeAscii(text: string): number[] {
  const bytes = new TextEncoder().encode(text);
  const out: number[] = [];
  const isDigit = (b: number | undefined) => b !== undefined && b >= 0x30 && b <= 0x39;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (isDigit(b) && isDigit(bytes[i + 1])) {
      out.push(DIGIT_PAIR_BASE + (b - 0x30) * 10 + (bytes[i + 1]! - 0x30));
      i++;
    } else if (b > 127) {
      out.push(UPPER_SHIFT, b - 127);
    } else {
      out.push(b + 1);
    }
  }
  return out;
}

/** Pads to `capacity` with 129 then 253-state randomised pads (§5.2.3, Annex B). */
function pad(codewords: readonly number[], capacity: number): number[] {
  const out = [...codewords];
  if (out.length < capacity) out.push(PAD);
  while (out.length < capacity) {
    const position = out.length + 1;
    const v = PAD + (((149 * position) % 253) + 1);
    out.push(v <= 254 ? v : v - 254);
  }
  return out;
}

/** Data plus interleaved error correction for one symbol size. */
export function symbolCodewords(data: readonly number[], size: SymbolSize): number[] {
  const padded = pad(data, size.dataCodewords);
  const { blocks } = size;
  const eccPerBlock = size.eccCodewords / blocks;
  const out = new Array<number>(size.dataCodewords + size.eccCodewords);
  padded.forEach((c, i) => (out[i] = c));
  for (let b = 0; b < blocks; b++) {
    const blockData = padded.filter((_, i) => i % blocks === b);
    reedSolomon(blockData, eccPerBlock).forEach((c, k) => (out[size.dataCodewords + b + k * blocks] = c));
  }
  return out;
}

/** Module placement (Annex F) into an nrow × ncol mapping matrix. */
function place(codewords: readonly number[], nrow: number, ncol: number): Uint8Array {
  const bits = new Uint8Array(nrow * ncol);
  const assigned = new Uint8Array(nrow * ncol);
  const module = (row: number, col: number, chr: number, bit: number) => {
    if (row < 0) {
      row += nrow;
      col += 4 - ((nrow + 4) % 8);
    }
    if (col < 0) {
      col += ncol;
      row += 4 - ((ncol + 4) % 8);
    }
    const i = row * ncol + col;
    assigned[i] = 1;
    bits[i] = ((codewords[chr] ?? 0) >> (8 - bit)) & 1;
  };
  const utah = (row: number, col: number, chr: number) => {
    module(row - 2, col - 2, chr, 1);
    module(row - 2, col - 1, chr, 2);
    module(row - 1, col - 2, chr, 3);
    module(row - 1, col - 1, chr, 4);
    module(row - 1, col, chr, 5);
    module(row, col - 2, chr, 6);
    module(row, col - 1, chr, 7);
    module(row, col, chr, 8);
  };
  const corner = (cells: readonly (readonly [number, number])[], chr: number) =>
    cells.forEach(([r, c], k) => module(r, c, chr, k + 1));
  const corner1 = (chr: number) =>
    corner([[nrow - 1, 0], [nrow - 1, 1], [nrow - 1, 2], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]], chr);
  const corner2 = (chr: number) =>
    corner([[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 4], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1]], chr);
  const corner3 = (chr: number) =>
    corner([[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]], chr);
  const corner4 = (chr: number) =>
    corner([[nrow - 1, 0], [nrow - 1, ncol - 1], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 3], [1, ncol - 2], [1, ncol - 1]], chr);

  let chr = 0;
  let row = 4;
  let col = 0;
  do {
    if (row === nrow && col === 0) corner1(chr++);
    if (row === nrow - 2 && col === 0 && ncol % 4 !== 0) corner2(chr++);
    if (row === nrow - 2 && col === 0 && ncol % 8 === 4) corner3(chr++);
    if (row === nrow + 4 && col === 2 && ncol % 8 === 0) corner4(chr++);
    do {
      if (row < nrow && col >= 0 && !assigned[row * ncol + col]) utah(row, col, chr++);
      row -= 2;
      col += 2;
    } while (row >= 0 && col < ncol);
    row += 1;
    col += 3;
    do {
      if (row >= 0 && col < ncol && !assigned[row * ncol + col]) utah(row, col, chr++);
      row += 2;
      col -= 2;
    } while (row < nrow && col >= 0);
    row += 3;
    col += 1;
  } while (row < nrow || col < ncol);

  if (!assigned[nrow * ncol - 1]) {
    bits[nrow * ncol - 1] = 1;
    bits[(nrow - 1) * ncol - 2] = 1;
  }
  return bits;
}

export interface DataMatrixSymbol {
  readonly size: number;
  readonly codewords: number[];
  /** Row-major, row 0 at the top; true = dark. */
  readonly modules: boolean[][];
}

export function encodeDataMatrix(text: string): DataMatrixSymbol {
  const data = encodeAscii(text);
  const size = SIZES.find((sz) => sz.dataCodewords >= data.length);
  if (!size) {
    throw new MarkSpecError(`Data Matrix payload needs ${data.length} codewords; the largest supported symbol holds 280`);
  }
  const codewords = symbolCodewords(data, size);
  const n = size.region * size.regions;
  const bits = place(codewords, n, n);
  const R = size.region;
  const modules = Array.from({ length: size.size }, () => new Array<boolean>(size.size).fill(false));
  for (let rr = 0; rr < size.regions; rr++) {
    for (let rc = 0; rc < size.regions; rc++) {
      const top = rr * (R + 2);
      const left = rc * (R + 2);
      for (let i = 0; i < R + 2; i++) {
        modules[top + i]![left] = true;
        modules[top + R + 1]![left + i] = true;
        modules[top]![left + i] = i % 2 === 0;
        modules[top + i]![left + R + 1] = i % 2 === 1;
      }
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const row = Math.floor(r / R) * (R + 2) + 1 + (r % R);
      const col = Math.floor(c / R) * (R + 2) + 1 + (c % R);
      modules[row]![col] = bits[r * n + c] === 1;
    }
  }
  return { size: size.size, codewords, modules };
}
