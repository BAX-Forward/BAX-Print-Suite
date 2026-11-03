import type { Box } from '../src/api/types';

/**
 * Builds small, valid PDFs for the mock `GET /jobs/:id/file`. Each page is vector art only (no
 * fonts), so pdf.js renders it without extra resources and thumbnails are never blank.
 */

export interface PdfPageSpec {
  widthPt: number;
  heightPt: number;
  trimBox?: Box | null;
}

/** Fill colors (RGB 0–1) cycled per page so pages are easy to tell apart. */
const PALETTE: readonly [number, number, number][] = [
  [0.05, 0.36, 0.68],
  [0.84, 0.33, 0.1],
  [0.11, 0.42, 0.21],
  [0.55, 0.16, 0.55],
];

const INSET_RATIO = 0.08;
const STROKE_RATIO = 0.01;
const MARKER_RATIO = 0.06;

const num = (value: number) => Number(value.toFixed(2)).toString();

function pageContent(page: PdfPageSpec, pageNumber: number): string {
  const { widthPt: w, heightPt: h } = page;
  const [r, g, b] = PALETTE[(pageNumber - 1) % PALETTE.length];
  const inset = Math.min(w, h) * INSET_RATIO;
  const stroke = Math.max(1, Math.min(w, h) * STROKE_RATIO);
  const marker = Math.min(w, h) * MARKER_RATIO;
  const ops = [
    `1 1 1 rg 0 0 ${num(w)} ${num(h)} re f`,
    `${r} ${g} ${b} rg ${num(inset)} ${num(inset)} ${num(w - 2 * inset)} ${num(h - 2 * inset)} re f`,
    `0.1 0.1 0.1 RG ${num(stroke)} w`,
    `${num(inset)} ${num(inset)} m ${num(w - inset)} ${num(h - inset)} l S`,
    `${num(inset)} ${num(h - inset)} m ${num(w - inset)} ${num(inset)} l S`,
    '1 1 0.2 rg',
  ];
  // One square per page number, top left, so page order is visible in the preview.
  for (let i = 0; i < pageNumber; i += 1) {
    const x = inset * 1.5 + i * marker * 1.5;
    ops.push(`${num(x)} ${num(h - inset * 1.5 - marker)} ${num(marker)} ${num(marker)} re f`);
  }
  return ops.join('\n');
}

function trimBoxEntry(trim: Box | null | undefined): string {
  if (!trim) return '';
  return ` /TrimBox [${num(trim.x)} ${num(trim.y)} ${num(trim.x + trim.width)} ${num(trim.y + trim.height)}]`;
}

export function buildFixturePdf(pages: readonly PdfPageSpec[]): Uint8Array {
  // Object 1: catalog, 2: page tree, then a page object and its content stream per page.
  const pageObject = (i: number) => 3 + i * 2;
  const bodies: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObject(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ];
  pages.forEach((page, i) => {
    const content = pageContent(page, i + 1);
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.widthPt)} ${num(page.heightPt)}]` +
        `${trimBoxEntry(page.trimBox)} /Resources << >> /Contents ${pageObject(i) + 1} 0 R >>`,
    );
    bodies.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  // Everything is ASCII, so string length equals byte length for the xref offsets.
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
