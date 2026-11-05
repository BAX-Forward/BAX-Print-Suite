/**
 * @bax-print/marks — finishing marks and job labels (Spec 006).
 *
 * Entry points: `draw()` / `marksHook()` for the Spec 003 `opts.marks` hook,
 * `planFinishing()` for geometry without a PDF, `reserveSpace()` for the
 * Spec 003 margin reservation, presets, and the label preview SVG.
 */
export * from "./schema.js";
export { MarkCollisionError, MarkSpecError, type Collision } from "./errors.js";
export * from "./layout-types.js";
export type { Matrix, Point, Rect, Segment } from "./geometry.js";
export { PT_PER_MM, MM_PER_PT, mmToPt, ptToMm } from "./units.js";

export { distributeAlongEdge, grommetPoints, type GrommetLayout } from "./grommets.js";
export { TEMPLATE_FIELDS, TEMPLATE_FILTERS, renderTemplate, type TemplateField, type TemplateValues, type RenderResult } from "./template.js";
export { pdfLiteralString, pdfHexTextString, pdfTextString } from "./pdf-string.js";
export { codePayload, encodeCode, DEFAULT_QUIET_ZONE, type CodeMatrix, type PanelRef, type Symbology } from "./codes/index.js";
export { encodeDataMatrix, type DataMatrixSymbol } from "./codes/datamatrix.js";
export type { SymbolSource } from "./symbols.js";

export type * from "./plan-types.js";
export { planFinishing, parseFinishing, type PlanInput } from "./plan.js";
export { DEFAULT_REGISTRATION_CLEARANCE_MM, registrationZones, findCollisions, assertNoCollisions, type ClearanceZone } from "./collision.js";
export { itemReservations, layoutReservation, reserveSpace, rotateEdge, type EdgeSpace, type MarginReserver, type ReservationInput } from "./reserve.js";

export { MARKS_OCG_NAME, MARKS_SEPARATION_NAME, REGISTRATION_COLORANT, renderPlan, ensureMarksOcg } from "./pdf-writer.js";
export {
  LAYOUT_INFO_KEY,
  finishingMetadata,
  labelCodes,
  mergeFinishingMetadata,
  readLayoutMetadata,
  writeLayoutMetadata,
  type ElementMetadata,
  type FinishingMetadata,
  type LabelCodeRef,
  type PartMetadata,
} from "./metadata.js";
export { draw, marksHook, composeHooks, type DrawInput, type DrawOptions } from "./draw.js";

export { parsePreset, importPresets, exportPresets, selectPreset, resolveFinishing, type PresetLookup } from "./presets.js";
export {
  PROOF_WATERMARK_TEXT,
  ProofWatermarkSchema,
  parseProofWatermark,
  proofWatermark,
  type ProofWatermark,
  type ProofWatermarkInput,
} from "./proof-watermark.js";
export { labelPreviewSvg, labelPartSvg, type LabelPreview, type LabelPreviewInput } from "./label-preview.js";
