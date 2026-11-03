/**
 * Plans every mark of a finishing spec for one item, in the item-local trim
 * frame (mm, origin at the trim bottom-left of the unrotated artwork).
 */
import type { PanelRef } from "./codes/index.js";
import { MarkSpecError } from "./errors.js";
import type { ItemBox } from "./geometry.js";
import { grommetPoints } from "./grommets.js";
import { planLabel, templateValues } from "./label.js";
import { cropSegments, customCenters, edgeLineSegments, foldSegments, trimSegments } from "./marks-local.js";
import type { ElementKind, JobInfo, MarkPart } from "./plan-types.js";
import type { Edge, FinishingSpec, MarkSpec } from "./schema.js";
import type { SymbolTable } from "./symbols.js";
import { ptToMm } from "./units.js";

export interface LocalElement {
  readonly markId: string;
  readonly kind: ElementKind;
  readonly parts: readonly MarkPart[];
}

export const LABEL_MARK_ID = "label";

/**
 * Stable ids: an explicit `id`, else the kind when it occurs once, else
 * `<kind>-<n>` numbered in spec order.
 */
export function assignMarkIds(marks: readonly MarkSpec[]): string[] {
  const perKind = new Map<string, number>();
  for (const m of marks) if (m.id === undefined) perKind.set(m.kind, (perKind.get(m.kind) ?? 0) + 1);
  const seenKind = new Map<string, number>();
  const ids = marks.map((m) => {
    if (m.id !== undefined) return m.id;
    const n = (seenKind.get(m.kind) ?? 0) + 1;
    seenKind.set(m.kind, n);
    return perKind.get(m.kind) === 1 ? m.kind : `${m.kind}-${n}`;
  });
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i || id === LABEL_MARK_ID);
  if (duplicates.length > 0) {
    throw new MarkSpecError("mark ids must be unique and not \"label\"", [...new Set(duplicates)]);
  }
  return ids;
}

/** How far from the trim, per edge, crop marks and fold ticks reach. */
export function occupiedOutside(item: ItemBox, marks: readonly MarkSpec[]): Record<Edge, number> {
  const out: Record<Edge, number> = { top: 0, bottom: 0, left: 0, right: 0 };
  const raise = (edges: readonly Edge[], mm: number) => edges.forEach((e) => (out[e] = Math.max(out[e], mm)));
  for (const m of marks) {
    if (m.kind === "crop") raise(["top", "bottom", "left", "right"], Math.max(m.offsetMm, item.bleedMm) + m.lengthMm);
    if (m.kind === "fold-line" && m.ticks) {
      const reach = Math.max(m.tickOffsetMm, item.bleedMm) + m.tickLengthMm;
      raise(m.axis === "vertical" ? ["top", "bottom"] : ["left", "right"], reach);
    }
    if ((m.kind === "hem-line" || m.kind === "sew-line") && m.offsetMm < 0) raise(m.edges, -m.offsetMm);
  }
  return out;
}

function markParts(mark: MarkSpec, item: ItemBox, symbols: SymbolTable, warnings: string[]): MarkPart[] {
  switch (mark.kind) {
    case "crop": {
      const r = cropSegments(item, mark);
      warnings.push(...r.warnings);
      return [{ type: "lines", segments: r.value, lineWidthMm: ptToMm(mark.lineWidthPt) }];
    }
    case "trim-line":
      return [{ type: "lines", segments: trimSegments(item), lineWidthMm: ptToMm(mark.lineWidthPt) }];
    case "grommet": {
      const r = grommetPoints(item.widthMm, item.heightMm, mark.insetMm, mark.spacingMm, mark.edges);
      warnings.push(...r.warnings);
      return [
        {
          type: "dots",
          centers: r.points,
          diameterMm: mark.diameterMm,
          style: mark.style,
          lineWidthMm: ptToMm(mark.lineWidthPt),
        },
      ];
    }
    case "hem-line":
    case "sew-line": {
      const r = edgeLineSegments(item, mark.edges, mark.offsetMm);
      warnings.push(...r.warnings);
      return [{ type: "lines", segments: r.value, lineWidthMm: ptToMm(mark.lineWidthPt), dashMm: mark.dashMm }];
    }
    case "fold-line": {
      const r = foldSegments(item, mark);
      warnings.push(...r.warnings);
      const parts: MarkPart[] = [
        { type: "lines", segments: [r.value.line], lineWidthMm: ptToMm(mark.lineWidthPt), dashMm: mark.dashMm },
      ];
      if (r.value.ticks.length > 0) {
        parts.push({ type: "lines", segments: r.value.ticks, lineWidthMm: ptToMm(mark.tickLineWidthPt) });
      }
      return parts;
    }
    case "custom": {
      const symbol = symbols.get(mark.symbolId);
      if (!symbol) throw new MarkSpecError(`custom mark refers to unknown symbol "${mark.symbolId}"`);
      const heightMm = mark.heightMm ?? mark.widthMm * symbol.aspect;
      const centers = customCenters(item, mark);
      return [
        {
          type: "symbols",
          symbolId: mark.symbolId,
          widthMm: mark.widthMm,
          heightMm,
          instances: centers.map((center) => ({ center, rotation: 0 })),
        },
      ];
    }
  }
}

export interface ItemPlanContext {
  readonly item: ItemBox;
  readonly copy: number;
  readonly copyTotal: number;
  readonly panel?: PanelRef;
  readonly job: JobInfo;
}

export function planItemLocal(
  finishing: FinishingSpec,
  markIds: readonly string[],
  ctx: ItemPlanContext,
  symbols: SymbolTable,
): { elements: LocalElement[]; warnings: string[] } {
  const warnings: string[] = [];
  const elements: LocalElement[] = finishing.marks.map((mark, i) => ({
    markId: markIds[i]!,
    kind: mark.kind,
    parts: markParts(mark, ctx.item, symbols, warnings),
  }));
  if (finishing.label) {
    const label = planLabel({
      item: ctx.item,
      spec: finishing.label,
      values: templateValues(ctx.job, {
        widthMm: ctx.item.widthMm,
        heightMm: ctx.item.heightMm,
        copy: ctx.copy,
        copyTotal: ctx.copyTotal,
        panel: ctx.panel,
      }),
      jobId: ctx.job.id,
      panel: ctx.panel,
      occupiedMm: occupiedOutside(ctx.item, finishing.marks),
    });
    warnings.push(...label.warnings);
    if (label.value) elements.push({ markId: LABEL_MARK_ID, kind: "label", parts: [label.value] });
  }
  return { elements, warnings };
}
