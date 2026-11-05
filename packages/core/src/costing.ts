import type { AccountingKind, AccountingQuantity, DeviceAccountingReport } from './accounting.js';
import { InvalidArgumentError } from './errors.js';

/** The only unit an ink price applies to. Reported ink in any other unit is left unpriced. */
export const INK_UNIT = 'ml';
/** The only unit a media price applies to. Reported media in any other unit is left unpriced. */
export const MEDIA_UNIT = 'm2';
/** Every amount is computed in integer minor units (cents) of the table currency. */
export const MINOR_UNITS_PER_MAJOR = 100;

const SQUARE_MM_PER_SQUARE_METRE = 1_000_000;
/** Significant digits kept before rounding, so binary noise like 100.49999999999999 rounds as 100.5. */
const ROUNDING_PRECISION = 12;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MediaPrice {
  readonly name: string;
  readonly pricePerSquareMetre: number;
}

export interface InkPrice {
  readonly name: string;
  readonly pricePerMillilitre: number;
}

export interface OtherPrice {
  readonly name: string;
  readonly pricePerUnit: number;
  readonly unit: string;
}

export interface CostTable {
  /** ISO 4217 alphabetic code. */
  readonly currency: string;
  readonly media: readonly MediaPrice[];
  readonly ink: readonly InkPrice[];
  readonly other?: readonly OtherPrice[];
}

export interface CostLine {
  readonly kind: AccountingKind;
  readonly name: string;
  readonly quantity: number;
  readonly unit: string;
  /** Integer minor units, rounded half-up for this line. */
  readonly cost: number;
}

export interface CostEstimate {
  readonly lines: readonly CostLine[];
  /** Integer minor units; the exact sum of the line costs. */
  readonly total: number;
  readonly currency: string;
}

export interface AccountingCost extends CostEstimate {
  /** Reported quantities with no price for that name and unit, kept exactly as reported. */
  readonly unpriced: readonly AccountingQuantity[];
}

