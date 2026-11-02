import {
  concatTransformationMatrix,
  drawObject,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObjectCopier,
  PDFPage,
  PDFRef,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  type PDFEmbeddedPage,
  type PDFObject,
} from "pdf-lib";
import { cosSin } from "./geometry.js";
import { layoutToJson } from "./layout.js";
import type { Layout, Panel, Placement } from "./types.js";

export type SourceBox = "trim" | "bleed";

/** Where an item's art comes from. `box` is the page box that matches the item's trim or bleed size. */
export interface ImposeSource {
  readonly pdfBytes: Uint8Array;
  readonly pageIndex: number;
  readonly box: SourceBox;
}

/** Maps nesting coordinates to page space: page = origin + scale × (x, y). */
export interface Frame {
  readonly originX: number;
  readonly originY: number;
  readonly scale: number;
}

export interface MarksContext {
  readonly page: PDFPage;
  readonly layout: Layout;
  readonly frame: Frame;
  /** The `Layout.panels` index shown on this page. */
  readonly panel: number;
}

export type ImposeWarningCode =
  | "missing-source"
  | "unreadable-source"
  | "page-out-of-range"
  | "box-mismatch"
  | "output-intent-conflict";

export interface ImposeWarning {
  readonly code: ImposeWarningCode;
  readonly message: string;
  readonly itemId?: string;
}

export interface ImposeOptions {
  /** Called once per page after placements are drawn, in the nesting frame. Spec 004 draws cut marks here. */
  marks?: (ctx: MarksContext) => void | Promise<void>;
  /** Receives each warning as it happens (the server turns these into events). */
  onWarning?: (warning: ImposeWarning) => void;
}

export interface ImposedPage {
  readonly panel: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly frame: Frame;
}

/** JSON stored under `/BPS_Layout` in the output's document info dictionary. */
export interface LayoutMetadata {
  readonly version: number;
  readonly layout: Omit<Layout, "elapsedMs">;
  readonly pages: readonly ImposedPage[];
  readonly warnings: readonly ImposeWarning[];
}

export type Matrix = readonly [number, number, number, number, number, number];

export const LAYOUT_INFO_KEY = "BPS_Layout";
export const LAYOUT_METADATA_VERSION = 1;

const PRODUCER = "BAX Print Suite (@bax-print/nest)";
/** Allowed difference between the source box and the footprint before warning. */
const BOX_TOLERANCE_PT = 0.5;
const MIN_PAGE_PT = 1;
/** Page entries that are not needed for embedding (and may pull in the whole donor page tree). */
const DROPPED_PAGE_KEYS = ["Annots", "B", "Thumb", "PieceInfo", "Metadata", "AA", "StructParents"];
const INTENT_KEYS = ["S", "OutputConditionIdentifier", "RegistryName", "Info"];

interface LoadedSource {
  readonly doc: PDFDocument;
  readonly copier: PDFObjectCopier;
}

interface Art {
  readonly embedded: PDFEmbeddedPage;
  readonly group: PDFObject | undefined;
}

/** Panels drawn as pages (an empty layout still produces one page). */
export function pagePanels(layout: Layout): readonly Panel[] {
  return layout.panels.length > 0 ? layout.panels : [{ index: 0, offsetPt: 0, lengthPt: 0 }];
}

/** Lead edge at the bottom of the page, x across the roll from the left margin. */
export function panelFrame(layout: Layout, panel: Panel): Frame {
  const { margins } = layout.media;
  return { originX: margins.left, originY: margins.lead - panel.offsetPt, scale: 1 };
}

export function panelPageSize(layout: Layout, panel: Panel): { widthPt: number; heightPt: number } {
  const { margins } = layout.media;
  return {
    widthPt: Math.max(MIN_PAGE_PT, layout.mediaWidthPt),
    heightPt: Math.max(MIN_PAGE_PT, margins.lead + panel.lengthPt + margins.trail),
  };
}

/** Footprint before rotation, i.e. the art size. */
export function artSize(placement: Placement): { w: number; h: number } {
  const turned = placement.rotation === 90 || placement.rotation === 270;
  const { w, h } = placement.footprint;
  return turned ? { w: h, h: w } : { w, h };
}

