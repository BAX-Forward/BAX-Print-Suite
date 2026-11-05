// Layered PDF cut file: one optional-content group (ISO 32000-1 §8.11) per cut
// layer plus an optional mark layer with filled circles. No print data: every
// painting operator sits inside a `/OC ... BDC` / `EMC` block. Drawing is done
// in mm through a `cm` scale so the content stream stays readable and stable.

import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import type { CutFrame, Point } from "@bax-print/plugin-sdk";
import { formatCompact, PT_PER_MM, ptToMm } from "./geometry.js";

/** Cubic Bézier circle approximation constant: 4/3 * (sqrt(2) - 1). */
export const BEZIER_CIRCLE_KAPPA = (4 / 3) * (Math.SQRT2 - 1);

/** `cm` scale from mm to pt, printed with 8 decimals. */
export const MM_SCALE_OPERAND = PT_PER_MM.toFixed(8);

export interface PdfCutLayer {
  name: string;
  /** Points in pt, in the frame. */
  paths: { points: Point[]; closed: boolean }[];
}

export interface PdfCutInput {
  frame: CutFrame;
  layers: PdfCutLayer[];
  /** Filled 100% K circles (centers and diameters in pt). */
  markLayer?: { name: string; circles: { xPt: number; yPt: number; dPt: number }[] };
  strokeWidthMm?: number;
}

const n = (pt: number): string => formatCompact(ptToMm(pt), 4);
const mm = (v: number): string => formatCompact(v, 4);

function circleOps(cxPt: number, cyPt: number, dPt: number): string[] {
  const [cx, cy, r] = [ptToMm(cxPt), ptToMm(cyPt), ptToMm(dPt / 2)];
  const k = r * BEZIER_CIRCLE_KAPPA;
  const p = (x: number, y: number): string => `${mm(x)} ${mm(y)}`;
  return [
    `${p(cx + r, cy)} m`,
    `${p(cx + r, cy + k)} ${p(cx + k, cy + r)} ${p(cx, cy + r)} c`,
    `${p(cx - k, cy + r)} ${p(cx - r, cy + k)} ${p(cx - r, cy)} c`,
    `${p(cx - r, cy - k)} ${p(cx - k, cy - r)} ${p(cx, cy - r)} c`,
    `${p(cx + k, cy - r)} ${p(cx + r, cy - k)} ${p(cx + r, cy)} c`,
    "h",
    "f",
  ];
}

/** Property-list names used in the content stream: /L0, /L1, ... in layer order, mark layer last. */
export function layerPropertyNames(input: PdfCutInput): string[] {
  const names = input.layers.map((l) => l.name);
  return input.markLayer && input.markLayer.circles.length > 0 ? [...names, input.markLayer.name] : names;
}

export function buildCutContentStream(input: PdfCutInput): string {
  const strokeWidth = mm(input.strokeWidthMm ?? 0.1);
  const scale = `${MM_SCALE_OPERAND} 0 0 ${MM_SCALE_OPERAND} 0 0 cm`;
  const lines: string[] = [];
  input.layers.forEach((layer, i) => {
    lines.push(`/OC /L${i} BDC`, "q", scale, `${strokeWidth} w`, "0 0 0 RG");
    for (const path of layer.paths) {
      const [first, ...rest] = path.points;
      if (!first || rest.length === 0) continue;
      lines.push(`${n(first[0])} ${n(first[1])} m`, ...rest.map(([x, y]) => `${n(x)} ${n(y)} l`));
      lines.push(...(path.closed ? ["h", "S"] : ["S"]));
    }
    lines.push("Q", "EMC");
  });
  if (input.markLayer && input.markLayer.circles.length > 0) {
    lines.push(`/OC /L${input.layers.length} BDC`, "q", scale, "0 0 0 1 k");
    for (const c of input.markLayer.circles) lines.push(...circleOps(c.xPt, c.yPt, c.dPt));
    lines.push("Q", "EMC");
  }
  return `${lines.join("\n")}\n`;
}

/** Writes a one-page PDF whose content is only the given layers. Deterministic (no dates, no ids). */
export async function writeLayeredCutPdf(input: PdfCutInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([input.frame.widthPt, input.frame.heightPt]);
  const ocgRefs = layerPropertyNames(input).map((name) =>
    doc.context.register(doc.context.obj({ Type: "OCG", Name: PDFString.of(name) })),
  );
  const properties = Object.fromEntries(ocgRefs.map((ref, i) => [`L${i}`, ref]));
  page.node.set(PDFName.of("Resources"), doc.context.obj({ Properties: properties }));
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(buildCutContentStream(input))));
  doc.catalog.set(
    PDFName.of("OCProperties"),
    doc.context.obj({ OCGs: ocgRefs, D: { Order: ocgRefs, ON: ocgRefs } }),
  );
  return doc.save({ useObjectStreams: false });
}
