/**
 * Spec 027e: {@link LayoutTemplateRepository} for PostgreSQL, written only against {@link DbPort}.
 *
 * Not wired into the server, and this build ships no PostgreSQL driver: nothing constructs a
 * port for it yet. The SQL uses `?` placeholders as DbPort documents; a driver adapter maps them
 * to its own form. The table is `layout_templates` from PG_MIGRATIONS version 3.
 *
 * `layout_json` is JSONB there, so it is read back as `layout_json::text`: the same document,
 * but PostgreSQL normalizes its whitespace and key order. Names sort with the "C" collation so
 * `list` orders by code point, as the SQLite repository does.
 */
import { randomUUID } from 'node:crypto';
import type { DbPort, DbRow } from './db-port.js';
import {
  InvalidLayoutTemplateError,
  LayoutTemplateNameConflictError,
  normalizeLayoutTemplateName,
  parseLayoutTemplateJson,
  type LayoutTemplate,
  type LayoutTemplateRepository,
  type LayoutTemplateSummary,
  type NewLayoutTemplate,
} from './sqlite-layouts.js';

const SUMMARY_COLUMNS = 'id, name, created_at, updated_at, roll_width_mm';

const TEMPLATE_COLUMNS = `${SUMMARY_COLUMNS}, layout_json::text AS layout_json`;

const SELECT_BY_ID = `SELECT ${TEMPLATE_COLUMNS} FROM layout_templates WHERE id = ?`;

const SELECT_BY_NAME = `SELECT ${TEMPLATE_COLUMNS} FROM layout_templates WHERE name = ?`;

const LIST_ALL = `SELECT ${SUMMARY_COLUMNS} FROM layout_templates ORDER BY name COLLATE "C", id COLLATE "C"`;

const SELECT_NAME_HOLDER = 'SELECT id FROM layout_templates WHERE name = ? AND id <> ?';

const UPSERT = `INSERT INTO layout_templates (id, name, created_at, updated_at, roll_width_mm, layout_json)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    updated_at = EXCLUDED.updated_at,
    roll_width_mm = EXCLUDED.roll_width_mm,
    layout_json = EXCLUDED.layout_json
  RETURNING ${TEMPLATE_COLUMNS}`;

const RENAME = `UPDATE layout_templates SET name = ?, updated_at = ? WHERE id = ?
  RETURNING ${TEMPLATE_COLUMNS}`;

const DELETE_BY_ID = 'DELETE FROM layout_templates WHERE id = ?';

function validateRollWidth(rollWidthMm: number): number {
  if (Number.isFinite(rollWidthMm) && rollWidthMm > 0) {
    return rollWidthMm;
  }
  throw new InvalidLayoutTemplateError('rollWidthMm', 'roll width must be a finite number greater than 0 mm');
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

/** The port returns unchecked rows, so every column is checked before it becomes a template. */
function textColumn(row: DbRow, column: string): string {
  const value = row[column];
  if (typeof value === 'string') {
    return value;
  }
  throw new TypeError(`layout_templates row has no ${column} text`);
}

function rollWidthColumn(row: DbRow): number {
  const { roll_width_mm: value } = row;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  throw new TypeError('layout_templates row roll_width_mm is not a positive number');
}

function layoutColumn(row: DbRow): string {
  const text = textColumn(row, 'layout_json');
  try {
    parseLayoutTemplateJson(text);
  } catch {
    throw new TypeError('layout_templates row layout_json is not a layout document');
  }
  return text;
}

function toSummary(row: DbRow): LayoutTemplateSummary {
  return Object.freeze({
    id: textColumn(row, 'id'),
    name: textColumn(row, 'name'),
    createdAt: textColumn(row, 'created_at'),
    updatedAt: textColumn(row, 'updated_at'),
    rollWidthMm: rollWidthColumn(row),
  });
}

function toTemplate(row: DbRow): LayoutTemplate {
  return Object.freeze({ ...toSummary(row), layoutJson: layoutColumn(row) });
}

export interface PgLayoutTemplateRepositoryOptions {
  /** Clock for `createdAt` and `updatedAt`; defaults to the system clock. */
  readonly now?: () => Date;
}

export class PgLayoutTemplateRepository implements LayoutTemplateRepository {
  private readonly now: () => Date;

  /** The port's database must have PG_MIGRATIONS version 3 applied. */
  constructor(
    private readonly port: DbPort,
    options: PgLayoutTemplateRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  save(template: NewLayoutTemplate): LayoutTemplate {
    const id = validateId(template.id);
    const name = normalizeLayoutTemplateName(template.name);
    const rollWidthMm = validateRollWidth(template.rollWidthMm);
    parseLayoutTemplateJson(template.layoutJson);

    return this.port.transaction(() => {
      this.assertNameFree(name, id);
      const timestamp = this.now().toISOString();
      const row = this.port.query(UPSERT, [id, name, timestamp, timestamp, rollWidthMm, template.layoutJson])[0];
      if (row === undefined) {
        throw new Error(`saving layout template ${id} returned no row`);
      }
      return toTemplate(row);
    });
  }

  get(id: string): LayoutTemplate | undefined {
    const row = this.port.query(SELECT_BY_ID, [id])[0];
    return row ? toTemplate(row) : undefined;
  }

  getByName(name: string): LayoutTemplate | undefined {
    const row = this.port.query(SELECT_BY_NAME, [name.trim()])[0];
    return row ? toTemplate(row) : undefined;
  }

  list(): LayoutTemplateSummary[] {
    return this.port.query(LIST_ALL).map(toSummary);
  }

  delete(id: string): boolean {
    return this.port.exec(DELETE_BY_ID, [id]) > 0;
  }

  rename(id: string, name: string): LayoutTemplate | undefined {
    const normalized = normalizeLayoutTemplateName(name);
    return this.port.transaction(() => {
      this.assertNameFree(normalized, id);
      const row = this.port.query(RENAME, [normalized, this.now().toISOString(), id])[0];
      return row ? toTemplate(row) : undefined;
    });
  }

  /** Throws {@link LayoutTemplateNameConflictError} if a template other than `id` has `name`. */
  private assertNameFree(name: string, id: string): void {
    if (this.port.query(SELECT_NAME_HOLDER, [name, id]).length > 0) {
      throw new LayoutTemplateNameConflictError(name);
    }
  }
}
