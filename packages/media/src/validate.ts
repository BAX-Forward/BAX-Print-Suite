import {
  DEFAULT_VERIFICATION_THRESHOLDS,
  MEDIUM_KIND_VOCABULARY,
  type MediumForm,
  type MediumKind,
  type MediumSides,
  ValidationError,
  type VerificationThresholds,
  isMediumKindTerm,
} from '@bax-print/core';

const MAX_TEXT = 200;
export const COLORANT_ID = /^[A-Za-z0-9_-]+$/;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function requireText(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`, { field });
  }
  const text = value.trim();
  if (text.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  return text;
}

/** A free-text tag; the controlled term is derived when the tag matches the vocabulary. */
export function normalizeKind(kind: unknown): MediumKind {
  if (typeof kind === 'string') {
    const tag = requireText(kind, 'kind');
    const lower = tag.toLowerCase();
    return isMediumKindTerm(lower) ? { tag, term: lower } : { tag };
  }
  if (kind !== null && typeof kind === 'object') {
    const { tag, term } = kind as { tag?: unknown; term?: unknown };
    const text = requireText(tag, 'kind.tag');
    if (term === undefined) return normalizeKind(text);
    if (!isMediumKindTerm(term)) {
      throw new ValidationError(`kind.term must be one of ${MEDIUM_KIND_VOCABULARY.join(', ')}`, { field: 'kind.term' });
    }
    return { tag: text, term };
  }
  throw new ValidationError('kind must be a string or { tag, term? }', { field: 'kind' });
}

/** Widths in mm, de-duplicated and sorted so device reports and user input compare equal. */
export function normalizeWidths(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((w) => !isFiniteNumber(w) || w <= 0)) {
    throw new ValidationError('widthsMm must be an array of positive numbers', { field: 'widthsMm' });
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

export function optionalPositive(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!isFiniteNumber(value) || value <= 0) throw new ValidationError(`${field} must be a positive number`, { field });
  return value;
}

export function normalizeForm(value: unknown): MediumForm {
  if (value === undefined) return 'roll';
  if (value !== 'roll' && value !== 'sheet') throw new ValidationError('form must be roll or sheet', { field: 'form' });
  return value;
}

export function normalizeSides(value: unknown): MediumSides {
  if (value === undefined) return 1;
  if (value !== 1 && value !== 2) throw new ValidationError('sides must be 1 or 2', { field: 'sides' });
  return value;
}

export function normalizeThresholds(
  value: Partial<VerificationThresholds> | undefined,
  base: VerificationThresholds = DEFAULT_VERIFICATION_THRESHOLDS,
): VerificationThresholds {
  const merged = { ...base, ...(value ?? {}) };
  for (const key of ['maxMeanDeltaE2000', 'maxP95DeltaE2000'] as const) {
    if (!isFiniteNumber(merged[key]) || merged[key] <= 0) {
      throw new ValidationError(`verification.${key} must be a positive number`, { field: key });
    }
  }
  return { maxMeanDeltaE2000: merged.maxMeanDeltaE2000, maxP95DeltaE2000: merged.maxP95DeltaE2000 };
}

export function normalizeColorants(value: unknown, field = 'colorants'): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError(`${field} must be a non-empty array`, { field });
  for (const colorant of value) {
    if (typeof colorant !== 'string' || !COLORANT_ID.test(colorant)) {
      throw new ValidationError(`${field} contains an invalid colorant id`, { field });
    }
  }
  if (new Set(value).size !== value.length) throw new ValidationError(`${field} has duplicate colorants`, { field });
  return [...(value as string[])];
}
