import type { Static, TObject } from "@sinclair/typebox";
import type { SeverityOrOff } from "@bax-print/plugin-sdk";
import { ptToMm, type Rect } from "@bax-print/edits";
import type { DocumentModel } from "./document-model.js";

/**
 * A preflight check: a pure function over the document model that emits findings tagged
 * with a rule id. The evaluator turns rules into severities using the profile's mapping,
 * falling back to each rule's default.
 */

export interface RuleSpec {
  defaultSeverity: SeverityOrOff;
  description: string;
}

export interface RawFinding {
  rule: string;
  page?: number;
  objectRef?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface PreflightCheck<S extends TObject = TObject> {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly rules: Readonly<Record<string, RuleSpec>>;
  /** JSON Schema of `params`, with defaults. */
  readonly params: S;
  /** Cross-field validation after the schema check. */
  validateParams?(params: Static<S>): string[];
  run(doc: DocumentModel, params: Static<S>): RawFinding[];
}

export type AnyCheck = PreflightCheck<TObject>;

export function defineCheck<S extends TObject>(check: PreflightCheck<S>): AnyCheck {
  return check as unknown as AnyCheck;
}

export function formatMm(pt: number): string {
  return `${ptToMm(pt).toFixed(1)} mm`;
}

export function formatSize(widthPt: number, heightPt: number): string {
  return `${ptToMm(widthPt).toFixed(1)} × ${ptToMm(heightPt).toFixed(1)} mm`;
}

export function formatRect(r: Rect): string {
  return `[${[r.x0, r.y0, r.x1, r.y1].map((v) => Number(v.toFixed(2))).join(" ")}]`;
}

/** "page 1" or "pages 1, 3, 4" from zero-based indices. */
export function formatPages(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b).map((p) => p + 1);
  return sorted.length === 1 ? `page ${sorted[0]}` : `pages ${sorted.join(", ")}`;
}

export function sortedPages(pages: Iterable<number>): number[] {
  return [...new Set(pages)].sort((a, b) => a - b);
}