export interface JobCostInput {
  readonly mediaName: string;
  readonly widthMm: number;
  readonly lengthMm: number;
  readonly copies: number;
  readonly inkMlPerSquareMetre: Readonly<Record<string, number>>;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidArgumentError(`cost table: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidArgumentError(`cost table: ${field} must be a non-empty string`);
  }
  return value;
}

function price(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InvalidArgumentError(`cost table: ${field} must be a finite number >= 0`);
  }
  return value;
}

function parseEntries<T extends { readonly name: string }>(
  value: unknown,
  field: string,
  parse: (record: Record<string, unknown>, path: string) => T,
): T[] {
  if (!Array.isArray(value)) {
    throw new InvalidArgumentError(`cost table: ${field} must be an array`);
  }
  const seen = new Set<string>();
  return value.map((entry: unknown, index) => {
    const path = `${field}[${index}]`;
    const parsed = parse(asRecord(entry, path), path);
    if (seen.has(parsed.name)) {
      throw new InvalidArgumentError(`cost table: duplicate ${field} name "${parsed.name}"`);
    }
    seen.add(parsed.name);
    return parsed;
  });
}

/** Validates a cost table at the system boundary and returns a fresh copy. */
export function validateCostTable(value: unknown): CostTable {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidArgumentError('cost table must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.currency !== 'string' || !CURRENCY_PATTERN.test(record.currency)) {
    throw new InvalidArgumentError('cost table: currency must be an ISO 4217 code of three upper-case letters');
  }
  const media = parseEntries(record.media, 'media', (entry, path) => ({
    name: nonEmptyString(entry.name, `${path}.name`),
    pricePerSquareMetre: price(entry.pricePerSquareMetre, `${path}.pricePerSquareMetre`),
  }));
  const ink = parseEntries(record.ink, 'ink', (entry, path) => ({
    name: nonEmptyString(entry.name, `${path}.name`),
    pricePerMillilitre: price(entry.pricePerMillilitre, `${path}.pricePerMillilitre`),
  }));
  const table: CostTable = { currency: record.currency, media, ink };
  if (record.other === undefined) return table;
  const other = parseEntries(record.other, 'other', (entry, path) => ({
    name: nonEmptyString(entry.name, `${path}.name`),
    pricePerUnit: price(entry.pricePerUnit, `${path}.pricePerUnit`),
    unit: nonEmptyString(entry.unit, `${path}.unit`),
  }));
  return { ...table, other };
}

/** Rounds to an integer, halves away from zero (commercial half-up). */
function roundHalfUp(value: number): number {
  const corrected = Number(value.toPrecision(ROUNDING_PRECISION));
  const rounded = Math.floor(Math.abs(corrected) + 0.5);
  return corrected < 0 ? 0 - rounded : rounded;
}

function lineCost(quantity: number, pricePerUnit: number, name: string): number {
  const cost = roundHalfUp(quantity * pricePerUnit * MINOR_UNITS_PER_MAJOR);
  if (!Number.isSafeInteger(cost)) {
    throw new InvalidArgumentError(`cost for "${name}" is too large to represent exactly`);
  }
  return cost;
}

function sumLines(lines: readonly CostLine[]): number {
  return lines.reduce((total, line) => total + line.cost, 0);
}

function positiveDimension(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidArgumentError(`cost estimate: ${field} must be a finite number > 0`);
  }
  return value;
}

/** Estimates media and ink cost for a job from its printed size and per-square-metre ink use. */
export function estimateJobCost(table: CostTable, input: JobCostInput): CostEstimate {
  const widthMm = positiveDimension(input.widthMm, 'widthMm');
  const lengthMm = positiveDimension(input.lengthMm, 'lengthMm');
  if (!Number.isSafeInteger(input.copies) || input.copies < 1) {
    throw new InvalidArgumentError('cost estimate: copies must be an integer >= 1');
  }
  const medium = table.media.find((entry) => entry.name === input.mediaName);
  if (medium === undefined) {
    throw new InvalidArgumentError(`cost estimate: no media price for "${input.mediaName}"`);
  }
  const areaM2 = (widthMm * lengthMm * input.copies) / SQUARE_MM_PER_SQUARE_METRE;
  const mediaLine: CostLine = {
    kind: 'media',
    name: medium.name,
    quantity: areaM2,
    unit: MEDIA_UNIT,
    cost: lineCost(areaM2, medium.pricePerSquareMetre, medium.name),
  };
  const inkLines = Object.entries(input.inkMlPerSquareMetre).map(([name, mlPerM2]): CostLine => {
    if (!Number.isFinite(mlPerM2) || mlPerM2 < 0) {
      throw new InvalidArgumentError(`cost estimate: inkMlPerSquareMetre["${name}"] must be a finite number >= 0`);
    }
    const ink = table.ink.find((entry) => entry.name === name);
    if (ink === undefined) {
      throw new InvalidArgumentError(`cost estimate: no ink price for "${name}"`);
    }
    const quantity = mlPerM2 * areaM2;
    return { kind: 'ink', name, quantity, unit: INK_UNIT, cost: lineCost(quantity, ink.pricePerMillilitre, name) };
  });
  const lines = [mediaLine, ...inkLines];
  return { lines, total: sumLines(lines), currency: table.currency };
}

/** Price per unit for a reported quantity, only when the table prices that exact name and unit. */
function priceFor(table: CostTable, quantity: AccountingQuantity): number | undefined {
  switch (quantity.kind) {
    case 'media':
      if (quantity.unit !== MEDIA_UNIT) return undefined;
      return table.media.find((entry) => entry.name === quantity.name)?.pricePerSquareMetre;
    case 'ink':
      if (quantity.unit !== INK_UNIT) return undefined;
      return table.ink.find((entry) => entry.name === quantity.name)?.pricePerMillilitre;
    case 'other':
      return table.other?.find((entry) => entry.name === quantity.name && entry.unit === quantity.unit)?.pricePerUnit;
  }
}

/** Prices the quantities a device reported. Units are never converted; unmatched quantities are listed as unpriced. */
export function costFromAccountingReport(table: CostTable, report: DeviceAccountingReport): AccountingCost {
  const lines: CostLine[] = [];
  const unpriced: AccountingQuantity[] = [];
  for (const quantity of report.quantities) {
    const pricePerUnit = priceFor(table, quantity);
    if (pricePerUnit === undefined) {
      unpriced.push(quantity);
      continue;
    }
    lines.push({
      kind: quantity.kind,
      name: quantity.name,
      quantity: quantity.value,
      unit: quantity.unit,
      cost: lineCost(quantity.value, pricePerUnit, quantity.name),
    });
  }
  return { lines, total: sumLines(lines), currency: table.currency, unpriced };
}
