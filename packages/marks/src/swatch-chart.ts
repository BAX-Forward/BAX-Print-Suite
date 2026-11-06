/**
 * Spot swatch chart (Spec 032a): a printable PDF with one swatch per colour of
 * a spot library. Each swatch is filled through a Separation colour space named
 * after the spot (ISO 32000-2 §8.6.6.4) with a DeviceCMYK alternate taken from
 * the colour's CMYK fallback (all zero when absent), so a RIP sees the real
 * colorant name. Labels and the title use the BPS Stroke font in DeviceGray and
 * never paint in a spot.
 *
 * `planSwatchChart()` is the pure layout. Coordinates are mm in the PDF page
 * frame: origin at the bottom-left corner, y up.
 */
import { PDFDocument, PDFName, type PDFContext, type PDFRef } from "pdf-lib";
import { z } from "zod";
import { MarkSpecError } from "./errors.js";
import { bindResource, childDict } from "./pdf-writer.js";
import { formatIssues } from "./schema.js";
import { fontMetrics, layoutText, normalizeForFont } from "./stroke-font.js";
import { PT_PER_MM, mmToPt } from "./units.js";

/** CIELAB, structurally compatible with the media spot library. */
export interface SwatchLab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

/** CMYK tint percentages, each 0..100. */
export type SwatchCmykPercent = readonly [c: number, m: number, y: number, k: number];

export interface SwatchColor {
  readonly name: string;
  readonly lab: SwatchLab;
  readonly cmykFallback?: SwatchCmykPercent;
}

export interface SwatchLibrary {
  readonly name: string;
  readonly colors: readonly SwatchColor[];
}

/** ISO 32000-1 Annex C limit on the length of a name object, in bytes. */
const MAX_NAME_BYTES = 127;
const LABEL_FONT_PT = 6;
const TITLE_FONT_PT = 10;
const LABEL_LINE_COUNT = 3;
/** Space between a swatch and its first label line. */
const LABEL_PAD_MM = 1;
/** Space between the title line and the first row of swatches. */
const TITLE_GAP_MM = 3;
const OUTLINE_GRAY = 0.5;
const OUTLINE_WIDTH_PT = 0.25;
const CS_RESOURCE = "BPSSpot";
const EPS_MM = 1e-9;

const LABEL_LINE_MM = fontMetrics(LABEL_FONT_PT).lineHeightMm;
const LABEL_BAND_MM = LABEL_PAD_MM + LABEL_LINE_COUNT * LABEL_LINE_MM;
const TITLE_LINE_MM = fontMetrics(TITLE_FONT_PT).lineHeightMm;
const TITLE_BAND_MM = TITLE_LINE_MM + TITLE_GAP_MM;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function num(v: number, digits = 3): string {
  const r = Number(v.toFixed(digits));
  return String(Object.is(r, -0) ? 0 : r);
}

function oneDecimal(v: number): string {
  const s = v.toFixed(1);
  return s === "-0.0" ? "0.0" : s;
}

/** Swatch plus, with labels on, the label band below it. */
function cellHeightMm(o: { readonly swatchSizeMm: number; readonly showLabels: boolean }): number {
  return o.swatchSizeMm + (o.showLabels ? LABEL_BAND_MM : 0);
}

const TextSchema = z
  .string()
  .regex(/^\P{Cc}+$/u, "1 or more characters, no control characters")
  .refine((t) => t.trim().length > 0, "must not be blank");

const SpotNameSchema = TextSchema.refine(
  (t) => utf8(t).length <= MAX_NAME_BYTES,
  `at most ${MAX_NAME_BYTES} UTF-8 bytes (PDF name limit)`,
);

const Percent = z.number().min(0).max(100);

const SwatchLibrarySchema = z.object({
  name: TextSchema,
  colors: z.array(
    z.object({
      name: SpotNameSchema,
      lab: z.object({
        L: z.number().min(0).max(100),
        a: z.number().min(-128).max(127),
        b: z.number().min(-128).max(127),
      }),
      cmykFallback: z.tuple([Percent, Percent, Percent, Percent]).optional(),
    }),
  ),
});

type ParsedLibrary = z.output<typeof SwatchLibrarySchema>;
type ParsedColor = ParsedLibrary["colors"][number];

