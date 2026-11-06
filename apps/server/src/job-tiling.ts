import { ticketEdits, type Job, type TilingSetting } from '@bax-print/core';
import { ptToMm, tile, toNestItems, type PanelNestItem, type SeamTreatment, type TilePage, type TileSpec } from '@bax-print/tile/layout';
import { tilingUnsupported } from './errors.js';

/**
 * Spec 050b: a job's tiling setting (Spec 050a, core) as tile's input, and the tiled job's panels as nest
 * items. The mapping lives in the server because core does not depend on tile; the server imports only
 * the pure `@bax-print/tile/layout` entry, so nothing here loads pdf-lib.
 */

/** The size of the page a job is tiled from, in pt. */
export interface JobTilingPageSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

/** The page a tiled job's panels are cut from. */
export interface JobTilingSource {
  /** Pages in the job's source; a tiling setting names no page, so only a one-page source is tiled. */
  readonly pageCount: number;
  /** The tiled page, 0-based. */
  readonly pageIndex: number;
  /** The page's TrimBox in PDF user space (pt); its bottom-left corner is the origin of the panels' clip boxes. */
  readonly trimBoxPt: JobTilingPageSize & { readonly x: number; readonly y: number };
}

/** The job fields tiling reads. */
export type TiledJob = Pick<Job, 'id' | 'ticket' | 'sourceFiles' | 'sourceFormat' | 'tiling'>;

export type JobTilingItems =
  | { readonly ok: true; readonly items: PanelNestItem[] }
  | { readonly ok: false; readonly issues: string[] };

/** Core's seam as tile's `SeamTreatment`; an overlap without `overlapMm` keeps tile's default overlap. */
function seamTreatment(seam: NonNullable<TilingSetting['seam']>): SeamTreatment {
  if (seam.kind === 'butt') return { kind: 'butt' };
  if (seam.kind === 'gap') return { kind: 'gap', gapMm: seam.gapMm };
  return seam.overlapMm === undefined ? { kind: 'overlap' } : { kind: 'overlap', overlapMm: seam.overlapMm };
}

/**
 * Spec 050d: core's explicit seam positions as tile's `seamsX` and `seamsY`. Both are mm from the artwork's
 * left and bottom edge, so the values pass unchanged; an axis without positions adds no key.
 */
function seamPositions(tiling: TilingSetting): Pick<TileSpec, 'seamsX' | 'seamsY'> {
  return {
    ...(tiling.seamsX === undefined ? {} : { seamsX: [...tiling.seamsX] }),
    ...(tiling.seamsY === undefined ? {} : { seamsY: [...tiling.seamsY] }),
  };
}

/**
 * Tile's page and spec for a tiling setting: the grid in `count` mode, the explicit seam positions (Spec 050d)
 * and the one seam for every seam. Without a seam the spec has none either, so tile uses its default seam, as
 * core's `TilingSetting` documents.
 */
export function tilingToTileSpec(tiling: TilingSetting, page: JobTilingPageSize): { page: TilePage; spec: TileSpec } {
  const grid = { mode: 'count' as const, columns: tiling.grid.columns, rows: tiling.grid.rows };
  const seam = tiling.seam === undefined ? {} : { seam: seamTreatment(tiling.seam) };
  return {
    page: { widthMm: ptToMm(page.widthPt), heightMm: ptToMm(page.heightPt) },
    spec: { grid, ...seamPositions(tiling), ...seam },
  };
}

/** Seams on one axis that do not lie strictly inside the artwork's `lengthMm`, one issue each. */
function axisSeamIssues(name: string, seams: readonly number[], lengthMm: number, dimension: string): string[] {
  return seams.flatMap((seamMm, index) =>
    seamMm > 0 && seamMm < lengthMm
      ? []
      : [
          `${name}[${String(index)}] at ${String(seamMm)} mm is not inside the artwork; a seam must lie strictly between 0 and the TrimBox ${dimension} of ${lengthMm.toFixed(3)} mm`,
        ],
  );
}

/**
 * Spec 050d: core checks seam positions without an artwork, so the upper bound is checked here against the
 * TrimBox in mm before tile runs; empty when every explicit seam lies strictly inside the artwork.
 */
