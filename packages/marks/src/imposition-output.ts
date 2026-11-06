/**
 * Imposed sheets (Spec 036d): a Spec 036a n-up or booklet plan rendered with
 * the real source pages, one PDF page per sheet side. Each filled slot places
 * its source page (the TrimBox, falling back to CropBox then MediaBox) as a
 * Form XObject (ISO 32000-2 §8.10), scaled to fit the slot with its aspect
 * kept and centred, under an explicit clipping path to the slot (§8.5.4).
 * A booklet page is shifted towards the spine by its sheet's creep. BLANK
 * slots stay empty. With `proofMarks` the Spec 036c proof drawing is laid on
 * top and the page keeps the proof's border; without it the MediaBox is the
 * sheet. Nothing is rasterized, so vector content and spot colours survive.
 *
 * The slot geometry is the Spec 036c layout, so coordinates match the proof.
 */
import { PDFDocument, type PDFEmbeddedPage, type PDFPage } from "pdf-lib";
import { z } from "zod";
import { MarkSpecError } from "./errors.js";
import {
  MAX_PROOF_SIDES,
  parseImpositionProofOptions,
  parsePlan,
  planImpositionProof,
  sideContent,
  type ImpositionProofOptionsInput,
  type ImpositionProofPlan,
  type ImpositionProofRect,
  type ImpositionProofSide,
  type ParsedPlan,
} from "./imposition-proof.js";
import { formatIssues } from "./schema.js";

/** Largest source PDF accepted, checked before the bytes are parsed. */
export const MAX_SOURCE_PDF_BYTES = 256 * 1024 * 1024;

/** Most pages a source PDF may have, checked before any page is embedded. */
export const MAX_SOURCE_PAGES = 10_000;

export type ImposedSheetsErrorCode =
  | "SOURCE_PDF_TOO_LARGE"
  | "SOURCE_PDF_ENCRYPTED"
  | "SOURCE_PDF_INVALID"
  | "SOURCE_PDF_TOO_MANY_PAGES"
  | "PLAN_PAGE_OUT_OF_RANGE"
  | "PLAN_TOO_MANY_SIDES";

/** A rejected source PDF or plan, with a stable code. */
export class ImposedSheetsError extends MarkSpecError {
  readonly code: ImposedSheetsErrorCode;

