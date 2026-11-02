import type { Margins } from "./types.js";

export type LengthUnit = "mm" | "cm" | "in" | "pt";

export const POINTS_PER: Readonly<Record<LengthUnit, number>> = {
  pt: 1,
  in: 72,
  mm: 72 / 25.4,
  cm: 720 / 25.4,
};

const LENGTH_PATTERN = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|cm|in|pt)?\s*$/i;

/** Parses "1626mm", "64in", "2.5cm", "36pt" or a bare number (in `defaultUnit`). Undefined if malformed. */
export function parseLength(text: string, defaultUnit: LengthUnit = "pt"): number | undefined {
  const match = LENGTH_PATTERN.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  const unit = (match[2]?.toLowerCase() ?? defaultUnit) as LengthUnit;
  return Number.isFinite(value) ? value * POINTS_PER[unit] : undefined;
}

/** One length for all sides, or four comma-separated lengths: left,right,lead,trail. */
export function parseMargins(text: string, defaultUnit: LengthUnit = "pt"): Margins | undefined {
  const parts = text.split(",").map((part) => parseLength(part, defaultUnit));
  if (parts.some((part) => part === undefined || part < 0)) return undefined;
  const [left, right, lead, trail] = parts as number[];
  if (parts.length === 1 && left !== undefined) return { left, right: left, lead: left, trail: left };
  if (parts.length === 4 && left !== undefined && right !== undefined && lead !== undefined && trail !== undefined) {
    return { left, right, lead, trail };
  }
  return undefined;
}

export function pointsTo(valuePt: number, unit: LengthUnit): number {
  return valuePt / POINTS_PER[unit];
}
