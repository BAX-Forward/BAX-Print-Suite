/**
 * Builds the marks content stream (ISO 32000-2 §8): one marked-content
 * sequence tagged with the `BPS Marks` optional content group, in the marks
 * colorant, drawn in layout-frame millimetres through a single `cm`.
 * Labels carry their text as `/ActualText` so it stays searchable.
 */
import { chain, translate, type Matrix, type Point } from "./geometry.js";
import type { ImposeFrame, Rotation } from "./layout-types.js";
import type { DotsPart, LabelPart, LinesPart, MarkPart, PlannedElement, SymbolsPart } from "./plan-types.js";
import { pdfTextString } from "./pdf-string.js";
import { layoutText } from "./stroke-font.js";
import type { PathCommand, SvgSymbol } from "./svg-symbol.js";
import type { SymbolTable } from "./symbols.js";
import { PT_PER_MM } from "./units.js";

const KAPPA = 0.5522847498307936;

/** Fixed four decimals, trailing zeros dropped, never exponent notation. */
export function fmt(v: number): string {
  const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

const nums = (...vs: readonly number[]) => vs.map(fmt).join(" ");
const matrixOp = (m: Matrix) => `${nums(...m)} cm`;

export type ColorSetup = { readonly kind: "space"; readonly name: string } | { readonly kind: "process-k" };

export interface PdfSymbolResource {
  /** XObject resource name, with the leading slash. */
  readonly name: string;
  readonly widthPt: number;
  readonly heightPt: number;
}

export interface ContentOptions {
  readonly frame: ImposeFrame;
  /** Properties resource name of the OCG, without the slash. */
  readonly ocName: string;
  readonly color: ColorSetup;
  readonly symbols: SymbolTable;
  readonly pdfSymbols: ReadonlyMap<string, PdfSymbolResource>;
}

function colorOps(color: ColorSetup): string {
  return color.kind === "process-k" ? "0 0 0 1 k 0 0 0 1 K" : `/${color.name} cs /${color.name} CS 1 scn 1 SCN`;
}

function circle(c: Point, r: number): string {
  const k = r * KAPPA;
  return [
    `${nums(c.x + r, c.y)} m`,
    `${nums(c.x + r, c.y + k, c.x + k, c.y + r, c.x, c.y + r)} c`,
    `${nums(c.x - k, c.y + r, c.x - r, c.y + k, c.x - r, c.y)} c`,
    `${nums(c.x - r, c.y - k, c.x - k, c.y - r, c.x, c.y - r)} c`,
    `${nums(c.x + k, c.y - r, c.x + r, c.y - k, c.x + r, c.y)} c`,
    "h",
  ].join("\n");
}

function linesOps(part: LinesPart): string[] {
  const dash = part.dashMm ? `[${nums(...part.dashMm)}] 0 d` : "[] 0 d";
  return [
    `${fmt(part.lineWidthMm)} w 0 J 0 j ${dash}`,
    ...part.segments.map((s) => `${nums(s.x1, s.y1)} m ${nums(s.x2, s.y2)} l`),
    "S",
  ];
}

function dotsOps(part: DotsPart): string[] {
  const r = part.diameterMm / 2;
  if (part.style === "dot") return [...part.centers.map((c) => circle(c, r)), "f"];
  return [
    `${fmt(part.lineWidthMm)} w 0 J 0 j [] 0 d`,
    ...part.centers.map(
      (c) => `${circle(c, r)}\n${nums(c.x - r, c.y)} m ${nums(c.x + r, c.y)} l\n${nums(c.x, c.y - r)} m ${nums(c.x, c.y + r)} l`,
    ),
    "S",
  ];
}

function rotationMatrix(r: Rotation): Matrix {
  switch (r) {
    case 0:
      return [1, 0, 0, 1, 0, 0];
    case 90:
      return [0, 1, -1, 0, 0, 0];
    case 180:
      return [-1, 0, 0, -1, 0, 0];
    case 270:
      return [0, -1, 1, 0, 0, 0];
  }
}

function pathOps(commands: readonly PathCommand[]): string {
  return commands
    .map((c) => {
      switch (c.op) {
        case "M":
          return `${nums(c.x, c.y)} m`;
        case "L":
          return `${nums(c.x, c.y)} l`;
        case "C":
          return `${nums(c.x1, c.y1, c.x2, c.y2, c.x, c.y)} c`;
        case "Z":
          return "h";
      }
    })
    .join("\n");
}

function svgOps(symbol: SvgSymbol): string[] {
  return symbol.shapes.map((s) => {
    const paint = s.fill && s.stroke ? "B" : s.fill ? "f" : s.stroke ? "S" : "n";
    const width = s.stroke ? `${fmt(s.strokeWidth)} w 0 J 0 j [] 0 d\n` : "";
    return `${width}${pathOps(s.commands)}\n${paint}`;
  });
}

function symbolsOps(part: SymbolsPart, opts: ContentOptions): string[] {
  const symbol = opts.symbols.get(part.symbolId);
  if (!symbol) return [];
  const W = part.widthMm;
  const H = part.heightMm;
  let local: Matrix;
  let body: string[];
  if (symbol.type === "svg") {
    const vb = symbol.symbol.viewBox;
    const sx = W / vb.w;
    const sy = H / vb.h;
    local = [sx, 0, 0, -sy, -vb.x * sx - W / 2, H / 2 + vb.y * sy];
    body = svgOps(symbol.symbol);
  } else {
    const res = opts.pdfSymbols.get(part.symbolId);
    if (!res) return [];
    local = [W / res.widthPt, 0, 0, H / res.heightPt, -W / 2, -H / 2];
    body = [`${res.name} Do`];
  }
  return part.instances.flatMap((i) => [
    "q",
    matrixOp(chain(local, rotationMatrix(i.rotation), translate(i.center.x, i.center.y))),
    ...body,
    "Q",
  ]);
}

/** Dark modules as horizontal runs, one rectangle per run. */
function codeOps(part: LabelPart): string[] {
  const code = part.code;
  if (!code) return [];
  const m = code.moduleMm;
  const q = code.quietZoneModules;
  const rects: string[] = [];
  code.modules.forEach((row, r) => {
    const y = code.origin.y + (q + code.size - 1 - r) * m;
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < row.length && row[c]) c++;
      rects.push(`${nums(code.origin.x + (q + start) * m, y, (c - start) * m, m)} re`);
    }
  });
  return rects.length > 0 ? [...rects, "f"] : [];
}

