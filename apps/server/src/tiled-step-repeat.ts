import type { Job } from '@bax-print/core';
import { loadDocumentModel, type DocumentModel } from '@bax-print/inspect';
import {
  artSize,
  imposeNestItems,
  MAX_STEP_REPEAT_PLACEMENTS,
  pagePanels,
  panelFrame,
  placementMatrix,
  POINTS_PER,
  STEP_REPEAT_CUT_SOURCE_NAME,
  type Contour,
  type Frame,
  type Layout,
  type NestOptions,
  type Placement,
  type RollMedia,
  type StepRepeatJob,
} from '@bax-print/nest';
import { conflict, HttpError, tilingUnsupported } from './errors.js';
import { requireJobTilingNestItems, type JobTilingSource } from './job-tiling.js';
import { readSource } from './pdf-cut-extractor.js';
import type { StepRepeatBody } from './step-repeat-routes.js';

/**
 * Spec 051b: `POST /jobs/:id/step-repeat` for a tiled job. The job's panels (Spec 050b) are nested on the
 * route's roll with `imposeNestItems`, each drawn as a Form XObject clipped to its panel, and answered in
 * the shape of an untiled step and repeat.
 */

/** The semantic tool `stepAndRepeatJob` puts on its contours by default. */
const CUT_TOOL = 'kiss';

/** The deterministic rectangle nester; panels are locked to one orientation, so `rotate` does not apply. */
const NEST_ALGORITHM: NestOptions['algorithm'] = 'maxrects';

function mmToPt(mm: number): number {
  return mm * POINTS_PER.mm;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stands in for the page when the job's shape (source count or format) already rules tiling out, so the
 * source is not read and the issues name only what is wrong with the job.
 */
function shapeOnlySource(pageIndex: number): JobTilingSource {
  return { pageCount: 1, pageIndex, trimBoxPt: { x: 0, y: 0, widthPt: 0, heightPt: 0 } };
}

/**
 * The page count and the TrimBox of the tiled page, read with inspect's document model (the server has no
 * runtime pdf-lib dependency). A missing TrimBox is the CropBox, else the MediaBox, the box `imposeNestItems`
 * checks clip boxes against. A source that can not be read is a 422 `unreadable_pdf`.
 */
async function pageSource(sourcePdf: Uint8Array, pageIndex: number): Promise<JobTilingSource> {
  let model: DocumentModel;
  try {
    model = await loadDocumentModel(sourcePdf);
  } catch (error) {
    throw new HttpError(422, 'unreadable_pdf', `cannot read source PDF (${errorMessage(error)})`);
  }
  const { pageCount } = model;
  const boxes = model.pages[pageIndex]?.boxes;
  const trim = boxes?.TrimBox ?? boxes?.CropBox ?? boxes?.MediaBox;
  if (trim === undefined) return { ...shapeOnlySource(pageIndex), pageCount };
  return { pageCount, pageIndex, trimBoxPt: { x: trim.x0, y: trim.y0, widthPt: trim.x1 - trim.x0, heightPt: trim.y1 - trim.y0 } };
}

/** The job's one source PDF; every shape tiling does not take is a 422 `tiling_unsupported` before it is read. */
async function readTiledSource(job: Job, pageIndex: number, blobPath: (storageKey: string) => string): Promise<Uint8Array> {
  const isOnePdf = job.sourceFiles.length === 1 && (job.sourceFormat ?? 'pdf') === 'pdf';
  if (isOnePdf === false) {
    requireJobTilingNestItems(job, shapeOnlySource(pageIndex));
    throw tilingUnsupported(`Job ${job.id} can not be tiled`, ['a tiled job takes exactly one PDF source file']);
  }
  const sourcePdf = await readSource(job, blobPath);
  if (sourcePdf === undefined) throw conflict(`Job ${job.id} has no source file to step and repeat`);
  return sourcePdf;
}

/** The route's roll in pt: the roll width and the margins, as `stepAndRepeatJob` lays them out. */
function rollMedia(body: StepRepeatBody): RollMedia {
  const { left, right, lead, trail } = body.marginsMm;
  return { widthPt: mmToPt(body.rollWidthMm), margins: { left: mmToPt(left), right: mmToPt(right), lead: mmToPt(lead), trail: mmToPt(trail) } };
}

/** The panel's outline on the imposed page, a counter-clockwise ring from the bottom-left like a step-repeat trim contour. */
function panelContour(placement: Placement, frame: Frame): Contour {
  const [a, b, c, d, e, f] = placementMatrix(placement, frame);
  const { w, h } = artSize(placement);
  const corners: readonly (readonly [number, number])[] = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ];
  const xs = corners.map(([u, v]) => a * u + c * v + e);
  const ys = corners.map(([u, v]) => b * u + d * v + f);
  const bbox = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  return {
    id: `${placement.itemId}/copy-${String(placement.copy)}`,
    tool: CUT_TOOL,
    source: { kind: 'layer', name: STEP_REPEAT_CUT_SOURCE_NAME },
    closed: true,
    points: [
      [bbox.minX, bbox.minY],
      [bbox.maxX, bbox.minY],
      [bbox.maxX, bbox.maxY],
      [bbox.minX, bbox.maxY],
    ],
    bbox,
    areaSigned: (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY),
  };
}

