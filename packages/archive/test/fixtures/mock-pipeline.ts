import type { JobTicket } from '@bax-print/core';

/**
 * Mock production pipeline for differential tests. It is our own deterministic stand-in for
 * imposition, cut export and rendering: a single-row step-and-repeat of the finished size,
 * a minimal PDF with page boxes, an SVG cut file in millimetres, and a coarse raster.
 */

export const PT_PER_MM = 72 / 25.4;
export const BOX_NAMES = ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox'] as const;
export type BoxName = (typeof BOX_NAMES)[number];
export type PageBoxes = Readonly<Record<BoxName, readonly number[]>>;
export type Point = readonly [number, number];

interface Layout {
  readonly sheetWidthMm: number;
  readonly sheetHeightMm: number;
  readonly items: readonly { readonly x: number; readonly y: number; readonly w: number; readonly h: number }[];
}

function layoutOf(ticket: JobTicket): Layout {
  const size = ticket.intent.finishedSize;
  if (!size) throw new Error('mock pipeline needs a finished size');
  const params = (ticket.process.layout ?? {}) as { marginMm?: number; gapMm?: number };
  const margin = params.marginMm ?? 0;
  const gap = params.gapMm ?? 0;
  const n = ticket.intent.quantity;
  const items = Array.from({ length: n }, (_, i) => ({
    x: margin + i * (size.widthMm + gap),
    y: margin,
    w: size.widthMm,
    h: size.heightMm,
  }));
  return {
    sheetWidthMm: 2 * margin + n * size.widthMm + (n - 1) * gap,
    sheetHeightMm: 2 * margin + size.heightMm,
    items,
  };
}

const pt = (mm: number): string => (Math.round(mm * PT_PER_MM * 1000) / 1000).toString();

/** A one-page PDF 1.7 with a correct cross-reference table. */
export function imposePdf(ticket: JobTicket): Uint8Array {
  const layout = layoutOf(ticket);
  const media = `[0 0 ${pt(layout.sheetWidthMm)} ${pt(layout.sheetHeightMm)}]`;
  const content = layout.items.map((item) => `${pt(item.x)} ${pt(item.y)} ${pt(item.w)} ${pt(item.h)} re f`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox ${media} /CropBox ${media} /BleedBox ${media} /TrimBox ${media} /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** One closed contour per placed item, in millimetres with the origin at the sheet's lower left. */
export function cutSvg(ticket: JobTicket): Uint8Array {
  const layout = layoutOf(ticket);
  const f = (mm: number): string => mm.toFixed(3);
  const paths = layout.items.map(
    (item) =>
      `  <path d="M ${f(item.x)} ${f(item.y)} L ${f(item.x + item.w)} ${f(item.y)} ` +
      `L ${f(item.x + item.w)} ${f(item.y + item.h)} L ${f(item.x)} ${f(item.y + item.h)} Z"/>`,
  );
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(layout.sheetWidthMm)}mm" height="${f(layout.sheetHeightMm)}mm" ` +
      `viewBox="0 0 ${f(layout.sheetWidthMm)} ${f(layout.sheetHeightMm)}">`,
    ...paths,
    '</svg>',
    '',
  ].join('\n');
  return Buffer.from(svg, 'utf8');
}

export function pageBoxes(pdf: Uint8Array): PageBoxes {
  const text = Buffer.from(pdf).toString('latin1');
  const read = (name: BoxName): number[] => {
    const match = new RegExp(`/${name}\\s*\\[([^\\]]+)\\]`).exec(text);
    const body = match?.[1];
    if (body === undefined) throw new Error(`PDF has no ${name}`);
    return body.trim().split(/\s+/).map(Number);
  };
  return { MediaBox: read('MediaBox'), CropBox: read('CropBox'), BleedBox: read('BleedBox'), TrimBox: read('TrimBox') };
}

/** Closed contours of every `<path>` in the cut file (only M, L and Z are used by the mock). */
export function cutContours(svg: Uint8Array): Point[][] {
  const text = Buffer.from(svg).toString('utf8');
  return [...text.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].map(([, d]) => {
    if (d === undefined) throw new Error('cut path has no d attribute');
    const numbers = d.replace(/[MLZ]/g, ' ').trim().split(/\s+/).map(Number);
    const points: Point[] = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i]!, numbers[i + 1]!]);
    return points;
  });
}

/** Largest point distance in mm between two contour sets, or Infinity if their shape differs. */
export function maxDeviationMm(a: readonly (readonly Point[])[], b: readonly (readonly Point[])[]): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let max = 0;
  for (const [i, contour] of a.entries()) {
    const other = b[i];
    if (!other || contour.length !== other.length) return Number.POSITIVE_INFINITY;
    for (const [j, [x, y]] of contour.entries()) {
      const target = other[j];
      if (!target) return Number.POSITIVE_INFINITY;
      max = Math.max(max, Math.hypot(x - target[0], y - target[1]));
    }
  }
  return max;
}

export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** Rasterizes the filled rectangles of a mock PDF at `dpi` (pixel centres, 0 = ink, 255 = paper). */
export function renderPdf(pdf: Uint8Array, dpi = 18): Raster {
  const text = Buffer.from(pdf).toString('latin1');
  const [, , mediaW, mediaH] = pageBoxes(pdf).MediaBox;
  if (mediaW === undefined || mediaH === undefined) throw new Error('PDF MediaBox needs four numbers');
  const scale = dpi / 72;
  const width = Math.ceil(mediaW * scale);
  const height = Math.ceil(mediaH * scale);
  const pixels = new Uint8Array(width * height).fill(255);
  for (const match of text.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re f/g)) {
    const [x, y, w, h] = match.slice(1, 5).map(Number);
    if (x === undefined || y === undefined || w === undefined || h === undefined) {
      throw new Error('re operator needs four numbers');
    }
    for (let row = 0; row < height; row++) {
      const cy = (row + 0.5) / scale;
      if (cy < y || cy >= y + h) continue;
      for (let col = 0; col < width; col++) {
        const cx = (col + 0.5) / scale;
        if (cx >= x && cx < x + w) pixels[row * width + col] = 0;
      }
    }
  }
  return { width, height, pixels };
}

/** Number of differing pixels; a size mismatch counts every pixel of the larger raster. */
export function pixelDiff(a: Raster, b: Raster): number {
  if (a.width !== b.width || a.height !== b.height) return Math.max(a.pixels.length, b.pixels.length);
  let diff = 0;
  for (let i = 0; i < a.pixels.length; i++) if (a.pixels[i] !== b.pixels[i]) diff++;
  return diff;
}
