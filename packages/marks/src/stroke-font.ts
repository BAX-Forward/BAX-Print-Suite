/**
 * BPS Stroke: the project's own single-stroke monospace font (Apache-2.0),
 * drawn as vector paths so label output is identical on every machine and
 * needs no font file. Glyphs sit on a 4 × 6 grid (cap height 6, baseline 0).
 * Each glyph is a list of polylines; a polyline is a string of digit pairs
 * "xy", where `m` stands for −1 (descender). Lowercase letters are drawn as
 * small capitals. Characters outside printable ASCII lose diacritics or fall
 * back to "?".
 */
import type { Point } from "./geometry.js";
import { MM_PER_PT } from "./units.js";

const O = "100105163645413010";
const P = "00063645443303";
const S = "453616050413334241301001";

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  " ": [],
  "!": ["2622", "2120"],
  '"': ["1614", "3634"],
  "#": ["1016", "3036", "0444", "0242"],
  $: [S, "2620"],
  "%": ["0046", "0615", "3140"],
  "&": ["4014152635340201102042"],
  "'": ["2624"],
  "(": ["36252130"],
  ")": ["16252110"],
  "*": ["2125", "1432", "1234"],
  "+": ["2125", "0343"],
  ",": ["21201m"],
  "-": ["0343"],
  ".": ["2120"],
  "/": ["0046"],
  "0": [O, "0145"],
  "1": ["152620", "1030"],
  "2": ["05163645440040"],
  "3": ["0516364544334241301001", "1333"],
  "4": ["30360242"],
  "5": ["4606033342413000"],
  "6": ["36160501103041423303"],
  "7": ["064610"],
  "8": ["13040516364544331302011030414233"],
  "9": ["43130405163645413010"],
  ":": ["2524", "2120"],
  ";": ["2524", "21201m"],
  "<": ["450341"],
  "=": ["0242", "0444"],
  ">": ["054301"],
  "?": ["05163645442322", "2120"],
  "@": ["323414124245361605011040"],
  A: ["0004264440", "0343"],
  B: ["00063645443303", "3342413000"],
  C: ["4536160501103041"],
  D: ["00063645413000"],
  E: ["46060040", "0333"],
  F: ["460600", "0333"],
  G: ["45361605011030414323"],
  H: ["0006", "4640", "0343"],
  I: ["1636", "2620", "1030"],
  J: ["4641301001"],
  K: ["0006", "4602", "1340"],
  L: ["060040"],
  M: ["0006234640"],
  N: ["00064046"],
  O: [O],
  P: [P],
  Q: [O, "2240"],
  R: [P, "2340"],
  S: [S],
  T: ["0646", "2620"],
  U: ["060110304146"],
  V: ["062046"],
  W: ["0610233046"],
  X: ["0046", "0640"],
  Y: ["062346", "2320"],
  Z: ["06460040"],
  "[": ["36262030"],
  "\\": ["0640"],
  "]": ["16262010"],
  "^": ["142634"],
  _: ["0040"],
  "`": ["1625"],
  "{": ["36252413222130"],
  "|": ["2620"],
  "}": ["16252433222110"],
  "~": ["04153445"],
};

/** Grid units per glyph advance (4 wide plus 1 space). */
const ADVANCE_UNITS = 5;
const CAP_UNITS = 6;
/** Cap height as a fraction of the font size. */
const CAP_HEIGHT_EM = 0.7;
export const LINE_HEIGHT_EM = 1.3;
export const STROKE_WIDTH_EM = 0.075;
const SMALL_CAP_SCALE = 0.75;

function decodeCoord(c: string): number {
  return c === "m" ? -1 : Number(c);
}

function parsePolyline(code: string): Point[] {
  const points: Point[] = [];
  for (let i = 0; i + 1 < code.length; i += 2) points.push({ x: decodeCoord(code[i]!), y: decodeCoord(code[i + 1]!) });
  return points;
}

const PARSED = new Map<string, Point[][]>(Object.entries(GLYPHS).map(([ch, lines]) => [ch, lines.map(parsePolyline)]));

export interface NormalizedText {
  readonly text: string;
  readonly substituted: string[];
}

/** Strips diacritics and replaces characters the font lacks with "?". */
export function normalizeForFont(text: string): NormalizedText {
  const substituted = new Set<string>();
  let out = "";
  for (const ch of text) {
    if (PARSED.has(ch) || PARSED.has(ch.toUpperCase())) {
      out += ch;
      continue;
    }
    const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
    if (base.length === 1 && (PARSED.has(base) || PARSED.has(base.toUpperCase()))) {
      out += base;
    } else {
      substituted.add(ch);
      out += "?";
    }
  }
  return { text: out, substituted: [...substituted] };
}

function glyphFor(ch: string): { lines: Point[][]; small: boolean } {
  const direct = PARSED.get(ch);
  if (direct && !(ch >= "a" && ch <= "z")) return { lines: direct, small: false };
  const upper = PARSED.get(ch.toUpperCase());
  if (upper) return { lines: upper, small: true };
  return { lines: PARSED.get("?")!, small: false };
}

export interface FontMetrics {
  readonly unitMm: number;
  readonly advanceMm: number;
  readonly capHeightMm: number;
  readonly lineHeightMm: number;
  readonly strokeWidthMm: number;
}

export function fontMetrics(fontSizePt: number): FontMetrics {
  const emMm = fontSizePt * MM_PER_PT;
  const unitMm = (emMm * CAP_HEIGHT_EM) / CAP_UNITS;
  return {
    unitMm,
    advanceMm: unitMm * ADVANCE_UNITS,
    capHeightMm: emMm * CAP_HEIGHT_EM,
    lineHeightMm: emMm * LINE_HEIGHT_EM,
    strokeWidthMm: emMm * STROKE_WIDTH_EM,
  };
}

export interface TextBlock {
  /** Polylines in mm, origin at the block's bottom-left. */
  readonly polylines: Point[][];
  readonly widthMm: number;
  readonly heightMm: number;
  readonly strokeWidthMm: number;
}

/** Lays out lines top to bottom, left aligned. Input must be normalized. */
export function layoutText(lines: readonly string[], fontSizePt: number): TextBlock {
  const m = fontMetrics(fontSizePt);
  const maxChars = Math.max(0, ...lines.map((l) => [...l].length));
  const widthMm = maxChars > 0 ? maxChars * m.advanceMm - m.unitMm : 0;
  const heightMm = lines.length * m.lineHeightMm;
  const baselinePad = (m.lineHeightMm - m.capHeightMm) / 2;
  const polylines: Point[][] = [];
  lines.forEach((line, row) => {
    const baseline = heightMm - (row + 1) * m.lineHeightMm + baselinePad;
    [...line].forEach((ch, col) => {
      const { lines: strokes, small } = glyphFor(ch);
      const s = small ? SMALL_CAP_SCALE : 1;
      const dx = col * m.advanceMm + (small ? ((1 - s) * 4 * m.unitMm) / 2 : 0);
      for (const stroke of strokes) {
        polylines.push(stroke.map((p) => ({ x: dx + p.x * s * m.unitMm, y: baseline + p.y * s * m.unitMm })));
      }
    });
  });
  return { polylines, widthMm, heightMm, strokeWidthMm: m.strokeWidthMm };
}
