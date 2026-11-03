import { BpsError } from '@bax-print/core';

/** Slim row kept in the database for every archived job (Spec 008 FR3). */
export interface ArchiveIndexRow {
  readonly jobId: string;
  readonly name: string;
  readonly customerRef?: string;
  readonly createdAt: string;
  readonly doneAt?: string;
  readonly archivedAt: string;
  readonly deviceId?: string;
  readonly mediumId?: string;
  readonly widthMm?: number;
  readonly heightMm?: number;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly reprintOf?: string;
  readonly packageKey: string;
  readonly packageSha256: string;
  readonly packageBytes: number;
}

export type ArchiveDateField = 'done' | 'archived' | 'created';

export interface ArchiveSearchQuery {
  /** Case-insensitive substring over name, customer, id, tags and metadata values. */
  text?: string;
  customerRef?: string;
  metadata?: Record<string, string>;
  dateField?: ArchiveDateField;
  from?: string;
  to?: string;
  deviceId?: string;
  mediumId?: string;
  minWidthMm?: number;
  maxWidthMm?: number;
  minHeightMm?: number;
  maxHeightMm?: number;
  /** Every listed tag must be present. */
  tags?: string[];
  limit?: number;
  cursor?: string;
}

export interface ArchivePage {
  readonly items: ArchiveIndexRow[];
  readonly nextCursor?: string;
}

export interface ArchiveIndexRepository {
  upsert(row: ArchiveIndexRow): Promise<void>;
  get(jobId: string): Promise<ArchiveIndexRow | undefined>;
  remove(jobId: string): Promise<boolean>;
  search(query: ArchiveSearchQuery): Promise<ArchivePage>;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

export class InvalidCursorError extends BpsError {
  constructor() {
    super('INVALID_CURSOR', 'the search cursor is invalid or belongs to a different date field');
  }
}

interface Cursor {
  readonly f: ArchiveDateField;
  readonly k: string;
  readonly id: string;
}

function sortKey(row: ArchiveIndexRow, field: ArchiveDateField): string {
  if (field === 'created') return row.createdAt;
  if (field === 'archived') return row.archivedAt;
  return row.doneAt ?? row.archivedAt;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(text: string, field: ArchiveDateField): Cursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const cursor = value as Partial<Cursor> | null;
  if (!cursor || cursor.f !== field || typeof cursor.k !== 'string' || typeof cursor.id !== 'string') {
    throw new InvalidCursorError();
  }
  return { f: cursor.f, k: cursor.k, id: cursor.id };
}

function inRange(value: number | undefined, min: number | undefined, max: number | undefined): boolean {
  if (min === undefined && max === undefined) return true;
  if (value === undefined) return false;
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}

export function matchesSearch(row: ArchiveIndexRow, query: ArchiveSearchQuery): boolean {
  if (query.text) {
    const needle = query.text.toLowerCase();
    const haystack = [row.name, row.customerRef ?? '', row.jobId, ...row.tags, ...Object.values(row.metadata)];
    if (!haystack.some((value) => value.toLowerCase().includes(needle))) return false;
  }
  if (query.customerRef && row.customerRef?.toLowerCase() !== query.customerRef.toLowerCase()) return false;
  if (query.metadata) {
    for (const [key, value] of Object.entries(query.metadata)) {
      if (row.metadata[key] !== value) return false;
    }
  }
  if (query.deviceId && row.deviceId !== query.deviceId) return false;
  if (query.mediumId && row.mediumId !== query.mediumId) return false;
  if (!inRange(row.widthMm, query.minWidthMm, query.maxWidthMm)) return false;
  if (!inRange(row.heightMm, query.minHeightMm, query.maxHeightMm)) return false;
  if (query.tags && query.tags.length > 0) {
    const tags = new Set(row.tags.map((tag) => tag.toLowerCase()));
    if (!query.tags.every((tag) => tags.has(tag.toLowerCase()))) return false;
  }
  if (query.from || query.to) {
    const time = Date.parse(sortKey(row, query.dateField ?? 'done'));
    if (query.from && time < Date.parse(query.from)) return false;
    if (query.to && time > Date.parse(query.to)) return false;
  }
  return true;
}

/** Filters, orders (newest first, then id) and cursor-pages archive rows. */
export function searchRows(rows: readonly ArchiveIndexRow[], query: ArchiveSearchQuery = {}): ArchivePage {
  const field = query.dateField ?? 'done';
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = query.cursor ? decodeCursor(query.cursor, field) : undefined;

  const ordered = rows
    .filter((row) => matchesSearch(row, query))
    .map((row) => ({ row, key: sortKey(row, field) }))
    .sort((a, b) => {
      if (a.key !== b.key) return a.key < b.key ? 1 : -1;
      if (a.row.jobId !== b.row.jobId) return a.row.jobId < b.row.jobId ? 1 : -1;
      return 0;
    });

  const remaining = cursor
    ? ordered.filter((entry) => entry.key < cursor.k || (entry.key === cursor.k && entry.row.jobId < cursor.id))
    : ordered;
  const page = remaining.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    remaining.length > limit && last ? encodeCursor({ f: field, k: last.key, id: last.row.jobId }) : undefined;

  return { items: page.map((entry) => entry.row), ...(nextCursor ? { nextCursor } : {}) };
}

export class MemoryArchiveIndex implements ArchiveIndexRepository {
  private readonly rows = new Map<string, ArchiveIndexRow>();

  async upsert(row: ArchiveIndexRow): Promise<void> {
    this.rows.set(row.jobId, structuredClone(row));
  }

  async get(jobId: string): Promise<ArchiveIndexRow | undefined> {
    const row = this.rows.get(jobId);
    return row ? structuredClone(row) : undefined;
  }

  async remove(jobId: string): Promise<boolean> {
    return this.rows.delete(jobId);
  }

  async search(query: ArchiveSearchQuery): Promise<ArchivePage> {
    const page = searchRows([...this.rows.values()], query);
    return { ...page, items: page.items.map((row) => structuredClone(row)) };
  }
}
