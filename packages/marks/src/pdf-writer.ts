/**
 * Writes a finishing plan into an imposed page (Spec 006 FR2): one optional
 * content group `BPS Marks` (ISO 32000-2 §8.11) registered in the catalog,
 * the marks colorant as a page colour space, custom PDF symbols as Form
 * XObjects, and an appended content stream. Existing page content is wrapped
 * in q/Q so its graphics state cannot leak into the marks.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  type PDFContext,
  type PDFDocument,
  type PDFEmbeddedPage,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import { marksContent, type ColorSetup, type PdfSymbolResource } from "./content.js";
import type { ImposeFrame } from "./layout-types.js";
import type { FinishingPlan } from "./plan-types.js";
import type { Colorant } from "./schema.js";

export const MARKS_OCG_NAME = "BPS Marks";
export const MARKS_SEPARATION_NAME = "BPS-Marks";
/** The PDF colorant that paints on every separation (ISO 32000-2 §8.6.6.4). */
export const REGISTRATION_COLORANT = "All";

const OC_RESOURCE = "BPSMarks";
const CS_RESOURCE = "BPSMarksCS";
const SYMBOL_RESOURCE = "BPSSym";

interface DocState {
  ocg?: PDFRef;
  readonly colorSpaces: Map<Colorant, PDFRef>;
  readonly pdfSymbols: Map<Uint8Array, PDFEmbeddedPage>;
}

const DOC_STATE = new WeakMap<PDFDocument, DocState>();

function docState(doc: PDFDocument): DocState {
  let state = DOC_STATE.get(doc);
  if (!state) {
    state = { colorSpaces: new Map(), pdfSymbols: new Map() };
    DOC_STATE.set(doc, state);
  }
  return state;
}

export function decodePdfText(obj: PDFObject | undefined): string | undefined {
  return obj instanceof PDFString || obj instanceof PDFHexString ? obj.decodeText() : undefined;
}

export function childDict(context: PDFContext, parent: PDFDict, key: string): PDFDict {
  const existing = parent.lookupMaybe(PDFName.of(key), PDFDict);
  if (existing) return existing;
  const dict = PDFDict.withContext(context);
  parent.set(PDFName.of(key), dict);
  return dict;
}

function childArray(context: PDFContext, parent: PDFDict, key: string): PDFArray {
  const existing = parent.lookupMaybe(PDFName.of(key), PDFArray);
  if (existing) return existing;
  const array = PDFArray.withContext(context);
  parent.set(PDFName.of(key), array);
  return array;
}

function findOcgByName(ocgs: PDFArray, name: string): PDFRef | undefined {
  for (let i = 0; i < ocgs.size(); i++) {
    const ref = ocgs.get(i);
    const dict = ocgs.lookupMaybe(i, PDFDict);
    if (ref instanceof PDFRef && dict && decodePdfText(dict.lookup(PDFName.of("Name"))) === name) return ref;
  }
  return undefined;
}

/** The `BPS Marks` OCG, created once per document and visible by default. */
export function ensureMarksOcg(doc: PDFDocument): PDFRef {
  const state = docState(doc);
  if (state.ocg) return state.ocg;
  const context = doc.context;
  const props = childDict(context, doc.catalog, "OCProperties");
  const ocgs = childArray(context, props, "OCGs");
  let ocg = findOcgByName(ocgs, MARKS_OCG_NAME);
  if (!ocg) {
    ocg = context.register(context.obj({ Type: "OCG", Name: PDFString.of(MARKS_OCG_NAME) }));
    ocgs.push(ocg);
    const d = childDict(context, props, "D");
    childArray(context, d, "Order").push(ocg);
    childArray(context, d, "ON").push(ocg);
  }
  state.ocg = ocg;
  return ocg;
}

/** `[/Separation /BPS-Marks /DeviceCMYK f]` (100 % K) or `[/Separation /All /DeviceCMYK f]`. */
function ensureColorSpace(doc: PDFDocument, colorant: Exclude<Colorant, "process-k">): PDFRef {
  const state = docState(doc);
  const cached = state.colorSpaces.get(colorant);
  if (cached) return cached;
  const context = doc.context;
  const tint = context.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0, 0, 0, 0],
    C1: colorant === "separation" ? [0, 0, 0, 1] : [1, 1, 1, 1],
    N: 1,
  });
  const name = colorant === "separation" ? MARKS_SEPARATION_NAME : REGISTRATION_COLORANT;
  const ref = context.register(context.obj(["Separation", name, "DeviceCMYK", tint]));
  state.colorSpaces.set(colorant, ref);
  return ref;
}

/** Binds `ref` under `base`, `base1`, … in `dict`, reusing an existing binding. */
export function bindResource(dict: PDFDict, base: string, ref: PDFRef): string {
  for (let i = 0; ; i++) {
    const name = i === 0 ? base : `${base}${i}`;
    const current = dict.get(PDFName.of(name));
    if (current === undefined) {
      dict.set(PDFName.of(name), ref);
      return name;
    }
    if (current === ref) return name;
  }
}

async function embedPdfSymbols(
  doc: PDFDocument,
  plan: FinishingPlan,
  xobjects: () => PDFDict,
): Promise<Map<string, PdfSymbolResource>> {
  const state = docState(doc);
  const out = new Map<string, PdfSymbolResource>();
  for (const symbol of plan.symbols.values()) {
    if (symbol.type !== "pdf") continue;
    let embedded = state.pdfSymbols.get(symbol.bytes);
    if (!embedded) {
      [embedded] = await doc.embedPdf(symbol.bytes, [0]);
      state.pdfSymbols.set(symbol.bytes, embedded!);
    }
    const name = bindResource(xobjects(), SYMBOL_RESOURCE, embedded!.ref);
    out.set(symbol.id, { name: `/${name}`, widthPt: embedded!.width, heightPt: embedded!.height });
  }
  return out;
}

/**
 * Draws `plan` on `page` in the Spec 003 frame. Returns false when the plan
 * draws nothing (the page is left untouched).
 */
export async function renderPlan(page: PDFPage, frame: ImposeFrame, plan: FinishingPlan): Promise<boolean> {
  if (plan.elements.length === 0) return false;
  const doc = page.doc;
  const context = doc.context;
  const resources = page.node.normalizedEntries().Resources;
  const sub = (key: string) => () => childDict(context, resources, key);

  const pdfSymbols = await embedPdfSymbols(doc, plan, sub("XObject"));
  const ocName = bindResource(sub("Properties")(), OC_RESOURCE, ensureMarksOcg(doc));
  const color: ColorSetup =
    plan.colorant === "process-k"
      ? { kind: "process-k" }
      : { kind: "space", name: bindResource(sub("ColorSpace")(), CS_RESOURCE, ensureColorSpace(doc, plan.colorant)) };

  const content = marksContent(plan.elements, { frame, ocName, color, symbols: plan.symbols, pdfSymbols });
  if (content === "") return false;
  const existing = page.node.normalizedEntries().Contents;
  if (existing && existing.size() > 0) {
    existing.insert(0, context.register(context.stream("q\n")));
    existing.push(context.register(context.stream("\nQ\n")));
  }
  page.node.addContentStream(context.register(context.flateStream(content)));
  return true;
}