function panelContours(layout: Layout): Contour[] {
  const frames = new Map(pagePanels(layout).map((panel) => [panel.index, panelFrame(layout, panel)]));
  return layout.placements.map((placement) => {
    const frame = frames.get(placement.panel) ?? panelFrame(layout, { index: placement.panel, offsetPt: 0, lengthPt: 0 });
    return panelContour(placement, frame);
  });
}

/**
 * Spec 051b: the tiled job's panels, `body.copies` of each, nested on the roll and imposed. A shape tiling
 * does not take and a panel set `imposeNestItems` rejects are 422 `tiling_unsupported` with the issues in
 * `details`; too many placements or a panel that does not fit the roll are 422 `invalid_step_repeat`, as
 * for an untiled job. Nothing is printed with a panel missing.
 */
export async function tiledStepRepeat(job: Job, body: StepRepeatBody, blobPath: (storageKey: string) => string): Promise<StepRepeatJob> {
  const pageIndex = body.pageIndex ?? 0;
  const sourcePdf = await readTiledSource(job, pageIndex, blobPath);
  const panels = requireJobTilingNestItems(job, await pageSource(sourcePdf, pageIndex));
  const placements = panels.length * body.copies;
  if (placements > MAX_STEP_REPEAT_PLACEMENTS) {
    throw new HttpError(
      422,
      'invalid_step_repeat',
      `${String(panels.length)} panels × ${String(body.copies)} copies = ${String(placements)} placements exceed the limit of ${String(MAX_STEP_REPEAT_PLACEMENTS)}`,
    );
  }
  const items = panels.map((panel) => ({ ...panel, quantity: body.copies }));
  // The nester has one gutter for both directions; the larger gap keeps at least the requested gap each way.
  const options: NestOptions = { gutterPt: mmToPt(Math.max(body.gapXMm, body.gapYMm)), algorithm: NEST_ALGORITHM };
  const result = await imposeNestItems(rollMedia(body), items, options, { sourcePdf, sourceBox: body.sourceBox });
  if (result.ok === false) {
    throw tilingUnsupported(`Job ${job.id}: the tiling panels can not be imposed`, result.issues.map((issue) => issue.message));
  }
  const { layout } = result;
  if (layout.unplaced.length > 0) {
    throw new HttpError(
      422,
      'invalid_step_repeat',
      `Job ${job.id}: not every tiling panel fits the roll`,
      layout.unplaced.map((unplaced) => `${unplaced.itemId}: ${String(unplaced.copies)} copies not placed (${unplaced.reason})`),
    );
  }
  return { layout, imposedPdf: result.imposedPdf, cutContours: panelContours(layout), warnings: [...result.warnings] };
}
