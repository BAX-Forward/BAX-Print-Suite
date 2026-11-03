/**
 * Label preview as SVG (backs `GET /jobs/:id/label-preview.svg`). Draws the
 * same geometry as the PDF: stroke-font text and code modules, in mm.
 */
import type { PanelRef } from "./codes/index.js";
import { MarkSpecError } from "./errors.js";
import { fmt } from "./content.js";
import { planLabel, templateValues } from "./label.js";
import type { JobInfo, LabelPart } from "./plan-types.js";
import { LabelSpecSchema, formatIssues, type LabelSpecInput } from "./schema.js";
import { layoutText } from "./stroke-font.js";

export interface LabelPreviewInput {
  readonly label: LabelSpecInput;
  readonly job: JobInfo;
  readonly item: {
    readonly widthMm: number;
    readonly heightMm: number;
    readonly copy?: number;
    readonly copyTotal?: number;
    readonly panel?: PanelRef;
  };
  /** Rendered width in px; height follows the aspect ratio. Default: size in mm. */
  readonly widthPx?: number;
}

export interface LabelPreview {
  readonly svg: string;
  readonly warnings: string[];
}

const PREVIEW_PAD_MM = 1;

export function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** SVG of a planned label in its own frame (y flipped to SVG's y-down). */
export function labelPartSvg(part: LabelPart, widthPx?: number): string {
  const W = part.widthMm + 2 * PREVIEW_PAD_MM;
  const H = part.heightMm + 2 * PREVIEW_PAD_MM;
  const X = (u: number) => fmt(u + PREVIEW_PAD_MM);
  const Y = (v: number) => fmt(part.heightMm - v + PREVIEW_PAD_MM);
  const body: string[] = [];

  const code = part.code;
  if (code) {
    const m = code.moduleMm;
    const q = code.quietZoneModules;
    const rects: string[] = [];
    code.modules.forEach((row, r) =>
      row.forEach((dark, c) => {
        if (!dark) return;
        const u = code.origin.x + (q + c) * m;
        const vTop = code.origin.y + (q + code.size - r) * m;
        rects.push(`M${X(u)} ${Y(vTop)}h${fmt(m)}v${fmt(m)}h${fmt(-m)}z`);
      }),
    );
    body.push(`<path class="code" fill="#000" d="${rects.join("")}"/>`);
  }

  const block = layoutText(part.lines, part.fontSizePt);
  if (block.polylines.length > 0) {
    const { x: ox, y: oy } = part.textOrigin;
    const d = block.polylines
      .map((line) => line.map((p, i) => `${i === 0 ? "M" : "L"}${X(ox + p.x)} ${Y(oy + p.y)}`).join(""))
      .join("");
    body.push(
      `<path class="text" fill="none" stroke="#000" stroke-width="${fmt(block.strokeWidthMm)}" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`,
    );
  }

  const size = widthPx !== undefined ? ` width="${fmt(widthPx)}" height="${fmt((widthPx * H) / W)}"` : ` width="${fmt(W)}mm" height="${fmt(H)}mm"`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(W)} ${fmt(H)}"${size}>`,
    `<title>${xmlEscape(part.text)}</title>`,
    code ? `<desc>${xmlEscape(code.payload)}</desc>` : "",
    `<rect class="background" width="${fmt(W)}" height="${fmt(H)}" fill="#fff"/>`,
    ...body,
    "</svg>",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function labelPreviewSvg(input: LabelPreviewInput): LabelPreview {
  const parsed = LabelSpecSchema.safeParse(input.label);
  if (!parsed.success) throw new MarkSpecError("invalid label spec", formatIssues(parsed.error));
  const { item, job } = input;
  const copy = item.copy ?? 0;
  const result = planLabel({
    item: { widthMm: item.widthMm, heightMm: item.heightMm, bleedMm: 0 },
    spec: { ...parsed.data, enabled: true },
    values: templateValues(job, {
      widthMm: item.widthMm,
      heightMm: item.heightMm,
      copy,
      copyTotal: item.copyTotal ?? copy + 1,
      panel: item.panel,
    }),
    jobId: job.id,
    panel: item.panel,
  });
  if (!result.value) throw new MarkSpecError("label is empty", result.warnings);
  return { svg: `${labelPartSvg(result.value, input.widthPx)}\n`, warnings: result.warnings };
}
