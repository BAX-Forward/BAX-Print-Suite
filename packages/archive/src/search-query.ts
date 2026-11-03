import { InvalidArgumentError } from '@bax-print/core';
import { MAX_PAGE_SIZE, type ArchiveDateField, type ArchiveSearchQuery } from '@bax-print/store';

const DATE_FIELDS: readonly ArchiveDateField[] = ['done', 'archived', 'created'];
const META_PREFIX = 'meta.';

function single(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof last === 'number') return String(last);
  if (typeof last !== 'string') throw new InvalidArgumentError(`${key} must be a string`);
  return last.trim() === '' ? undefined : last;
}

function dateParam(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = single(raw, key);
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new InvalidArgumentError(`${key} must be a date or date-time`);
  return new Date(ms).toISOString();
}

function sizeParam(raw: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = single(raw, key);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError(`${key} must be a non-negative number of millimetres`);
  return n;
}

/**
 * Turns untrusted query-string parameters into an archive search query.
 * Parameters: q, customer, meta.<key>, dateField, from, to, device, medium,
 * minWidthMm, maxWidthMm, minHeightMm, maxHeightMm, tags (comma-separated or repeated), limit, cursor.
 */
export function parseSearchQuery(raw: Readonly<Record<string, unknown>>): ArchiveSearchQuery {
  const query: ArchiveSearchQuery = {
    text: single(raw, 'q'),
    customerRef: single(raw, 'customer'),
    from: dateParam(raw, 'from'),
    to: dateParam(raw, 'to'),
    deviceId: single(raw, 'device'),
    mediumId: single(raw, 'medium'),
    minWidthMm: sizeParam(raw, 'minWidthMm'),
    maxWidthMm: sizeParam(raw, 'maxWidthMm'),
    minHeightMm: sizeParam(raw, 'minHeightMm'),
    maxHeightMm: sizeParam(raw, 'maxHeightMm'),
    cursor: single(raw, 'cursor'),
  };

  const dateField = single(raw, 'dateField');
  if (dateField !== undefined) {
    if (!DATE_FIELDS.includes(dateField as ArchiveDateField)) {
      throw new InvalidArgumentError(`dateField must be one of ${DATE_FIELDS.join(', ')}`);
    }
    query.dateField = dateField as ArchiveDateField;
  }

  const limit = single(raw, 'limit');
  if (limit !== undefined) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
      throw new InvalidArgumentError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    }
    query.limit = n;
  }

  const rawTags = raw.tags;
  if (rawTags !== undefined) {
    const list = Array.isArray(rawTags) ? rawTags : [rawTags];
    if (!list.every((tag) => typeof tag === 'string')) throw new InvalidArgumentError('tags must be strings');
    const tags = (list as string[]).flatMap((tag) => tag.split(',')).map((tag) => tag.trim()).filter(Boolean);
    if (tags.length > 0) query.tags = tags;
  }

  const metadata: Record<string, string> = {};
  for (const key of Object.keys(raw)) {
    if (!key.startsWith(META_PREFIX)) continue;
    const name = key.slice(META_PREFIX.length);
    const text = single(raw, key);
    if (name === '' || text === undefined) throw new InvalidArgumentError(`${key} needs a metadata key and value`);
    metadata[name] = text;
  }
  if (Object.keys(metadata).length > 0) query.metadata = metadata;

  if (query.from && query.to && query.from > query.to) {
    throw new InvalidArgumentError('from must not be after to');
  }
  return query;
}