function seamExtentIssues(tiling: TilingSetting, page: TilePage): string[] {
  return [
    ...axisSeamIssues('seamsX', tiling.seamsX ?? [], page.widthMm, 'width'),
    ...axisSeamIssues('seamsY', tiling.seamsY ?? [], page.heightMm, 'height'),
  ];
}

/** What about the job or its source tiling can not take; empty when it can be tiled. */
function shapeIssues(job: TiledJob, source: JobTilingSource): string[] {
  const issues: string[] = [];
  const sourceCount = job.sourceFiles.length;
  if (sourceCount === 0 || sourceCount > 1) {
    issues.push(`a tiled job takes exactly one source file; job ${job.id} has ${String(sourceCount)}`);
  }
  const format = job.sourceFormat ?? 'pdf';
  const isPdf = format === 'pdf';
  if (isPdf === false) issues.push(`only a PDF source can be tiled; job ${job.id} has a ${format} source`);
  const isOnePage = source.pageCount === 1 && source.pageIndex === 0;
  if (source.pageCount > 1) {
    issues.push(`tiling takes a one-page source; the source of job ${job.id} has ${String(source.pageCount)} pages`);
  } else if (isOnePage === false) {
    issues.push(`page ${String(source.pageIndex)} is not the one page of a one-page source`);
  }
  if (ticketEdits(job.ticket).length > 0) {
    issues.push('tiling can not be combined with ticket edits (rotate, scale, crop, bleed, page size or copies); the panels are cut from the unedited page');
  }
  if (Number.isFinite(source.trimBoxPt.x) && Number.isFinite(source.trimBoxPt.y)) return issues;
  issues.push('the TrimBox origin must be finite numbers');
  return issues;
}

/**
 * Spec 050b: the nest items of a tiled job, one per panel, from tile's `toNestItems` (ids from `panelItemId`
 * with the job id, each with its clip box on the source page). Issues, never a guess, when the job has no
 * tiling, the job or source has a shape tiling does not take, an explicit seam (Spec 050d) is not strictly
 * inside the TrimBox, or tile rejects the setting for the page (then the issues are tile's issue messages,
 * device and medium limits are not checked here).
 */
export function jobTilingNestItems(job: TiledJob, source: JobTilingSource): JobTilingItems {
  if (job.tiling === undefined) return { ok: false, issues: [`job ${job.id} has no tiling setting`] };
  const issues = shapeIssues(job, source);
  if (issues.length > 0) return { ok: false, issues };
  const { page, spec } = tilingToTileSpec(job.tiling, source.trimBoxPt);
  const extentIssues = seamExtentIssues(job.tiling, page);
  if (extentIssues.length > 0) return { ok: false, issues: extentIssues };
  const result = tile(page, spec);
  if (result.ok === false) return { ok: false, issues: result.issues.map((issue) => issue.message) };
  const { x, y } = source.trimBoxPt;
  return { ok: true, items: toNestItems(result.panels, { jobId: job.id, pageIndex: source.pageIndex, trimOriginPt: { x, y } }) };
}

/** `jobTilingNestItems`, or a 422 `tiling_unsupported` with its issues in `details`. */
export function requireJobTilingNestItems(job: TiledJob, source: JobTilingSource): PanelNestItem[] {
  const result = jobTilingNestItems(job, source);
  if (result.ok) return result.items;
  throw tilingUnsupported(`Job ${job.id} can not be tiled`, result.issues);
}

/**
 * Spec 050b: a route that lays out the whole source page (step and repeat, n-up, booklet) can not take a
 * tiled job's panels, so a tiled job is a 422 `tiling_unsupported` there rather than printed untiled.
 * A job without tiling passes untouched.
 */
export function rejectTiledJob(job: Pick<Job, 'id' | 'tiling'>, layout: string): void {
  if (job.tiling === undefined) return;
  throw tilingUnsupported(`Job ${job.id} is tiled; ${layout} can not lay out tiling panels`, [
    `${layout} lays out the whole source page; clear the job's tiling (DELETE /jobs/${job.id}/tiling) to use it`,
  ]);
}
