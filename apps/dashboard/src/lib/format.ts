import type { Box } from '../api/types';

export type LengthUnit = 'in' | 'mm';

const PT_PER_INCH = 72;
const MM_PER_INCH = 25.4;
const DIGITS: Record<LengthUnit, number> = { in: 2, mm: 1 };
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const BYTES_PER_UNIT = 1024;

export function ptToUnit(pt: number, unit: LengthUnit): number {
  const inches = pt / PT_PER_INCH;
  return unit === 'in' ? inches : inches * MM_PER_INCH;
}

/** Rounded length without trailing zeros: 612 pt → "8.5" (in) or "215.9" (mm). */
export function formatLength(pt: number, unit: LengthUnit): string {
  return Number(ptToUnit(pt, unit).toFixed(DIGITS[unit])).toString();
}

export function formatPageSize(widthPt: number, heightPt: number, unit: LengthUnit): string {
  return `${formatLength(widthPt, unit)} × ${formatLength(heightPt, unit)} ${unit}`;
}

export function formatBox(box: Box, unit: LengthUnit): string {
  return `${formatPageSize(box.width, box.height, unit)} at ${formatLength(box.x, unit)}, ${formatLength(box.y, unit)}`;
}

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : Number(value.toFixed(1)).toString();
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

const dateTimeFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date);
}