  constructor(code: ImposedSheetsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type ImposedSheetsOptions = ImpositionProofOptionsInput & {
  /** Draw the Spec 036c proof marks and labels over the content. Default false. */
  readonly proofMarks?: boolean;
};

type Matrix = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

/** Form space = source page user space; the slot matrix below does the placement. */
const IDENTITY: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
const TITLE = "Imposed sheets";
const PRODUCER = "BAX Print Suite";
const XOBJECT_TAG = "SourcePage";
/** Enough precision for a scale factor applied across a whole sheet. */
const MATRIX_DIGITS = 6;
const TRIG_EPS = 1e-12;

const ProofMarksSchema = z.object({ proofMarks: z.boolean().default(false) });

function parseProofMarks(input: unknown): boolean {
  const parsed = ProofMarksSchema.safeParse(input ?? {});
  if (parsed.success) return parsed.data.proofMarks;
  throw new MarkSpecError("invalid imposed sheet options", formatIssues(parsed.error));
}

interface SourceForm {
  readonly form: PDFEmbeddedPage;
  /** Placed box in source page space. */
  readonly box: ImpositionProofRect;
  /** The page's /Rotate, degrees clockwise. */
  readonly rotate: number;
}

function fmt(v: number): string {
  const r = Number(v.toFixed(MATRIX_DIGITS));
  return String(Object.is(r, -0) ? 0 : r);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function assertSourceSize(bytes: Uint8Array): void {
  if (bytes.byteLength <= MAX_SOURCE_PDF_BYTES) return;
  throw new ImposedSheetsError(
    "SOURCE_PDF_TOO_LARGE",
    `source PDF is ${bytes.byteLength} bytes, more than the limit of ${MAX_SOURCE_PDF_BYTES}`,
  );
}

const ENCRYPTED_MESSAGE = "source PDF is encrypted; decrypt it before imposing";

async function loadSource(bytes: Uint8Array): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    // Loaded without `ignoreEncryption`, so pdf-lib itself refuses an encrypted file. It is
    // compiled to ES5, so `instanceof EncryptedPDFError` never matches; its message is checked.
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (isEncryptedError(e)) throw new ImposedSheetsError("SOURCE_PDF_ENCRYPTED", ENCRYPTED_MESSAGE);
    throw new ImposedSheetsError("SOURCE_PDF_INVALID", `source PDF could not be read: ${errorText(e)}`);
  }
  // Defence in depth: never impose a document pdf-lib reports as encrypted.
  if (doc.isEncrypted) throw new ImposedSheetsError("SOURCE_PDF_ENCRYPTED", ENCRYPTED_MESSAGE);
  return doc;
}

function isEncryptedError(e: unknown): boolean {
  return e instanceof Error && /\bis encrypted\b/i.test(e.message);
}

function sourcePageCount(doc: PDFDocument): number {
  let count: number;
  try {
    count = doc.getPageCount();
  } catch (e) {
    throw new ImposedSheetsError("SOURCE_PDF_INVALID", `source PDF page tree could not be read: ${errorText(e)}`);
  }
  if (count <= MAX_SOURCE_PAGES) return count;
  throw new ImposedSheetsError(
    "SOURCE_PDF_TOO_MANY_PAGES",
    `source PDF has ${count} pages, more than the limit of ${MAX_SOURCE_PAGES}`,
  );
}

/** Page numbers in plan order, blanks left out. */
function planPages(plan: ParsedPlan): number[] {
  const slots = plan.kind === "n-up" ? plan.plan.sheets.flatMap((s) => s.pages) : plan.plan.sheets.flatMap((s) => [...s.front, ...s.back]);
  return slots.filter((p): p is number => typeof p === "number");
}

function assertPagesInRange(pages: readonly number[], pageCount: number): void {
  const outside = pages.find((p) => p > pageCount);
  if (outside === undefined) return;
  throw new ImposedSheetsError("PLAN_PAGE_OUT_OF_RANGE", `plan places page ${outside} but the source PDF has ${pageCount} pages`);
}

function assertSideCount(plan: ParsedPlan): void {
  const sides = plan.kind === "n-up" ? plan.plan.sheets.length : 2 * plan.plan.sheets.length;
  if (sides <= MAX_PROOF_SIDES) return;
  throw new ImposedSheetsError("PLAN_TOO_MANY_SIDES", `imposition plan has ${sides} sheet sides, more than the limit of ${MAX_PROOF_SIDES}`);
}

async function embedForm(out: PDFDocument, page: PDFPage, pageNumber: number): Promise<SourceForm> {
  const trim = page.getTrimBox();
  if (trim.width > 0 && trim.height > 0) {
    // The embedder needs a content stream; a blank source page may have none.
    if (page.node.Contents() === undefined) page.node.addContentStream(out.context.register(out.context.flateStream("")));
    const box = { x: trim.x, y: trim.y, width: trim.width, height: trim.height };
    const form = await out.embedPage(page, { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height }, IDENTITY);
    return { form, box, rotate: page.getRotation().angle };
  }
  throw new ImposedSheetsError("SOURCE_PDF_INVALID", `source page ${pageNumber} has an empty page box`);
}

/** Each distinct source page is copied and embedded once, in page order, however many slots show it. */
async function embedSourcePages(out: PDFDocument, source: PDFDocument, pages: readonly number[]): Promise<ReadonlyMap<number, SourceForm>> {
  const used = [...new Set(pages)].sort((a, b) => a - b);
  const forms = new Map<number, SourceForm>();
  try {
    // Copy first so the embedded page and its resources live in the output document.
    const copied = await out.copyPages(source, used.map((p) => p - 1));
    for (const [i, page] of copied.entries()) {
      const pageNumber = used[i];
      if (pageNumber === undefined) continue;
      forms.set(pageNumber, await embedForm(out, page, pageNumber));
    }
  } catch (e) {
    if (e instanceof ImposedSheetsError) throw e;
    throw new ImposedSheetsError("SOURCE_PDF_INVALID", `source pages could not be embedded: ${errorText(e)}`);
  }
  return forms;
}

/** Cosine and sine with the round-off at quarter turns removed. */
function turn(degrees: number): readonly [cos: number, sin: number] {
  const rad = (degrees * Math.PI) / 180;
  const snap = (v: number): number => (Math.abs(v) < TRIG_EPS ? 0 : v);
  return [snap(Math.cos(rad)), snap(Math.sin(rad))];
}

interface SlotPlacement {
  /** Degrees counter-clockwise. */
  readonly rotation: number;
  /** Points, positive to the right. */
  readonly shiftX: number;
}

/** n-up: the placement's rotation. Booklet: creep moves both pages towards the spine. */
function slotPlacement(plan: ParsedPlan, side: ImpositionProofSide, slot: number): SlotPlacement {
  if (plan.kind === "n-up") return { rotation: plan.plan.placements[slot]?.rotation ?? 0, shiftX: 0 };
  const creep = plan.plan.sheets[side.sheetIndex]?.creep ?? 0;
  return { rotation: 0, shiftX: slot === 0 ? creep : -creep };
}

/** Source box centre to slot centre, rotated, and scaled so the rotated box fits the slot. */
function fitMatrix(src: SourceForm, slot: ImpositionProofRect, placement: SlotPlacement): Matrix {
  const [cos, sin] = turn(placement.rotation - src.rotate);
  const { x, y, width: w, height: h } = src.box;
  const fitWidth = w * Math.abs(cos) + h * Math.abs(sin);
  const fitHeight = w * Math.abs(sin) + h * Math.abs(cos);
  const s = Math.min(slot.width / fitWidth, slot.height / fitHeight);
  const [a, b, c, d] = [s * cos, s * sin, -s * sin, s * cos];
  const [px, py] = [x + w / 2, y + h / 2];
  const cx = slot.x + slot.width / 2 + placement.shiftX;
  const cy = slot.y + slot.height / 2;
  return [a, b, c, d, cx - a * px - c * py, cy - b * px - d * py];
}

function slotOps(name: string, clipBox: ImpositionProofRect, m: Matrix): string[] {
  return [
    "q",
    `${fmt(clipBox.x)} ${fmt(clipBox.y)} ${fmt(clipBox.width)} ${fmt(clipBox.height)} re`,
    "W n",
    `${m.map(fmt).join(" ")} cm`,
    `${name} Do`,
    "Q",
  ];
}

function addStream(out: PDFDocument, page: PDFPage, text: string): void {
  page.node.addContentStream(out.context.register(out.context.flateStream(text)));
}

function drawSide(out: PDFDocument, side: ImpositionProofSide, plan: ParsedPlan, forms: ReadonlyMap<number, SourceForm>, proofMarks: boolean): void {
  const page = out.addPage([side.widthPt, side.heightPt]);
  const { sheet } = side;
  if (proofMarks) {
    page.setTrimBox(sheet.x, sheet.y, sheet.width, sheet.height);
  } else {
    page.setMediaBox(sheet.x, sheet.y, sheet.width, sheet.height);
  }
  const names = new Map<number, string>();
  const ops = side.slots.flatMap((slot, k) => {
    if (slot.page === "blank") return [];
    const src = forms.get(slot.page);
    if (src === undefined) throw new MarkSpecError(`page ${slot.page} was not embedded`);
    const name = names.get(slot.page) ?? page.node.newXObject(XOBJECT_TAG, src.form.ref).asString();
    names.set(slot.page, name);
    return slotOps(name, slot.frame, fitMatrix(src, slot.frame, slotPlacement(plan, side, k)));
  });
  if (ops.length > 0) addStream(out, page, `${ops.join("\n")}\n`);
  if (proofMarks) addStream(out, page, sideContent(side));
}

/**
 * Renders the plan with the pages of `sourcePdf`, one PDF page per sheet side.
 * Checks, in order: the byte size (before any parsing), encryption and
 * readability, the source page count (before embedding), plan page numbers
 * against it, and the side count; each failure is an ImposedSheetsError with
 * a code. A malformed plan or options throw MarkSpecError. Deterministic: no
 * dates or ids are written and the producer is fixed.
 */
export async function renderImposedSheets(
  plan: ImpositionProofPlan,
  sourcePdf: Uint8Array,
  options: ImposedSheetsOptions = {},
): Promise<Uint8Array> {
  assertSourceSize(sourcePdf);
  const parsed = parsePlan(plan);
  parseImpositionProofOptions(options);
  const proofMarks = parseProofMarks(options);
  const source = await loadSource(sourcePdf);
  const pageCount = sourcePageCount(source);
  const pages = planPages(parsed);
  assertPagesInRange(pages, pageCount);
  assertSideCount(parsed);
  const sides = planImpositionProof(plan, options);

  const out = await PDFDocument.create({ updateMetadata: false });
  out.setTitle(TITLE);
  out.setProducer(PRODUCER);
  out.setCreator(PRODUCER);
  const forms = await embedSourcePages(out, source, pages);
  for (const side of sides) drawSide(out, side, parsed, forms, proofMarks);
  return out.save();
}
