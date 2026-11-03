import type { LabelStyle, PanelNaming } from "./types.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Spreadsheet-style letters: 1 → A, 26 → Z, 27 → AA. */
export function letters(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`letters() needs a positive integer, got ${n}`);
  let out = "";
  let rest = n;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    out = ALPHABET[digit] + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
}

function format(n: number, style: LabelStyle): string {
  return style === "letters" ? letters(n) : String(n);
}

/**
 * Row and column parts of a panel label. Default rows as letters and columns
 * as numbers, the convention used on construction drawings.
 */
export function panelLabelParts(row: number, col: number, naming: PanelNaming = {}): { row: string; col: string } {
  return { row: format(row, naming.rows ?? "letters"), col: format(col, naming.cols ?? "numbers") };
}

export function panelLabel(row: number, col: number, naming: PanelNaming = {}): string {
  const parts = panelLabelParts(row, col, naming);
  // Two parts in the same style would run together ("111" = 1-11 or 11-1), so separate them.
  const sameStyle = (naming.rows ?? "letters") === (naming.cols ?? "numbers");
  const separator = naming.separator ?? (sameStyle ? "-" : "");
  return `${parts.row}${separator}${parts.col}`;
}
