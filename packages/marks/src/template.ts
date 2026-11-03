/**
 * Label template language (Spec 006 FR4): a logic-less, Mustache-compatible
 * subset. `{{field}}`, `{{{field}}}` and `{{&field}}` all insert the raw value
 * (HTML escaping is off: labels are not HTML). `{{! comment }}` is dropped.
 * Sections, partials and delimiter changes are not supported and render empty.
 * Filters follow the field: `{{item.widthMm|mm}}`, `{{job.name | upper}}`.
 */
import { MM_PER_IN } from "./units.js";

/** The documented field list. `meta.<key>` reads job ticket metadata. */
export const TEMPLATE_FIELDS = [
  "job.name",
  "job.id",
  "job.customer",
  "item.widthMm",
  "item.heightMm",
  "copy.index",
  "copy.total",
  "panel.row",
  "panel.col",
  "media.name",
  "device.name",
  "date",
] as const;

export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

export const TEMPLATE_FILTERS = ["upper", "mm", "in"] as const;

export type TemplateValue = string | number | undefined;

export interface TemplateValues {
  readonly fields: Readonly<Partial<Record<TemplateField, TemplateValue>>>;
  readonly meta?: Readonly<Record<string, TemplateValue>>;
}

export interface RenderResult {
  readonly text: string;
  readonly warnings: string[];
}

const TAG = /\{\{\{([^}]*)\}\}\}|\{\{([^}]*)\}\}/g;
const UNSUPPORTED_SIGILS = new Set(["#", "^", "/", ">", "=", "<", "$"]);
const KNOWN_FIELDS = new Set<string>(TEMPLATE_FIELDS);

/** Up to two decimals, no trailing zeros, never exponent notation. */
export function formatNumber(n: number): string {
  const fixed = n.toFixed(2).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed;
}

function toNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function applyFilter(value: string, filter: string, warnings: string[]): string {
  switch (filter) {
    case "upper":
      return value.toUpperCase();
    case "mm":
    case "in": {
      const n = toNumber(value);
      if (n === undefined) {
        if (value !== "") warnings.push(`filter "${filter}" needs a number, got "${value}"`);
        return value;
      }
      return filter === "mm" ? `${formatNumber(n)} mm` : `${formatNumber(n / MM_PER_IN)} in`;
    }
    default:
      warnings.push(`unknown template filter "${filter}"`);
      return value;
  }
}

function lookup(name: string, values: TemplateValues, warnings: string[]): string {
  if (KNOWN_FIELDS.has(name)) {
    const v = values.fields[name as TemplateField];
    return v === undefined ? "" : typeof v === "number" ? formatNumber(v) : v;
  }
  if (name.startsWith("meta.") && name.length > "meta.".length) {
    const v = values.meta?.[name.slice("meta.".length)];
    if (v === undefined) {
      warnings.push(`no job metadata for template field "${name}"`);
      return "";
    }
    return typeof v === "number" ? formatNumber(v) : v;
  }
  warnings.push(`unknown template field "${name}"`);
  return "";
}

function renderTag(body: string, values: TemplateValues, warnings: string[]): string {
  const trimmed = body.trim();
  const sigil = trimmed.charAt(0);
  if (sigil === "!") return "";
  if (UNSUPPORTED_SIGILS.has(sigil)) {
    warnings.push(`unsupported template tag "{{${trimmed}}}"`);
    return "";
  }
  const [name = "", ...filters] = (sigil === "&" ? trimmed.slice(1) : trimmed).split("|").map((s) => s.trim());
  return filters.reduce((acc, f) => applyFilter(acc, f, warnings), lookup(name, values, warnings));
}

export function renderTemplate(template: string, values: TemplateValues): RenderResult {
  const warnings: string[] = [];
  const text = template.replace(TAG, (_m, triple: string | undefined, double: string | undefined) =>
    renderTag(triple ?? double ?? "", values, warnings),
  );
  return { text, warnings: [...new Set(warnings)] };
}
