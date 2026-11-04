import { PDFArray, PDFDict, PDFDocument, PDFNumber, PDFStream, type PDFObject } from "pdf-lib";
import type { JobEdit } from "@bax-print/core";
import { EditError, computeGeometry, type EditedGeometry, type PageSource, type Rect } from "@bax-print/edits";
import { pageSourceOf } from "@bax-print/edits/impose";
import { emptyScan, scanPageContent, type ScanResult } from "./content-scan.js";
import { dictIn, inheritedIn, lookupIn, nameIn, numberIn, rectOf, streamBytes, textOf } from "./pdf-objects.js";

/**
 * Everything the built-in checks read, extracted from the PDF once. Checks are pure
 * functions over this model, so they are cheap to rerun and easy to test.
 */

export const BOX_NAMES = ["MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox"] as const;
export type BoxName = (typeof BOX_NAMES)[number];

/** MediaBox and CropBox are inheritable from the page tree; the others are not (ISO 32000-1 Table 30). */
const INHERITABLE_BOXES: ReadonlySet<BoxName> = new Set(["MediaBox", "CropBox"]);

export interface OutputIntentInfo {
  subtype?: string;
  outputConditionIdentifier?: string;
  hasDestOutputProfile: boolean;
  /** Set for a page-level output intent (PDF 2.0). */
  page?: number;
}

export interface PageModel {
  index: number;
  boxes: Partial<Record<BoxName, Rect>>;
  /** Boxes that are present but not a valid rectangle. */
  invalidBoxes: BoxName[];
  rotate: number;
  userUnit: number;
  /** TrimBox, else MediaBox: the region the job prints from. */
  source?: PageSource;
  /** The job's edit stack applied to `source`. */
  geometry?: EditedGeometry;
  geometryError?: { editIndex: number; message: string };
  transparencyGroup: boolean;
}

export interface PreflightContext {
  edits?: readonly JobEdit[];
  printableWidthMm?: number;
  cutSpotNames?: readonly string[];
}

export interface DocumentModel {
  pageCount: number;
  pages: PageModel[];
  scan: ScanResult;
  /** Effective PDF version: the header, raised by the catalog `/Version` (ISO 32000-1 §7.7.2). */
  pdfVersion?: string;
  info: Record<string, string>;
  xmp?: string;
  outputIntents: OutputIntentInfo[];
  hasTrailerId: boolean;
  encrypted: boolean;
  context: PreflightContext;
}

export class UnreadablePdfError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnreadablePdfError";
  }
}

const MAX_XMP_BYTES = 4 * 1024 * 1024;
const HEADER = /%PDF-(\d+\.\d+)/;

function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

function headerVersion(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return HEADER.exec(head)?.[1];
}

function outputIntentsOf(value: PDFObject | undefined, page?: number): OutputIntentInfo[] {
  if (!(value instanceof PDFArray)) return [];
  const intents: OutputIntentInfo[] = [];
  for (let i = 0; i < value.size(); i++) {
    const intent = value.lookup(i);
    if (!(intent instanceof PDFDict)) continue;
    intents.push({
      subtype: nameIn(intent, "S"),
      outputConditionIdentifier: textOf(lookupIn(intent, "OutputConditionIdentifier")),
      hasDestOutputProfile:
        lookupIn(intent, "DestOutputProfile") instanceof PDFStream || lookupIn(intent, "DestOutputProfileRef") instanceof PDFDict,
      page,
    });
  }
  return intents;
}

function infoOf(value: PDFObject | undefined): Record<string, string> {
  if (!(value instanceof PDFDict)) return {};
  const info: Record<string, string> = {};
  for (const [key] of value.entries()) {
    const text = textOf(value.lookup(key));
    if (text !== undefined) info[key.asString().slice(1)] = text;
  }
  return info;
}

function xmpOf(catalog: PDFDict): string | undefined {
  const metadata = lookupIn(catalog, "Metadata");
  if (!(metadata instanceof PDFStream)) return undefined;
  try {
    const bytes = streamBytes(metadata);
    return bytes.length > MAX_XMP_BYTES ? undefined : new TextDecoder("utf-8").decode(bytes);
  } catch {
    return undefined;
  }
}

function pageBoxes(node: PDFDict): Pick<PageModel, "boxes" | "invalidBoxes"> {
  const boxes: Partial<Record<BoxName, Rect>> = {};
  const invalidBoxes: BoxName[] = [];
  for (const name of BOX_NAMES) {
    const value = INHERITABLE_BOXES.has(name) ? inheritedIn(node, name) : lookupIn(node, name);
    if (value === undefined) continue;
    const rect = rectOf(value);
    if (rect && rect.x1 > rect.x0 && rect.y1 > rect.y0) boxes[name] = rect;
    else invalidBoxes.push(name);
  }
  return { boxes, invalidBoxes };
}

function geometryOf(source: PageSource | undefined, edits: readonly JobEdit[]): Pick<PageModel, "geometry" | "geometryError"> {
  if (!source) return {};
  try {
    return { geometry: computeGeometry(source, edits) };
  } catch (error) {
    if (!(error instanceof EditError)) throw error;
    return { geometryError: { editIndex: error.editIndex, message: error.message } };
  }
}

export async function loadDocumentModel(bytes: Uint8Array, context: PreflightContext = {}): Promise<DocumentModel> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch (error) {
    throw new UnreadablePdfError(`not a readable PDF: ${(error as Error).message}`, { cause: error });
  }
  const edits = context.edits ?? [];
  const scan = emptyScan();
  const pages = doc.getPages().map((page, index): PageModel => {
    const node = page.node;
    let source: PageSource | undefined;
    try {
      source = pageSourceOf(page);
    } catch {
      source = undefined;
    }
    if (!doc.isEncrypted) scanPageContent(scan, index, lookupIn(node, "Contents"), asDict(inheritedIn(node, "Resources")));
    const transparencyGroup = nameIn(dictIn(node, "Group"), "S") === "Transparency";
    if (transparencyGroup) scan.transparencyGroups.push({ page: index });
    const rotate = inheritedIn(node, "Rotate");
    return {
      index,
      ...pageBoxes(node),
      rotate: rotate instanceof PDFNumber ? rotate.asNumber() : 0,
      userUnit: numberIn(node, "UserUnit") ?? 1,
      source,
      ...geometryOf(source, edits),
      transparencyGroup,
    };
  });

  const catalog = doc.catalog;
  const header = headerVersion(bytes);
  const catalogVersion = nameIn(catalog, "Version");
  const pdfVersion =
    header && catalogVersion && /^\d+\.\d+$/.test(catalogVersion) && compareVersions(catalogVersion, header) > 0 ? catalogVersion : header;

  return {
    pageCount: pages.length,
    pages,
    scan,
    pdfVersion,
    info: infoOf(doc.context.lookup(doc.context.trailerInfo.Info)),
    xmp: xmpOf(catalog),
    outputIntents: [
      ...outputIntentsOf(lookupIn(catalog, "OutputIntents")),
      ...doc.getPages().flatMap((page, index) => outputIntentsOf(lookupIn(page.node, "OutputIntents"), index)),
    ],
    hasTrailerId: doc.context.trailerInfo.ID !== undefined,
    encrypted: doc.isEncrypted,
    context,
  };
}

function asDict(value: PDFObject | undefined): PDFDict | undefined {
  return value instanceof PDFDict ? value : undefined;
}

export function versionAtMost(version: string | undefined, max: string): boolean {
  return version !== undefined && compareVersions(version, max) <= 0;
}
