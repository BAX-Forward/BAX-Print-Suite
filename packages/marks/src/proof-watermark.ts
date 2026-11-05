/**
 * Proof watermark (Spec 003z): stamps a diagonal "PROOF" (or caller text) on
 * every page of a PDF, centred on the page's trim box and drawn with the BPS
 * Stroke font at reduced opacity through an ExtGState (/CA and /ca,
 * ISO 32000-2 §8.4.5). Existing page content is wrapped in q/Q so its
 * graphics state cannot leak into the watermark. The input bytes are not
 * modified; a new PDF is returned.
 */
import { PDFDocument, type PDFPage, type PDFRef } from "pdf-lib";
import { z } from "zod";
import { MarkSpecError } from "./errors.js";
import type { Point } from "./geometry.js";
import { bindResource, childDict } from "./pdf-writer.js";
import { formatIssues } from "./schema.js";
import { layoutText } from "./stroke-font.js";
import { PT_PER_MM } from "./units.js";

export const PROOF_WATERMARK_TEXT = "PROOF";
/** Auto-fit fills this fraction of the trim box along the tighter axis. */
const AUTO_FIT_FILL = 0.9;
const GS_RESOURCE = "BPSProof";

export const ProofWatermarkSchema = z.object({
  text: z
    .string()
    .regex(/^[\x20-\x7E]{1,64}$/, "text: 1-64 printable ASCII characters")
    .refine((t) => t.trim() !== "", "text must not be blank")
    .default(PROOF_WATERMARK_TEXT),
  opacity: z.number().min(0.05).max(0.9).default(0.25),
  /** Counter-clockwise from the page's x axis. */
  angleDeg: z.number().min(-360).max(360).default(45),
  /** `auto` fits the rotated text inside the trim box. */
  fontSizePt: z.union([z.literal("auto"), z.number().min(1).max(2000)]).default("auto"),
});

export type ProofWatermark = z.output<typeof ProofWatermarkSchema>;
export type ProofWatermarkInput = z.input<typeof ProofWatermarkSchema>;

export function parseProofWatermark(input: unknown): ProofWatermark {
  const parsed = ProofWatermarkSchema.safeParse(input ?? {});
  if (!parsed.success) throw new MarkSpecError("invalid proof watermark options", formatIssues(parsed.error));
  return parsed.data;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Glyphs {
  /** Polylines in pt, placed so that their ink box after rotation is centred on the origin. */
  readonly polylines: readonly (readonly Point[])[];
  readonly strokeWidthPt: number;
  /** Ink extent along the page axes after rotation, including the round-capped stroke. */
  readonly widthPt: number;
  readonly heightPt: number;
}

function glyphsPt(text: string, fontSizePt: number, angleRad: number): Glyphs {
  const block = layoutText([text], fontSizePt);
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const points = block.polylines.flat().map((p) => ({ x: p.x * PT_PER_MM, y: p.y * PT_PER_MM }));
  const xs = points.map((p) => p.x * c - p.y * s);
  const ys = points.map((p) => p.x * s + p.y * c);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  // Centre of the rotated ink box, rotated back into the glyph frame.
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  const cx = mx * c + my * s;
  const cy = -mx * s + my * c;
  const strokeWidthPt = block.strokeWidthMm * PT_PER_MM;
  return {
    polylines: block.polylines.map((line) => line.map((p) => ({ x: p.x * PT_PER_MM - cx, y: p.y * PT_PER_MM - cy }))),
    strokeWidthPt,
    widthPt: maxX - minX + strokeWidthPt,
    heightPt: maxY - minY + strokeWidthPt,
  };
}

/** Glyph extent is linear in the font size, so measure at 1 pt and scale. */
function autoFitSize(text: string, angleRad: number, trim: Box): number {
  const unit = glyphsPt(text, 1, angleRad);
  return AUTO_FIT_FILL * Math.min(trim.width / unit.widthPt, trim.height / unit.heightPt);
}

function num(v: number, digits = 3): string {
  const r = Number(v.toFixed(digits));
  return String(Object.is(r, -0) ? 0 : r);
}

/** Clipped to the trim box; 100 % K round-capped strokes rotated about the trim centre. */
function watermarkContent(glyphs: Glyphs, gsName: string, angleRad: number, trim: Box): string {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const ops = [
    "q",
    `/${gsName} gs`,
    `${num(trim.x)} ${num(trim.y)} ${num(trim.width)} ${num(trim.height)} re W n`,
    "0 0 0 1 K",
    `${num(glyphs.strokeWidthPt)} w`,
    "1 J",
    "1 j",
    `${num(c, 6)} ${num(s, 6)} ${num(-s, 6)} ${num(c, 6)} ${num(trim.x + trim.width / 2)} ${num(trim.y + trim.height / 2)} cm`,
  ];
  for (const line of glyphs.polylines) {
    line.forEach((p, i) => ops.push(`${num(p.x)} ${num(p.y)} ${i === 0 ? "m" : "l"}`));
    ops.push("S");
  }
  ops.push("Q");
  return `${ops.join("\n")}\n`;
}

function stampPage(page: PDFPage, index: number, gs: PDFRef, opts: ProofWatermark): void {
  const trim = page.getTrimBox();
  if (!(trim.width > 0 && trim.height > 0)) throw new MarkSpecError(`page ${index + 1} has an empty trim box`);
  const context = page.doc.context;
  const resources = page.node.normalizedEntries().Resources;
  const gsName = bindResource(childDict(context, resources, "ExtGState"), GS_RESOURCE, gs);
  const angleRad = (opts.angleDeg * Math.PI) / 180;
  const size = opts.fontSizePt === "auto" ? autoFitSize(opts.text, angleRad, trim) : opts.fontSizePt;
  const content = watermarkContent(glyphsPt(opts.text, size, angleRad), gsName, angleRad, trim);

  // normalizedEntries() above already wrapped any existing content in q/Q:
  // pdf-lib's page leaves normalize with autoNormalizeCTM on by default.
  page.node.addContentStream(context.register(context.flateStream(content)));
}

/** Returns a copy of `pdf` with the watermark on every page; throws MarkSpecError on bad options or input. */
export async function proofWatermark(pdf: Uint8Array, options: ProofWatermarkInput = {}): Promise<Uint8Array> {
  const opts = parseProofWatermark(options);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf);
  } catch (err) {
    throw new MarkSpecError("proof watermark input is not a readable PDF", [String(err)]);
  }
  const gs = doc.context.register(doc.context.obj({ Type: "ExtGState", CA: opts.opacity, ca: opts.opacity }));
  doc.getPages().forEach((page, i) => stampPage(page, i, gs, opts));
  return doc.save();
}