export const SwatchChartOptionsSchema = z
  .object({
    pageWidthMm: z.number().min(20).max(5000).default(210),
    pageHeightMm: z.number().min(20).max(5000).default(297),
    columns: z.number().int().min(1).max(100).default(6),
    swatchSizeMm: z.number().min(5).max(1000).default(25),
    gapMm: z.number().min(0).max(100).default(5),
    marginMm: z.number().min(0).max(500).default(10),
    showLabels: z.boolean().default(true),
  })
  .superRefine((o, ctx) => {
    const rowWidth = o.columns * o.swatchSizeMm + (o.columns - 1) * o.gapMm;
    const contentWidth = o.pageWidthMm - 2 * o.marginMm;
    if (rowWidth > contentWidth + EPS_MM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns"],
        message: `${o.columns} columns need ${num(rowWidth)} mm but the page has ${num(contentWidth)} mm between the margins`,
      });
    }
    const cellHeight = cellHeightMm(o);
    const contentHeight = o.pageHeightMm - 2 * o.marginMm - TITLE_BAND_MM;
    if (cellHeight > contentHeight + EPS_MM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["swatchSizeMm"],
        message: `a row needs ${num(cellHeight)} mm but the page has ${num(contentHeight)} mm below the title`,
      });
    }
  });

export type SwatchChartOptions = z.output<typeof SwatchChartOptionsSchema>;
export type SwatchChartOptionsInput = z.input<typeof SwatchChartOptionsSchema>;

export function parseSwatchChartOptions(input: unknown): SwatchChartOptions {
  const parsed = SwatchChartOptionsSchema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  throw new MarkSpecError("invalid swatch chart options", formatIssues(parsed.error));
}

function parseSwatchLibrary(input: unknown): ParsedLibrary {
  const parsed = SwatchLibrarySchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new MarkSpecError("invalid swatch library", formatIssues(parsed.error));
}

export interface SwatchCell {
  /** Position of the colour in `library.colors`. */
  readonly index: number;
  readonly name: string;
  /** The swatch square; its labels sit below it. */
  readonly xMm: number;
  readonly yMm: number;
  readonly wMm: number;
  readonly hMm: number;
  /** Spot name, Lab and CMYK fallback; empty when labels are off. */
  readonly labelLines: readonly string[];
}

export interface SwatchPage {
  /** 1-based. */
  readonly pageNumber: number;
  readonly widthMm: number;
  readonly heightMm: number;
  /** `<library name> - page n of N`. */
  readonly title: string;
  /** Bottom-left of the title line. */
  readonly titleXMm: number;
  readonly titleYMm: number;
  /** In library order. */
  readonly cells: readonly SwatchCell[];
}

function labelLines(color: ParsedColor): readonly string[] {
  const { L, a, b } = color.lab;
  const cmyk = color.cmykFallback ? `CMYK ${color.cmykFallback.map((v) => num(v, 1)).join(" ")}` : "CMYK none";
  return Object.freeze([color.name, `Lab ${oneDecimal(L)} ${oneDecimal(a)} ${oneDecimal(b)}`, cmyk]);
}

function layout(library: ParsedLibrary, o: SwatchChartOptions): readonly SwatchPage[] {
  const cellHeight = cellHeightMm(o);
  const contentHeight = o.pageHeightMm - 2 * o.marginMm - TITLE_BAND_MM;
  const rows = Math.max(1, Math.floor((contentHeight + o.gapMm + EPS_MM) / (cellHeight + o.gapMm)));
  const perPage = rows * o.columns;
  const pageCount = Math.max(1, Math.ceil(library.colors.length / perPage));
  const firstRowTop = o.pageHeightMm - o.marginMm - TITLE_BAND_MM;

  const cells = library.colors.map((color, index): SwatchCell => {
    const slot = index % perPage;
    const col = slot % o.columns;
    const row = Math.floor(slot / o.columns);
    return Object.freeze({
      index,
      name: color.name,
      xMm: o.marginMm + col * (o.swatchSizeMm + o.gapMm),
      yMm: firstRowTop - row * (cellHeight + o.gapMm) - o.swatchSizeMm,
      wMm: o.swatchSizeMm,
      hMm: o.swatchSizeMm,
      labelLines: o.showLabels ? labelLines(color) : Object.freeze([]),
    });
  });

  const pages = Array.from({ length: pageCount }, (_, p): SwatchPage =>
    Object.freeze({
      pageNumber: p + 1,
      widthMm: o.pageWidthMm,
      heightMm: o.pageHeightMm,
      title: `${library.name} - page ${p + 1} of ${pageCount}`,
      titleXMm: o.marginMm,
      titleYMm: o.pageHeightMm - o.marginMm - TITLE_LINE_MM,
      cells: Object.freeze(cells.slice(p * perPage, (p + 1) * perPage)),
    }),
  );
  return Object.freeze(pages);
}

/** Lays out the chart; throws MarkSpecError on a bad library or options. */
export function planSwatchChart(library: SwatchLibrary, options: SwatchChartOptionsInput = {}): readonly SwatchPage[] {
  return layout(parseSwatchLibrary(library), parseSwatchChartOptions(options));
}

