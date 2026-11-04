import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped, no whitespace.
 * Used for content hashes and for exchange files that must be hash-equal across machines.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** SHA-256 (lowercase hex) of the canonical JSON of `value`; equal content gives an equal hash. */
export function canonicalContentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : normalize(item)));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = normalize(member);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('canonicalJson: non-finite numbers are not representable');
  }
  return value;
}
