import {
  CHART_HEADER_MM,
  CHART_MARGIN_MM,
  type ChartLayout,
  type ChartPatch,
  STRIP_GAP_MM,
  STRIP_LABEL_MM,
} from './chart.js';

const PT_PER_MM = 72 / 25.4;
/** ISO 32000 implementation limit is 14 400 pt (about 5080 mm) per page side; stay below it. */
export const MAX_PAGE_HEIGHT_MM = 5000;
export const PDF_MEDIA_TYPE = 'application/pdf';

const PROCESS_CMYK = ['cyan', 'magenta', 'yellow', 'black'];

function num(value: number, digits = 3): string {
  const fixed = value.toFixed(digits);
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

/** A PDF literal string limited to printable ASCII, so byte offsets equal string offsets. */
function pdfString(text: string): string {
  const ascii = [...text].map((ch) => (ch >= ' ' && ch <= '~' ? ch : '?')).join('');
  return `(${ascii.replace(/[\\()]/g, (ch) => `\\${ch}`)})`;
}

function isProcessCmyk(colorants: readonly string[]): boolean {
  return colorants.length === 4 && colorants.every((c, i) => c === PROCESS_CMYK[i]);
}

/** Type 4 (PostScript calculator) tint transform: gray = 1 - mean(tints), for previews only. */
function tintTransform(count: number): string {
  const sum = Array<string>(count - 1).fill('add').join(' ');
  return `{ ${sum} ${count} div 1 exch sub }`.replace(/\s+/g, ' ');
}

interface PageSpec {
  heightMm: number;
  content: string;
}

function stripPitch(layout: ChartLayout): number {
  return layout.patchSizeMm + STRIP_GAP_MM;
}

function paginate(layout: ChartLayout): number[][] {
  const pitch = stripPitch(layout);
  const perPage = Math.max(1, Math.floor((MAX_PAGE_HEIGHT_MM - 2 * CHART_MARGIN_MM - CHART_HEADER_MM) / pitch));
  const pages: number[][] = [];
  for (let strip = 1; strip <= layout.strips; strip++) {
    if ((strip - 1) % perPage === 0) pages.push([]);
    pages[pages.length - 1]!.push(strip);
  }
  return pages.length === 0 ? [[]] : pages;
}

function pageContent(layout: ChartLayout, strips: number[], pageIndex: number, pageCount: number, cmyk: boolean): PageSpec {
  const pitch = stripPitch(layout);
  const heightMm = 2 * CHART_MARGIN_MM + CHART_HEADER_MM + strips.length * pitch;
  const heightPt = heightMm * PT_PER_MM;
  const ops: string[] = [];
  const x0 = CHART_MARGIN_MM * PT_PER_MM;
  const title = `${layout.title} - ${layout.chartId} - page ${pageIndex + 1}/${pageCount}`;
  ops.push('0 g', 'BT', '/F1 9 Tf', `${num(x0)} ${num(heightPt - (CHART_MARGIN_MM + 6) * PT_PER_MM)} Td`, `${pdfString(title)} Tj`, 'ET');

  const byStrip = new Map<number, ChartPatch[]>();
  for (const patch of layout.patches) byStrip.set(patch.strip, [...(byStrip.get(patch.strip) ?? []), patch]);
  const size = layout.patchSizeMm * PT_PER_MM;
  if (!cmyk) ops.push('/CS0 cs');

  strips.forEach((strip, row) => {
    const topMm = CHART_MARGIN_MM + CHART_HEADER_MM + row * pitch;
    const y = heightPt - (topMm + layout.patchSizeMm) * PT_PER_MM;
    ops.push('0 g', 'BT', '/F1 6 Tf', `${num(x0)} ${num(y + size / 2 - 2)} Td`, `${pdfString(`S${strip}`)} Tj`, 'ET');
    if (!cmyk) ops.push('/CS0 cs');
    (byStrip.get(strip) ?? []).forEach((patch, column) => {
      const x = (CHART_MARGIN_MM + STRIP_LABEL_MM) * PT_PER_MM + column * size;
      const tints = patch.device.map((v) => num(v, 4)).join(' ');
      ops.push(cmyk ? `${tints} k` : `${tints} scn`, `${num(x)} ${num(y)} ${num(size)} ${num(size)} re f`);
    });
  });
  return { heightMm, content: `${ops.join('\n')}\n` };
}

/**
 * A raw (uncolor-managed) patch chart as PDF (ISO 32000). Process CMYK uses DeviceCMYK; any other
 * ink set uses DeviceN with the colorant ids as names and a gray alternate for on-screen previews.
 * The output is deterministic: no dates, uncompressed streams.
 */
export function chartToPdf(layout: ChartLayout): Uint8Array {
  const cmyk = isProcessCmyk(layout.colorants);
  const pages = paginate(layout);
  const widthPt = layout.pageWidthMm * PT_PER_MM;
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };
  const stream = (dict: string, data: string): string => `<< ${dict} /Length ${data.length} >>\nstream\n${data}endstream`;

  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  let colorSpace = '';
  if (!cmyk) {
    const n = layout.colorants.length;
    const domain = Array.from({ length: n }, () => '0 1').join(' ');
    const fn = add(stream(`/FunctionType 4 /Domain [${domain}] /Range [0 1]`, `${tintTransform(n)}\n`));
    colorSpace = ` /ColorSpace << /CS0 [/DeviceN [${layout.colorants.map((c) => `/${c}`).join(' ')}] /DeviceGray ${fn} 0 R] >>`;
  }
  const kids: number[] = [];
  pages.forEach((strips, index) => {
    const page = pageContent(layout, strips, index, pages.length, cmyk);
    const content = add(stream('', page.content));
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(widthPt)} ${num(page.heightMm * PT_PER_MM)}]` +
          ` /Resources << /Font << /F1 ${font} 0 R >>${colorSpace} >> /Contents ${content} 0 R >>`,
      ),
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Producer (BAX Print Suite) /Title ${pdfString(layout.title)} >>`);

  // Latin-1 throughout: every character is one byte, so string lengths are byte offsets.
  let out = '%PDF-1.6\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
