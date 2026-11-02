import { cosSin, formatNumber as num } from "./geometry.js";
import type { Layout, Placement } from "./types.js";

export interface SvgOptions {
  /** Item ids and rotation arrows (default true). */
  labels?: boolean;
  /** Rendered width in pixels (default 800). The viewBox is always in points. */
  widthPx?: number;
}

const DEFAULT_WIDTH_PX = 800;
const MIN_VIEW_PT = 1;
const HATCH_PT = 8;
/** Arrow length and label size relative to the footprint's short side. */
const ARROW_SHARE = 0.25;
const ARROW_HEAD_SHARE = 0.4;
const LABEL_SHARE = 0.12;

const STYLE =
  ".media{fill:#fff;stroke:#333;stroke-width:1}" +
  ".margin{fill:url(#bps-hatch);stroke:none}" +
  ".hatch-line{stroke:#bbb;stroke-width:1}" +
  ".panel-break{stroke:#c00;stroke-width:1;stroke-dasharray:6 4}" +
  ".item{fill:#cfe3f7;stroke:#1f5a96;stroke-width:0.5}" +
  ".label{font-family:sans-serif;fill:#123;text-anchor:middle;dominant-baseline:middle}" +
  ".arrow{stroke:#123;fill:none;stroke-width:1}";

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rect(cls: string, x: number, y: number, w: number, h: number): string {
  return `<rect class="${cls}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"/>`;
}

/**
 * SVG preview of a layout: media, hatched margins, panel breaks and one
 * `<rect class="item">` per placement. Lead edge at the bottom, as in the
 * imposed PDF.
 */
export function toSvg(layout: Layout, opts: SvgOptions = {}): string {
  const labels = opts.labels ?? true;
  const { margins } = layout.media;
  const width = Math.max(MIN_VIEW_PT, layout.mediaWidthPt);
  const height = Math.max(MIN_VIEW_PT, margins.lead + layout.lengthUsedPt + margins.trail);
  const widthPx =
    typeof opts.widthPx === "number" && Number.isFinite(opts.widthPx) && opts.widthPx > 0
      ? opts.widthPx
      : DEFAULT_WIDTH_PX;
  const heightPx = Math.max(1, Math.round((widthPx * height) / width));
  const usableWidth = width - margins.left - margins.right;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(widthPx)}" height="${heightPx}" viewBox="0 0 ${num(width)} ${num(height)}">`,
    `<defs><pattern id="bps-hatch" width="${HATCH_PT}" height="${HATCH_PT}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatch-line" x1="0" y1="0" x2="0" y2="${HATCH_PT}"/></pattern></defs>`,
    `<style>${STYLE}</style>`,
    rect("media", 0, 0, width, height),
  ];

  const marginRects: readonly [number, number, number, number][] = [
    [0, 0, margins.left, height],
    [width - margins.right, 0, margins.right, height],
    [margins.left, height - margins.lead, usableWidth, margins.lead],
    [margins.left, 0, usableWidth, margins.trail],
  ];
  for (const [x, y, w, h] of marginRects) {
    if (w > 0 && h > 0) lines.push(rect("margin", x, y, w, h));
  }

  for (const panel of layout.panels) {
    if (panel.index === 0) continue;
    const y = num(height - margins.lead - panel.offsetPt);
    lines.push(`<line class="panel-break" x1="0" y1="${y}" x2="${num(width)}" y2="${y}"/>`);
  }

  for (const placement of layout.placements) {
    lines.push(placementSvg(placement, margins.left, height - margins.lead, labels));
  }
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

/** `leadY` is the SVG y of the lead edge (nesting y = 0). */
function placementSvg(placement: Placement, left: number, leadY: number, labels: boolean): string {
  const { w, h } = placement.footprint;
  const x = left + placement.xPt;
  const y = leadY - placement.yPt - h;
  const id = escapeXml(placement.itemId);
  const parts = [
    `<g class="placement" data-item="${id}" data-copy="${placement.copy}" data-rotation="${placement.rotation}">`,
    rect("item", x, y, w, h),
  ];
  if (labels) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const short = Math.min(w, h);
    const fontSize = short * LABEL_SHARE;
    parts.push(
      `<text class="label" x="${num(cx)}" y="${num(cy + fontSize)}" font-size="${num(fontSize)}">${id} #${placement.copy + 1}</text>`,
      `<path class="arrow" d="${arrowPath(placement, cx, cy, short)}"/>`,
    );
  }
  parts.push("</g>");
  return parts.join("");
}

/** Arrow from the center along the art's "up" direction (y flipped for SVG). */
function arrowPath(placement: Placement, cx: number, cy: number, short: number): string {
  const [c, s] = cosSin(placement.rotation);
  const dx = -s;
  const dy = -c;
  const length = short * ARROW_SHARE;
  const head = length * ARROW_HEAD_SHARE;
  const tipX = cx + length * dx;
  const tipY = cy + length * dy;
  const backX = tipX - head * dx;
  const backY = tipY - head * dy;
  const px = -dy;
  const py = dx;
  const tip = `${num(tipX)} ${num(tipY)}`;
  return (
    `M${num(cx)} ${num(cy)}L${tip}` +
    `M${num(backX + head * px)} ${num(backY + head * py)}L${tip}L${num(backX - head * px)} ${num(backY - head * py)}`
  );
}
