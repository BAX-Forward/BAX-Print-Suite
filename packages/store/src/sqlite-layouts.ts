import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';

/**
 * Spec 003w: saved layouts (a step-and-repeat or nest result) as named, reusable templates in
 * the job database (migration 3).
 */

export const MAX_LAYOUT_TEMPLATE_NAME_LENGTH = 120;

/**
 * The part of a stored layout this package checks. Structural so the store does not depend on
 * the nest package; any nest `Layout` serialized with `JSON.stringify` satisfies it.
 */
export interface LayoutTemplateLayout {
  readonly placements: readonly unknown[];
  readonly [key: string]: unknown;
}

/** A saved template with its layout document, as `get` and `getByName` return it. */
export interface LayoutTemplate {
  readonly id: string;
  readonly name: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601. */
  readonly updatedAt: string;
  readonly rollWidthMm: number;
  /** The layout as JSON text, exactly as saved. */
  readonly layoutJson: string;
}

/** A template without its layout document: what `list` returns. */
export type LayoutTemplateSummary = Omit<LayoutTemplate, 'layoutJson'>;

export interface NewLayoutTemplate {
  /** Saving an existing id replaces that template and keeps its creation time. Generated when absent. */
  readonly id?: string;
  /** Trimmed before it is stored; 1 to 120 characters. */
  readonly name: string;
  readonly rollWidthMm: number;
  /** Must parse to an object with a `placements` array. */
  readonly layoutJson: string;
}

export interface LayoutTemplateRepository {
  /** Throws {@link InvalidLayoutTemplateError} or {@link LayoutTemplateNameConflictError}. */
  save(template: NewLayoutTemplate): LayoutTemplate;
  get(id: string): LayoutTemplate | undefined;
  /** Looks up the trimmed name. */
  getByName(name: string): LayoutTemplate | undefined;
  /** Ordered by name. Never includes the layout document. */
  list(): LayoutTemplateSummary[];
  delete(id: string): boolean;
  /** Undefined when no template has `id`. Throws like `save` for a bad or taken name. */
  rename(id: string, name: string): LayoutTemplate | undefined;
}

export type LayoutTemplateField = 'id' | 'name' | 'rollWidthMm' | 'layoutJson';

export class InvalidLayoutTemplateError extends Error {
  readonly code = 'LAYOUT_TEMPLATE_INVALID';
  readonly field: LayoutTemplateField;

  constructor(field: LayoutTemplateField, message: string) {
    super(message);
    this.name = 'InvalidLayoutTemplateError';
    this.field = field;
  }
}

export class LayoutTemplateNameConflictError extends Error {
  readonly code = 'LAYOUT_TEMPLATE_NAME_EXISTS';
  readonly templateName: string;

  constructor(templateName: string) {
    super(`a layout template is already named ${JSON.stringify(templateName)}`);
    this.name = 'LayoutTemplateNameConflictError';
    this.templateName = templateName;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Parses a layout document, throwing {@link InvalidLayoutTemplateError} if it is not one. */
export function parseLayoutTemplateJson(text: string): LayoutTemplateLayout {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidLayoutTemplateError('layoutJson', 'layout JSON does not parse');
  }
  if (!isRecord(value)) {
    throw new InvalidLayoutTemplateError('layoutJson', 'layout JSON must be an object');
  }
  const { placements } = value;
  if (!isUnknownArray(placements)) {
    throw new InvalidLayoutTemplateError('layoutJson', 'layout JSON must have a placements array');
  }
  return { ...value, placements };
}

/** The trimmed name, or throws {@link InvalidLayoutTemplateError}. Length counts code points. */
export function normalizeLayoutTemplateName(name: string): string {
  const trimmed = name.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > MAX_LAYOUT_TEMPLATE_NAME_LENGTH) {
    throw new InvalidLayoutTemplateError(
      'name',
      `layout template name must be 1 to ${MAX_LAYOUT_TEMPLATE_NAME_LENGTH} characters after trimming`,
    );
  }
  return trimmed;
}

