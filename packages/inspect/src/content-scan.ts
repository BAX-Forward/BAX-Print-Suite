import { PDFArray, PDFDict, PDFName, PDFStream, type PDFObject } from "pdf-lib";
import { IDENTITY, multiply, type Matrix } from "@bax-print/edits";
import { isDict, isName, parseContentStream, type Operand } from "./content-lexer.js";
import { colorSpaceKey, resolveColorSpace, resolveInlineColorSpace, type ColorSpaceInfo } from "./colorspace.js";
import { boolIn, dictIn, entryIn, nameIn, numberIn, numbersOf, refString, streamBytes } from "./pdf-objects.js";

/**
 * Walks page content (and Form XObjects, recursively) tracking the CTM (ISO 32000-1 §8.3.4)
 * and the text rendering mode, and records what preflight needs: image placements, fonts
 * that show text, colour spaces, graphics states and transparency groups.
 *
 * Not walked: annotation appearances, tiling-pattern cells and Type 3 glyph procedures.
 */

export interface ImagePlacement {
  page: number;
  objectRef?: string;
  /** Resource name, e.g. `Im0`; `inline` for inline images. */
  name: string;
  widthPx: number;
  heightPx: number;
  /** Image space (unit square) → page user space. */
  ctm: Matrix;
  imageMask: boolean;
  inline: boolean;
  softMask: boolean;
}

export interface FontUse {
  key: string;
  resourceName: string;
  objectRef?: string;
  dict?: PDFDict;
  pages: Set<number>;
  /** True when some text was shown in a rendering mode that paints (not 3 or 7). */
  visible: boolean;
}

export interface ColorUse {
  key: string;
  space: ColorSpaceInfo;
  pages: Set<number>;
}

export interface GStateUse {
  key: string;
  objectRef?: string;
  dict: PDFDict;
  pages: Set<number>;
}

export interface TransparencyGroup {
  page: number;
  /** `undefined` for the page's own group. */
  objectRef?: string;
}

export interface ScanResult {
  images: ImagePlacement[];
  fonts: Map<string, FontUse>;
  colors: Map<string, ColorUse>;
  gstates: Map<string, GStateUse>;
  transparencyGroups: TransparencyGroup[];
  problems: { page: number; message: string }[];
}

export function emptyScan(): ScanResult {
  return { images: [], fonts: new Map(), colors: new Map(), gstates: new Map(), transparencyGroups: [], problems: [] };
}

const MAX_FORM_DEPTH = 16;
const INVISIBLE_TEXT_MODES = new Set([3, 7]);
const TEXT_SHOW = new Set(["Tj", "TJ", "'", '"']);

interface FontRef {
  key: string;
  resourceName: string;
  objectRef?: string;
  dict?: PDFDict;
}

interface GraphicsState {
  ctm: Matrix;
  textRender: number;
  font?: FontRef;
}

function matrixOf(operands: readonly Operand[]): Matrix | undefined {
  if (operands.length < 6) return undefined;
  const values = operands.slice(-6);
  return values.every((v): v is number => typeof v === "number" && Number.isFinite(v))
    ? (values as unknown as Matrix)
    : undefined;
}

function matrixFromObject(value: PDFObject | undefined): Matrix | undefined {
  const numbers = numbersOf(value);
  return numbers && numbers.length === 6 ? (numbers as unknown as Matrix) : undefined;
}

function inlineNumber(entries: ReadonlyMap<string, Operand>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = entries.get(key);
    if (typeof value === "number") return value;
  }
  return undefined;
}

class Scanner {
  private readonly result: ScanResult;
  private readonly page: number;

  constructor(result: ScanResult, page: number) {
    this.result = result;
    this.page = page;
  }

  scan(bytes: Uint8Array, resources: PDFDict | undefined, ctm: Matrix, depth: number, active: ReadonlySet<string>): void {
    let state: GraphicsState = { ctm, textRender: 0 };
    const stack: GraphicsState[] = [];
    parseContentStream(bytes, (op, operands) => {
      const first = operands[0];
      switch (op) {
        case "q":
          stack.push(state);
          break;
        case "Q":
          state = stack.pop() ?? state;
          break;
        case "cm": {
          const m = matrixOf(operands);
          if (m) state = { ...state, ctm: multiply(m, state.ctm) };
          break;
        }
        case "Tf":
          if (isName(first)) state = { ...state, font: this.fontRef(resources, first.raw) };
          break;
        case "Tr":
          if (typeof first === "number") state = { ...state, textRender: first };
          break;
        case "gs":
          if (isName(first)) this.recordGState(resources, first.raw);
          break;
        case "cs":
        case "CS":
          if (isName(first)) this.recordColor(resolveColorSpace(PDFName.of(first.raw), resources));
          break;
        case "g":
        case "G":
          this.recordColor({ family: "DeviceGray", colorants: [] });
          break;
        case "rg":
        case "RG":
          this.recordColor({ family: "DeviceRGB", colorants: [] });
          break;
        case "k":
        case "K":
          this.recordColor({ family: "DeviceCMYK", colorants: [] });
          break;
        case "sh":
          if (isName(first)) this.recordShading(resources, first.raw);
          break;
        case "Do":
          if (isName(first)) this.doXObject(resources, first.raw, state.ctm, depth, active);
          break;
        case "BI":
          if (isDict(first)) this.inlineImage(first.entries, resources, state.ctm);
          break;
        default:
          if (TEXT_SHOW.has(op)) this.recordText(state);
      }
    });
  }

  private problem(message: string): void {
    this.result.problems.push({ page: this.page, message });
  }

