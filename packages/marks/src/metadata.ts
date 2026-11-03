/**
 * Finishing geometry in the layout metadata (Spec 006 FR7). Spec 003 stores
 * the layout as JSON in the document-info entry `/BPS_Layout`; we merge a
 * `finishing` member into it so cut export and finishing tablets can read
 * every mark and label code. Coordinates are layout-frame millimetres,
 * rounded to 0.1 µm so the JSON is stable.
 */
import { PDFDict, PDFHexString, PDFName, type PDFDocument } from "pdf-lib";
import { applyRect, type Rect } from "./geometry.js";
import { MARKS_OCG_NAME, MARKS_SEPARATION_NAME, REGISTRATION_COLORANT, decodePdfText } from "./pdf-writer.js";
import type { Rotation } from "./layout-types.js";
import type { ElementKind, FinishingPlan, MarkPart } from "./plan-types.js";
import type { Colorant, Edge } from "./schema.js";

export const LAYOUT_INFO_KEY = "BPS_Layout";

export type XY = readonly [number, number];
export type XYXY = readonly [number, number, number, number];

export type PartMetadata =
  | { readonly type: "lines"; readonly segments: XYXY[]; readonly lineWidthMm: number; readonly dashMm?: XY }
  | {
      readonly type: "dots";
      readonly centers: XY[];
      readonly diameterMm: number;
      readonly style: "dot" | "crosshair";
    }
  | {
      readonly type: "symbols";
      readonly symbolId: string;
      readonly widthMm: number;
      readonly heightMm: number;
      readonly instances: { readonly center: XY; readonly rotation: Rotation }[];
    }
  | {
      readonly type: "label";
      readonly edge: Edge;
      readonly bounds: Rect;
      readonly text: string;
      readonly code?: {
        readonly symbology: string;
        readonly payload: string;
        readonly size: number;
        readonly moduleMm: number;
        readonly quietZoneModules: number;
        /** Including the quiet zone. */
        readonly bounds: Rect;
      };
    };

export interface ElementMetadata {
  readonly id: string;
  readonly itemId: string;
  readonly copy: number;
  readonly markId: string;
  readonly kind: ElementKind;
  /** Zero-based page of the imposed PDF. */
  readonly page: number;
  readonly parts: PartMetadata[];
}

export interface FinishingMetadata {
  readonly version: 1;
  readonly units: "mm";
  readonly frame: "layout";
  readonly ocg: string;
  readonly colorant: Colorant;
  /** Separation colorant name, or null for process K. */
  readonly colorantName: string | null;
  readonly elements: ElementMetadata[];
}

const r4 = (v: number): number => {
  const n = Math.round(v * 10000) / 10000;
  return Object.is(n, -0) ? 0 : n;
};
const xy = (x: number, y: number): XY => [r4(x), r4(y)];
const rect = (r: Rect): Rect => ({ x: r4(r.x), y: r4(r.y), w: r4(r.w), h: r4(r.h) });

function partMetadata(part: MarkPart): PartMetadata {
  switch (part.type) {
    case "lines":
      return {
        type: "lines",
        segments: part.segments.map((s) => [r4(s.x1), r4(s.y1), r4(s.x2), r4(s.y2)] as const),
        lineWidthMm: r4(part.lineWidthMm),
        ...(part.dashMm ? { dashMm: xy(part.dashMm[0], part.dashMm[1]) } : {}),
      };
    case "dots":
      return {
        type: "dots",
        centers: part.centers.map((c) => xy(c.x, c.y)),
        diameterMm: r4(part.diameterMm),
        style: part.style,
      };
    case "symbols":
      return {
        type: "symbols",
        symbolId: part.symbolId,
        widthMm: r4(part.widthMm),
        heightMm: r4(part.heightMm),
        instances: part.instances.map((i) => ({ center: xy(i.center.x, i.center.y), rotation: i.rotation })),
      };
    case "label": {
      const code = part.code;
      return {
        type: "label",
        edge: part.edge,
        bounds: rect(applyRect(part.matrix, { x: 0, y: 0, w: part.widthMm, h: part.heightMm })),
        text: part.text,
        ...(code
          ? {
              code: {
                symbology: code.symbology,
                payload: code.payload,
                size: code.size,
                moduleMm: r4(code.moduleMm),
                quietZoneModules: code.quietZoneModules,
                bounds: rect(applyRect(part.matrix, { x: code.origin.x, y: code.origin.y, w: code.sideMm, h: code.sideMm })),
              },
            }
          : {}),
      };
    }
  }
}

function colorantName(colorant: Colorant): string | null {
  if (colorant === "separation") return MARKS_SEPARATION_NAME;
  return colorant === "registration" ? REGISTRATION_COLORANT : null;
}

export function finishingMetadata(plan: FinishingPlan, page = 0): FinishingMetadata {
  return {
    version: 1,
    units: "mm",
    frame: "layout",
    ocg: MARKS_OCG_NAME,
    colorant: plan.colorant,
    colorantName: colorantName(plan.colorant),
    elements: plan.elements.map((el) => ({
      id: el.id,
      itemId: el.itemId,
      copy: el.copy,
      markId: el.markId,
      kind: el.kind,
      page,
      parts: el.parts.map(partMetadata),
    })),
  };
}

export interface LabelCodeRef {
  readonly elementId: string;
  readonly itemId: string;
  readonly copy: number;
  readonly payload: string;
}

/** Label code payloads, e.g. for `CutJob.options.labelCode`. */
export function labelCodes(plan: FinishingPlan): LabelCodeRef[] {
  return plan.elements.flatMap((el) =>
    el.parts.flatMap((p) =>
      p.type === "label" && p.code ? [{ elementId: el.id, itemId: el.itemId, copy: el.copy, payload: p.code.payload }] : [],
    ),
  );
}

function infoDict(doc: PDFDocument, create: boolean): PDFDict | undefined {
  const trailer = doc.context.trailerInfo;
  if (trailer.Info) return doc.context.lookupMaybe(trailer.Info, PDFDict);
  if (!create) return undefined;
  const dict = PDFDict.withContext(doc.context);
  trailer.Info = doc.context.register(dict);
  return dict;
}

/** The parsed `/BPS_Layout` JSON, or undefined when absent or not a JSON object. */
export function readLayoutMetadata(doc: PDFDocument): Record<string, unknown> | undefined {
  const text = decodePdfText(infoDict(doc, false)?.lookup(PDFName.of(LAYOUT_INFO_KEY)));
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function writeLayoutMetadata(doc: PDFDocument, value: Readonly<Record<string, unknown>>): void {
  infoDict(doc, true)!.set(PDFName.of(LAYOUT_INFO_KEY), PDFHexString.fromText(JSON.stringify(value)));
}

function previousElements(layout: Record<string, unknown> | undefined, page: number): ElementMetadata[] {
  const finishing = layout?.finishing as Partial<FinishingMetadata> | undefined;
  const elements = Array.isArray(finishing?.elements) ? finishing.elements : [];
  return elements.filter((e) => e.page !== page);
}

/**
 * Merges the plan into `/BPS_Layout.finishing`, keeping whatever Spec 003 (or
 * an earlier page) wrote. Elements drawn on the same page are replaced.
 */
export function mergeFinishingMetadata(doc: PDFDocument, plan: FinishingPlan, page: number): FinishingMetadata {
  const layout = readLayoutMetadata(doc);
  const fresh = finishingMetadata(plan, page);
  const merged: FinishingMetadata = { ...fresh, elements: [...previousElements(layout, page), ...fresh.elements] };
  writeLayoutMetadata(doc, { ...(layout ?? {}), finishing: merged });
  return merged;
}