/** Maps art space ([0, w] × [0, h], unrotated) onto the placement's footprint on the page. */
export function placementMatrix(placement: Placement, frame: Frame): Matrix {
  const [c, s] = cosSin(placement.rotation);
  const { w, h } = artSize(placement);
  const corners: readonly (readonly [number, number])[] = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ];
  const minX = Math.min(...corners.map(([u, v]) => c * u - s * v));
  const minY = Math.min(...corners.map(([u, v]) => s * u + c * v));
  const k = frame.scale;
  return [
    c * k,
    s * k,
    -s * k,
    c * k,
    frame.originX + k * (placement.xPt - minX),
    frame.originY + k * (placement.yPt - minY),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolve(doc: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  return value instanceof PDFRef ? doc.context.lookup(value) : value;
}

function lookupDict(doc: PDFDocument, value: PDFObject | undefined): PDFDict | undefined {
  const resolved = resolve(doc, value);
  return resolved instanceof PDFDict ? resolved : undefined;
}

function arrayItems(doc: PDFDocument, value: PDFObject | undefined): PDFObject[] {
  const resolved = resolve(doc, value);
  return resolved instanceof PDFArray ? resolved.asArray() : [];
}

/**
 * Imposes a layout into a PDF: one page per panel, each placement embedded as a
 * Form XObject clipped to its footprint (trim + bleed). Spot colors, DeviceN,
 * optional content and transparency groups travel with the form resources.
 * Annotations are dropped, and a source page's /Rotate is not applied.
 */
export async function impose(
  layout: Layout,
  sources: ReadonlyMap<string, ImposeSource>,
  opts: ImposeOptions = {},
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setProducer(PRODUCER);
  out.setCreator(PRODUCER);

  const warnings: ImposeWarning[] = [];
  const warn = (warning: ImposeWarning): void => {
    warnings.push(warning);
    opts.onWarning?.(warning);
  };

  const loaded = new Map<Uint8Array, LoadedSource | null>();
  const used: LoadedSource[] = [];
  const arts = new Map<string, Art | null>();

  const loadSource = async (bytes: Uint8Array, itemId: string): Promise<LoadedSource | undefined> => {
    const cached = loaded.get(bytes);
    if (cached !== undefined) return cached ?? undefined;
    try {
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const source = { doc, copier: PDFObjectCopier.for(doc.context, out.context) };
      loaded.set(bytes, source);
      return source;
    } catch (error) {
      loaded.set(bytes, null);
      warn({ code: "unreadable-source", itemId, message: `item ${itemId}: cannot read source PDF (${errorMessage(error)})` });
      return undefined;
    }
  };

  const embedArt = async (placement: Placement): Promise<Art | undefined> => {
    const { itemId } = placement;
    const source = sources.get(itemId);
    if (!source) {
      warn({ code: "missing-source", itemId, message: `item ${itemId}: no source PDF, placement left blank` });
      return undefined;
    }
    const loadedSource = await loadSource(source.pdfBytes, itemId);
    if (!loadedSource) return undefined;
    const { doc, copier } = loadedSource;
    const index = source.pageIndex;
    if (!Number.isInteger(index) || index < 0 || index >= doc.getPageCount()) {
      warn({ code: "page-out-of-range", itemId, message: `item ${itemId}: source has no page index ${index}` });
      return undefined;
    }
    try {
      const node = doc.getPage(index).node.clone();
      for (const key of DROPPED_PAGE_KEYS) node.delete(PDFName.of(key));
      const page = PDFPage.of(copier.copy(node), out.context.nextRef(), out);
      if (!page.node.Contents()) {
        // pdf-lib would only fail later, in save(); a blank page has nothing to draw.
        warn({ code: "unreadable-source", itemId, message: `item ${itemId}: source page has no content` });
        return undefined;
      }
      const size = artSize(placement);
      const box = source.box === "bleed" ? page.getBleedBox() : page.getTrimBox();
      if (!boxMatches(source.box, box, size)) {
        warn({
          code: "box-mismatch",
          itemId,
          message:
            `item ${itemId}: ${source.box} box ${box.width}×${box.height} pt does not match ` +
            `footprint ${size.w}×${size.h} pt; art is centered and clipped`,
        });
      }
      // Footprint-sized box centered on the source box: for "trim" this is trim + bleed.
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const embedded = await out.embedPage(page, {
        left: cx - size.w / 2,
        bottom: cy - size.h / 2,
        right: cx + size.w / 2,
        top: cy + size.h / 2,
      });
      if (!used.includes(loadedSource)) used.push(loadedSource);
      return { embedded, group: page.node.get(PDFName.of("Group")) };
    } catch (error) {
      warn({ code: "unreadable-source", itemId, message: `item ${itemId}: cannot embed page (${errorMessage(error)})` });
      return undefined;
    }
  };

  const artFor = async (placement: Placement): Promise<Art | undefined> => {
    const cached = arts.get(placement.itemId);
    if (cached !== undefined) return cached ?? undefined;
    const art = await embedArt(placement);
    arts.set(placement.itemId, art ?? null);
    return art;
  };

  const pages: ImposedPage[] = [];
  for (const panel of pagePanels(layout)) {
    const size = panelPageSize(layout, panel);
    const page = out.addPage([size.widthPt, size.heightPt]);
    const frame = panelFrame(layout, panel);
    const names = new Map<string, PDFName>();
    for (const placement of layout.placements) {
      if (placement.panel !== panel.index) continue;
      const art = await artFor(placement);
      if (!art) continue;
      let name = names.get(placement.itemId);
      if (!name) {
        name = page.node.newXObject("BpsArt", art.embedded.ref);
        names.set(placement.itemId, name);
      }
      if (art.group && !page.node.has(PDFName.of("Group"))) page.node.set(PDFName.of("Group"), art.group);
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(...placementMatrix(placement, frame)),
        drawObject(name),
        popGraphicsState(),
      );
    }
    if (opts.marks) await opts.marks({ page, layout, frame, panel: panel.index });
    pages.push({ panel: panel.index, ...size, frame });
  }

  mergeOptionalContent(out, used);
  copyOutputIntent(out, used, warn);
  const layoutJson = JSON.parse(layoutToJson(layout)) as Omit<Layout, "elapsedMs">;
  writeMetadata(out, { version: LAYOUT_METADATA_VERSION, layout: layoutJson, pages, warnings });
  return out.save({ useObjectStreams: false });
}

