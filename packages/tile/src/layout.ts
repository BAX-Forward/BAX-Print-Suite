/**
 * Pure layout entry point (`@bax-print/tile/layout`, Spec 049b).
 *
 * Everything here is computed from numbers alone: grids, suggestions, labels,
 * marks geometry, contours, nest items, panel selection and templates. It
 * leaves out `panelPdf` (pdf.ts), so nothing reachable from this module
 * imports pdf-lib and a browser bundle can use the layout without it.
 * Every export is the same binding the package root exports.
 */
export type {
  EdgeKind,
  GridDef,
  LabelStyle,
  Mm,
  Panel,
  PanelNaming,
  RectMm,
  SeamTreatment,
  Side,
  SizeAccounting,
  TileIssue,
  TileIssueCode,
  TileLimits,
  TilePage,
  TileResult,
  TileSpec,
} from "./types.js";
export { mmToPt, ptToMm, PT_PER_MM } from "./units.js";
export { DEFAULT_OVERLAP_MM, DEFAULT_SEAM, MAX_PANELS_PER_AXIS } from "./axis.js";
export { letters, panelLabel, panelLabelParts } from "./labels.js";
export { seamTreatmentAt, tile, widthLimitMm } from "./tile.js";
export { MAX_KEEP_OUT_REGIONS, suggest, type SuggestOptions, type SuggestResult, type Suggestion } from "./suggest.js";
export {
  DEFAULT_LABEL_INSET_MM,
  DEFAULT_TICK_LENGTH_MM,
  DEFAULT_UNDER_SIDES,
  overlapStrip,
  panelTemplateFields,
  placePanelLabel,
  seamTicks,
  type LabelPlacement,
  type LabelPlacementOptions,
  type SeamTick,
} from "./marks.js";
export { clipContours, contoursForPanels, type ClippedContour, type Contour, type Point, type RectPt } from "./clip.js";
export {
  panelClipBox,
  panelItemId,
  toNestItems,
  type ClipBoxPt,
  type PanelNestItem,
  type PanelSource,
} from "./nest-item.js";
export { MAX_PANEL_REF_LENGTH, MAX_PANEL_REFS, selectPanels, type PanelSelection, type SelectPanelsOptions } from "./select.js";
export {
  parseTileTemplate,
  serializeTileTemplate,
  specFromTemplate,
  templateFromSpec,
  TILE_TEMPLATE_KIND,
  TILE_TEMPLATE_VERSION,
  type ParseTemplateResult,
  type SeamPositioning,
  type TemplateOptions,
  type TileTemplate,
} from "./template.js";