  private fontRef(resources: PDFDict | undefined, raw: string): FontRef {
    const { raw: stored, value } = entryIn(dictIn(resources, "Font"), raw);
    const objectRef = refString(stored);
    return {
      key: objectRef ?? `page ${this.page}/${raw}`,
      resourceName: raw,
      objectRef,
      dict: value instanceof PDFDict ? value : undefined,
    };
  }

  private recordText(state: GraphicsState): void {
    const font = state.font;
    if (!font) return;
    const existing = this.result.fonts.get(font.key);
    const visible = !INVISIBLE_TEXT_MODES.has(state.textRender);
    if (existing) {
      existing.pages.add(this.page);
      existing.visible ||= visible;
    } else {
      this.result.fonts.set(font.key, { ...font, pages: new Set([this.page]), visible });
    }
  }

  private recordColor(space: ColorSpaceInfo | undefined): void {
    if (!space) return;
    const key = colorSpaceKey(space);
    const existing = this.result.colors.get(key);
    if (existing) existing.pages.add(this.page);
    else this.result.colors.set(key, { key, space, pages: new Set([this.page]) });
  }

  private recordGState(resources: PDFDict | undefined, raw: string): void {
    const { raw: stored, value } = entryIn(dictIn(resources, "ExtGState"), raw);
    if (!(value instanceof PDFDict)) {
      this.problem(`graphics state /${raw} is not defined`);
      return;
    }
    const objectRef = refString(stored);
    const key = objectRef ?? `page ${this.page}/${raw}`;
    const existing = this.result.gstates.get(key);
    if (existing) existing.pages.add(this.page);
    else this.result.gstates.set(key, { key, objectRef, dict: value, pages: new Set([this.page]) });
  }

  private recordShading(resources: PDFDict | undefined, raw: string): void {
    const shading = dictIn(dictIn(resources, "Shading"), raw);
    if (shading) this.recordColor(resolveColorSpace(shading.get(PDFName.of("ColorSpace")), resources));
  }

  private inlineImage(entries: ReadonlyMap<string, Operand>, resources: PDFDict | undefined, ctm: Matrix): void {
    const imageMask = entries.get("IM") === true || entries.get("ImageMask") === true;
    if (!imageMask) this.recordColor(resolveInlineColorSpace(entries.get("CS") ?? entries.get("ColorSpace"), resources));
    this.result.images.push({
      page: this.page,
      name: "inline",
      widthPx: inlineNumber(entries, "W", "Width") ?? 0,
      heightPx: inlineNumber(entries, "H", "Height") ?? 0,
      ctm,
      imageMask,
      inline: true,
      softMask: false,
    });
  }

  private doXObject(resources: PDFDict | undefined, raw: string, ctm: Matrix, depth: number, active: ReadonlySet<string>): void {
    const { raw: stored, value } = entryIn(dictIn(resources, "XObject"), raw);
    if (!(value instanceof PDFStream)) {
      this.problem(`XObject /${raw} is not defined`);
      return;
    }
    const objectRef = refString(stored);
    const dict = value.dict;
    const subtype = nameIn(dict, "Subtype");
    if (subtype === "Image") {
      const imageMask = boolIn(dict, "ImageMask") === true;
      if (!imageMask) this.recordColor(resolveColorSpace(dict.get(PDFName.of("ColorSpace")), resources));
      const softMask = (dict.has(PDFName.of("SMask")) && nameIn(dict, "SMask") !== "None") || (numberIn(dict, "SMaskInData") ?? 0) > 0;
      this.result.images.push({
        page: this.page,
        objectRef,
        name: raw,
        widthPx: numberIn(dict, "Width") ?? 0,
        heightPx: numberIn(dict, "Height") ?? 0,
        ctm,
        imageMask,
        inline: false,
        softMask,
      });
      return;
    }
    if (subtype !== "Form") return;
    if (depth >= MAX_FORM_DEPTH) {
      this.problem(`Form XObject /${raw} is nested deeper than ${MAX_FORM_DEPTH} levels; not inspected`);
      return;
    }
    if (objectRef && active.has(objectRef)) {
      this.problem(`Form XObject ${objectRef} draws itself; recursion stopped`);
      return;
    }
    if (nameIn(dictIn(dict, "Group"), "S") === "Transparency") {
      this.result.transparencyGroups.push({ page: this.page, objectRef });
    }
    let bytes: Uint8Array;
    try {
      bytes = streamBytes(value);
    } catch (error) {
      this.problem(`Form XObject /${raw} could not be decoded: ${(error as Error).message}`);
      return;
    }
    const formResources = dictIn(dict, "Resources") ?? resources;
    const matrix = matrixFromObject(dict.lookup(PDFName.of("Matrix"))) ?? IDENTITY;
    const nextActive = objectRef ? new Set([...active, objectRef]) : active;
    this.scan(bytes, formResources, multiply(matrix, ctm), depth + 1, nextActive);
  }
}

/** Concatenated, decoded page content (`/Contents` may be one stream or an array). */
export function pageContentBytes(contents: PDFObject | undefined): Uint8Array {
  const streams: PDFStream[] = [];
  if (contents instanceof PDFStream) streams.push(contents);
  else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const item = contents.lookup(i);
      if (item instanceof PDFStream) streams.push(item);
    }
  }
  const parts = streams.map(streamBytes);
  const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    out[offset + part.length] = 0x0a;
    offset += part.length + 1;
  }
  return out;
}

/** Scans one page's content into `result`. */
export function scanPageContent(
  result: ScanResult,
  page: number,
  contents: PDFObject | undefined,
  resources: PDFDict | undefined,
): void {
  let bytes: Uint8Array;
  try {
    bytes = pageContentBytes(contents);
  } catch (error) {
    result.problems.push({ page, message: `page content could not be decoded: ${(error as Error).message}` });
    return;
  }
  new Scanner(result, page).scan(bytes, resources, IDENTITY, 0, new Set());
}