function textOps(part: LabelPart): string[] {
  const block = layoutText(part.lines, part.fontSizePt);
  if (block.polylines.length === 0) return [];
  const { x: ox, y: oy } = part.textOrigin;
  return [
    `${fmt(block.strokeWidthMm)} w 1 J 1 j [] 0 d`,
    ...block.polylines.map((line) =>
      line.map((p, i) => `${nums(ox + p.x, oy + p.y)} ${i === 0 ? "m" : "l"}`).join(" "),
    ),
    "S",
  ];
}

function labelOps(part: LabelPart): string[] {
  return [
    `/Span << /ActualText ${pdfTextString(part.text)} >> BDC`,
    "q",
    matrixOp(part.matrix),
    ...codeOps(part),
    ...textOps(part),
    "Q",
    "EMC",
  ];
}

function partOps(part: MarkPart, opts: ContentOptions): string[] {
  switch (part.type) {
    case "lines":
      return linesOps(part);
    case "dots":
      return dotsOps(part);
    case "symbols":
      return symbolsOps(part, opts);
    case "label":
      return labelOps(part);
  }
}

/** The complete content stream for `elements`, or "" when there is nothing to draw. */
export function marksContent(elements: readonly PlannedElement[], opts: ContentOptions): string {
  const body = elements.flatMap((el) => el.parts.flatMap((p) => partOps(p, opts)));
  if (body.length === 0) return "";
  const k = PT_PER_MM * opts.frame.scale;
  return [
    `/OC /${opts.ocName} BDC`,
    "q",
    matrixOp([k, 0, 0, k, opts.frame.originX, opts.frame.originY]),
    colorOps(opts.color),
    ...body,
    "Q",
    "EMC",
    "",
  ].join("\n");
}
