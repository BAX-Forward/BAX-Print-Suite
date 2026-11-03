/**
 * Job label (Spec 006 FR4/FR5): a text block from the template plus an
 * optional 2-D code, placed outside the trim on one edge of the item.
 */
import { DEFAULT_QUIET_ZONE, codePayload, encodeCode, type PanelRef } from "./codes/index.js";
import type { ItemBox, Matrix } from "./geometry.js";
import type { LocalResult } from "./marks-local.js";
import type { JobInfo, LabelCode, LabelPart } from "./plan-types.js";
import type { Edge, LabelSpec } from "./schema.js";
import { layoutText, normalizeForFont } from "./stroke-font.js";
import { renderTemplate, type TemplateValues } from "./template.js";

export interface LabelItemContext {
  readonly widthMm: number;
  readonly heightMm: number;
  /** Zero-based copy number. */
  readonly copy: number;
  readonly copyTotal: number;
  readonly panel?: PanelRef;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The documented template fields for one placement. */
export function templateValues(job: JobInfo, item: LabelItemContext): TemplateValues {
  return {
    fields: {
      "job.name": job.name,
      "job.id": job.id,
      "job.customer": job.customer,
      "item.widthMm": item.widthMm,
      "item.heightMm": item.heightMm,
      "copy.index": item.copy + 1,
      "copy.total": item.copyTotal,
      "panel.row": item.panel?.row,
      "panel.col": item.panel?.col,
      "media.name": job.mediaName,
      "device.name": job.deviceName,
      date: job.date ?? todayIso(),
    },
    meta: job.meta,
  };
}

export interface LabelInput {
  readonly item: ItemBox;
  readonly spec: LabelSpec;
  readonly values: TemplateValues;
  readonly jobId: string;
  readonly panel?: PanelRef;
  /** Per edge, how far from the trim other marks already reach (crop marks, fold ticks). */
  readonly occupiedMm?: Readonly<Partial<Record<Edge, number>>>;
}

function textLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

/** Label frame → item frame for a label of height `h` at distance `d` from the trim. */
function edgeMatrix(edge: Edge, item: ItemBox, u0: number, d: number, h: number): Matrix {
  switch (edge) {
    case "bottom":
      return [1, 0, 0, 1, u0, -d - h];
    case "top":
      return [1, 0, 0, 1, u0, item.heightMm + d];
    case "left":
      return [0, 1, -1, 0, -d, u0];
    case "right":
      return [0, 1, -1, 0, item.widthMm + d + h, u0];
  }
}

export function planLabel(input: LabelInput): LocalResult<LabelPart | undefined> {
  const { item, spec } = input;
  const warnings: string[] = [];
  if (!spec.enabled) return { value: undefined, warnings };

  const rendered = renderTemplate(spec.template, input.values);
  warnings.push(...rendered.warnings);
  const normalized = textLines(rendered.text).map(normalizeForFont);
  const substituted = [...new Set(normalized.flatMap((n) => n.substituted))];
  if (substituted.length > 0) {
    warnings.push(`label font has no glyph for ${substituted.map((c) => JSON.stringify(c)).join(", ")}; printed as "?"`);
  }
  const lines = normalized.map((n) => n.text);
  const block = layoutText(lines, spec.fontSizePt);
  const hasText = block.widthMm > 0;

  let code: LabelCode | undefined;
  if (spec.code.enabled) {
    const payload = codePayload(spec.code, input.jobId, input.panel);
    const matrix = encodeCode(spec.code.symbology, payload);
    const q = spec.code.quietZoneModules ?? DEFAULT_QUIET_ZONE[spec.code.symbology];
    const m = spec.code.moduleMm;
    code = {
      symbology: matrix.symbology,
      payload,
      size: matrix.size,
      moduleMm: m,
      quietZoneModules: q,
      modules: matrix.modules,
      origin: { x: 0, y: 0 },
      sideMm: (matrix.size + 2 * q) * m,
    };
  }
  if (!hasText && !code) {
    warnings.push("label is empty (no text and no code); nothing is printed");
    return { value: undefined, warnings };
  }

  const codeSide = code?.sideMm ?? 0;
  const gap = hasText && code ? spec.gapMm : 0;
  const widthMm = codeSide + gap + block.widthMm;
  const heightMm = Math.max(codeSide, block.heightMm);
  const codeFirst = spec.code.position === "before";
  const codeU = codeFirst ? 0 : block.widthMm + gap;
  const textU = codeFirst ? codeSide + gap : 0;
  if (code) code = { ...code, origin: { x: codeU, y: (heightMm - codeSide) / 2 } };

  const edge = spec.edge;
  const along = edge === "top" || edge === "bottom" ? item.widthMm : item.heightMm;
  const u0 = spec.align === "start" ? 0 : spec.align === "center" ? (along - widthMm) / 2 : along - widthMm;
  const d = Math.max(item.bleedMm, input.occupiedMm?.[edge] ?? 0) + spec.marginMm;

  return {
    value: {
      type: "label",
      edge,
      matrix: edgeMatrix(edge, item, u0, d, heightMm),
      widthMm,
      heightMm,
      text: rendered.text,
      lines,
      fontSizePt: spec.fontSizePt,
      textOrigin: { x: textU, y: (heightMm - block.heightMm) / 2 },
      ...(code ? { code } : {}),
    },
    warnings,
  };
}