function boxMatches(
  kind: SourceBox,
  box: { width: number; height: number },
  size: { w: number; h: number },
): boolean {
  const dw = size.w - box.width;
  const dh = size.h - box.height;
  if (kind === "bleed") return Math.abs(dw) <= BOX_TOLERANCE_PT && Math.abs(dh) <= BOX_TOLERANCE_PT;
  // Trim: the footprint adds the same bleed on every side.
  return dw >= -BOX_TOLERANCE_PT && dh >= -BOX_TOLERANCE_PT && Math.abs(dw - dh) <= 2 * BOX_TOLERANCE_PT;
}

function pushUnique(list: PDFObject[], keys: Set<string>, value: PDFObject): void {
  const key = value.toString();
  if (keys.has(key)) return;
  keys.add(key);
  list.push(value);
}

/** Registers every used source's optional content groups in the output catalog. */
function mergeOptionalContent(out: PDFDocument, sources: readonly LoadedSource[]): void {
  const groups: PDFObject[] = [];
  const off: PDFObject[] = [];
  const groupKeys = new Set<string>();
  const offKeys = new Set<string>();
  for (const { doc, copier } of sources) {
    const properties = lookupDict(doc, doc.catalog.get(PDFName.of("OCProperties")));
    if (!properties) continue;
    for (const group of arrayItems(doc, properties.get(PDFName.of("OCGs")))) {
      pushUnique(groups, groupKeys, copier.copy(group));
    }
    const config = lookupDict(doc, properties.get(PDFName.of("D")));
    for (const group of arrayItems(doc, config?.get(PDFName.of("OFF")))) {
      pushUnique(off, offKeys, copier.copy(group));
    }
  }
  if (groups.length === 0) return;
  const { context } = out;
  const config = context.obj({ Order: context.obj(groups), OFF: context.obj(off) });
  out.catalog.set(PDFName.of("OCProperties"), context.obj({ OCGs: context.obj(groups), D: config }));
}

function intentSignature(doc: PDFDocument): string | undefined {
  const intents = arrayItems(doc, doc.catalog.get(PDFName.of("OutputIntents")));
  if (intents.length === 0) return undefined;
  return intents
    .map((intent) => {
      const dict = lookupDict(doc, intent);
      return INTENT_KEYS.map((key) => dict?.get(PDFName.of(key))?.toString() ?? "").join("|");
    })
    .join(";");
}

/** Copies the first source's OutputIntents and warns when sources disagree. */
function copyOutputIntent(
  out: PDFDocument,
  sources: readonly LoadedSource[],
  warn: (warning: ImposeWarning) => void,
): void {
  const withIntent = sources.flatMap((source) => {
    const signature = intentSignature(source.doc);
    return signature === undefined ? [] : [{ source, signature }];
  });
  const first = withIntent[0];
  if (!first) return;
  const raw = first.source.doc.catalog.get(PDFName.of("OutputIntents"));
  if (raw) out.catalog.set(PDFName.of("OutputIntents"), first.source.copier.copy(raw));
  if (withIntent.some((entry) => entry.signature !== first.signature)) {
    warn({
      code: "output-intent-conflict",
      message: "sources have different OutputIntents; the first source's OutputIntent was copied",
    });
  }
}

function writeMetadata(out: PDFDocument, metadata: LayoutMetadata): void {
  const { context } = out;
  const existing = context.lookup(context.trailerInfo.Info);
  let info: PDFDict;
  if (existing instanceof PDFDict) {
    info = existing;
  } else {
    info = context.obj({});
    context.trailerInfo.Info = context.register(info);
  }
  info.set(PDFName.of(LAYOUT_INFO_KEY), PDFHexString.fromText(JSON.stringify(metadata)));
}

function isLayoutMetadata(value: unknown): value is LayoutMetadata {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { version?: unknown; layout?: unknown; pages?: unknown; warnings?: unknown };
  const layout = candidate.layout as { placements?: unknown } | null | undefined;
  return (
    typeof candidate.version === "number" &&
    typeof layout === "object" &&
    layout !== null &&
    Array.isArray(layout.placements) &&
    Array.isArray(candidate.pages) &&
    Array.isArray(candidate.warnings)
  );
}

/** Reads `/BPS_Layout` back from an imposed PDF. Undefined if absent or malformed. */
export async function readLayoutMetadata(pdfBytes: Uint8Array): Promise<LayoutMetadata | undefined> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch {
    return undefined;
  }
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (!(info instanceof PDFDict)) return undefined;
  const raw = info.lookup(PDFName.of(LAYOUT_INFO_KEY));
  if (!(raw instanceof PDFHexString || raw instanceof PDFString)) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw.decodeText());
    return isLayoutMetadata(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