function validateRollWidth(rollWidthMm: number): number {
  if (!Number.isFinite(rollWidthMm) || rollWidthMm <= 0) {
    throw new InvalidLayoutTemplateError('rollWidthMm', 'roll width must be a finite number greater than 0 mm');
  }
  return rollWidthMm;
}

function validateId(id: string | undefined): string {
  if (id === undefined) {
    return randomUUID();
  }
  if (id.trim().length === 0) {
    throw new InvalidLayoutTemplateError('id', 'layout template id must not be empty');
  }
  return id;
}

interface SummaryRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  roll_width_mm: number;
}

interface TemplateRow extends SummaryRow {
  layout_json: string;
}

const SUMMARY_COLUMNS = 'id, name, created_at, updated_at, roll_width_mm';

function toSummary(row: SummaryRow): LayoutTemplateSummary {
  return Object.freeze({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rollWidthMm: Number(row.roll_width_mm),
  });
}

function toTemplate(row: TemplateRow): LayoutTemplate {
  return Object.freeze({ ...toSummary(row), layoutJson: row.layout_json });
}

/** Runs `work` in one transaction so the name check and the write cannot interleave. */
function inTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export interface SqliteLayoutTemplateRepositoryOptions {
  /** Clock for `createdAt` and `updatedAt`; defaults to the system clock. */
  readonly now?: () => Date;
}

export class SqliteLayoutTemplateRepository implements LayoutTemplateRepository {
  private readonly now: () => Date;

  /** `db` must come from `openDatabase`, which applies the migrations. */
  constructor(
    private readonly db: Database,
    options: SqliteLayoutTemplateRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  save(template: NewLayoutTemplate): LayoutTemplate {
    const id = validateId(template.id);
    const name = normalizeLayoutTemplateName(template.name);
    const rollWidthMm = validateRollWidth(template.rollWidthMm);
    parseLayoutTemplateJson(template.layoutJson);

    return inTransaction(this.db, () => {
      this.assertNameFree(name, id);
      const timestamp = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO layout_templates (id, name, created_at, updated_at, roll_width_mm, layout_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at,
             roll_width_mm = excluded.roll_width_mm, layout_json = excluded.layout_json`,
        )
        .run(id, name, timestamp, timestamp, rollWidthMm, template.layoutJson);
      return this.requireTemplate(id);
    });
  }

  get(id: string): LayoutTemplate | undefined {
    const row = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS}, layout_json FROM layout_templates WHERE id = ?`)
      .get(id) as unknown as TemplateRow | undefined;
    return row ? toTemplate(row) : undefined;
  }

  getByName(name: string): LayoutTemplate | undefined {
    const row = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS}, layout_json FROM layout_templates WHERE name = ?`)
      .get(name.trim()) as unknown as TemplateRow | undefined;
    return row ? toTemplate(row) : undefined;
  }

  list(): LayoutTemplateSummary[] {
    const rows = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM layout_templates ORDER BY name, id`)
      .all() as unknown as SummaryRow[];
    return rows.map(toSummary);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM layout_templates WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  rename(id: string, name: string): LayoutTemplate | undefined {
    const normalized = normalizeLayoutTemplateName(name);
    return inTransaction(this.db, () => {
      this.assertNameFree(normalized, id);
      const result = this.db
        .prepare('UPDATE layout_templates SET name = ?, updated_at = ? WHERE id = ?')
        .run(normalized, this.now().toISOString(), id);
      return Number(result.changes) > 0 ? this.requireTemplate(id) : undefined;
    });
  }

  /** Throws {@link LayoutTemplateNameConflictError} if a template other than `id` has `name`. */
  private assertNameFree(name: string, id: string): void {
    const holder = this.db
      .prepare('SELECT id FROM layout_templates WHERE name = ? AND id <> ?')
      .get(name, id);
    if (holder !== undefined) {
      throw new LayoutTemplateNameConflictError(name);
    }
  }

  private requireTemplate(id: string): LayoutTemplate {
    const template = this.get(id);
    if (template === undefined) {
      throw new Error(`layout template ${id} vanished inside its own transaction`);
    }
    return template;
  }
}