/**
 * The spot name as pdf-lib name text: one char per UTF-8 byte (ISO 32000-2
 * §7.3.5), with "#" pre-escaped because `PDFName.of` decodes `#xx` sequences.
 */
function pdfNameText(name: string): string {
  return Array.from(utf8(name), (byte) => (byte === 0x23 ? "#23" : String.fromCharCode(byte))).join("");
}

/** `[/Separation /<spot> /DeviceCMYK f]`, f mapping tint 1 to the CMYK fallback. */
function separationSpace(context: PDFContext, color: ParsedColor): PDFRef {
  const [c, m, y, k] = color.cmykFallback ?? [0, 0, 0, 0];
  const tint = context.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0, 0, 0, 0],
    C1: [c / 100, m / 100, y / 100, k / 100],
    N: 1,
  });
  return context.register(
    context.obj([PDFName.of("Separation"), PDFName.of(pdfNameText(color.name)), PDFName.of("DeviceCMYK"), tint]),
  );
}

/** One line of stroke text with its bottom-left at (xMm, yMm), shrunk to fit `maxWidthMm`. */
function textOps(text: string, fontPt: number, maxWidthMm: number, xMm: number, yMm: number): string[] {
  const line = normalizeForFont(text).text;
  const unitWidth = layoutText([line], 1).widthMm;
  const size = unitWidth * fontPt > maxWidthMm ? maxWidthMm / unitWidth : fontPt;
  const block = layoutText([line], size);
  const ops = [`${num(block.strokeWidthMm * PT_PER_MM)} w`];
  for (const polyline of block.polylines) {
    polyline.forEach((p, i) => ops.push(`${num(mmToPt(xMm + p.x))} ${num(mmToPt(yMm + p.y))} ${i === 0 ? "m" : "l"}`));
    ops.push("S");
  }
  return ops;
}

function rectOps(cell: SwatchCell): string {
  return `${num(mmToPt(cell.xMm))} ${num(mmToPt(cell.yMm))} ${num(mmToPt(cell.wMm))} ${num(mmToPt(cell.hMm))} re`;
}

interface Fill {
  readonly cell: SwatchCell;
  /** Page ColorSpace resource name of the cell's Separation. */
  readonly space: string;
}

/** Swatch fills in their spot, then grey outlines, labels and title in DeviceGray. */
function pageContent(page: SwatchPage, fills: readonly Fill[], marginMm: number): string {
  const ops = ["q"];
  for (const { cell, space } of fills) ops.push(`/${space} cs`, "1 scn", rectOps(cell), "f");
  if (page.cells.length > 0) {
    ops.push(`${OUTLINE_GRAY} G`, `${OUTLINE_WIDTH_PT} w`);
    for (const cell of page.cells) ops.push(rectOps(cell), "S");
  }
  ops.push("0 G", "1 J", "1 j");
  for (const cell of page.cells) {
    cell.labelLines.forEach((text, i) => {
      const y = cell.yMm - LABEL_PAD_MM - (i + 1) * LABEL_LINE_MM;
      ops.push(...textOps(text, LABEL_FONT_PT, cell.wMm, cell.xMm, y));
    });
  }
  ops.push(...textOps(page.title, TITLE_FONT_PT, page.widthMm - 2 * marginMm, page.titleXMm, page.titleYMm));
  ops.push("Q");
  return `${ops.join("\n")}\n`;
}

/** Renders the chart as a new PDF; throws MarkSpecError on a bad library or options. */
export async function renderSwatchChart(library: SwatchLibrary, options: SwatchChartOptionsInput = {}): Promise<Uint8Array> {
  const lib = parseSwatchLibrary(library);
  const opts = parseSwatchChartOptions(options);
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(lib.name);
  const context = doc.context;
  const spaces = lib.colors.map((color) => separationSpace(context, color));

  for (const plan of layout(lib, opts)) {
    const page = doc.addPage([mmToPt(plan.widthMm), mmToPt(plan.heightMm)]);
    const resources = page.node.normalizedEntries().Resources;
    const fills = plan.cells.map((cell): Fill => {
      const ref = spaces[cell.index];
      if (ref === undefined) throw new MarkSpecError(`swatch ${cell.index} has no colour space`);
      const colorSpaces = childDict(context, resources, "ColorSpace");
      return { cell, space: bindResource(colorSpaces, `${CS_RESOURCE}${cell.index}`, ref) };
    });
    page.node.addContentStream(context.register(context.flateStream(pageContent(plan, fills, opts.marginMm))));
  }
  return doc.save();
}
