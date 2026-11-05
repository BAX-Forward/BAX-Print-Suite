import { readFile } from 'node:fs/promises';
import type { Job } from '@bax-print/core';
import { readPageBoxes, type CutContourSelection } from '@bax-print/cut-export';
import { computeGeometry, EditError, pageSourceOfBoxes } from '@bax-print/edits';
import { CutterDriverError, type Contour, type ToolAssignment } from '@bax-print/plugin-sdk';
import type { CutExtractor } from './cut-routes.js';
import { HttpError } from './errors.js';

/** The page of a job's source document that is cut. */
export interface CutSourcePage {
  readonly pdfBytes: Uint8Array;
  readonly pageIndex: number;
}

/** The contour extraction stage (Spec 004 Part A): the page's contours matching a selection, in pt in the trim frame. */
export type PdfContourExtraction = (page: CutSourcePage, selection: CutContourSelection) => Contour[] | Promise<Contour[]>;

export interface PdfCutExtractorOptions {
  /** Absolute path of a stored blob, as `PreflightService` resolves source files. */
  readonly blobPath: (storageKey: string) => string;
  /** The configured cut settings used when a job has no `cutContour` edit. */
  readonly cut: CutContourSelection;
  readonly toolMap?: Record<string, ToolAssignment>;
  /** The page that is cut (default 0, the first page). */
  readonly pageIndex?: number;
  /** Default: no contours, since this build has no PDF content-stream contour extraction yet. */
  readonly extract?: PdfContourExtraction;
}

const noContours: PdfContourExtraction = () => [];

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** The stored bytes of the job's first source file, or `undefined` when it has none or the blob is gone. */
export async function readSource(job: Job, blobPath: PdfCutExtractorOptions['blobPath']): Promise<Uint8Array | undefined> {
  const [source] = job.sourceFiles;
  if (!source) return undefined;
  try {
    return await readFile(blobPath(source.storageKey));
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

/**
 * The production cut extractor (Spec 007h): reads the page boxes of the job's first source PDF
 * and plans its trim frame through the job's edits. Returns `undefined` (the route answers 409)
 * when the job has no source file. Answers 422 when the source is not a readable PDF.
 */
export function createPdfCutExtractor(options: PdfCutExtractorOptions): CutExtractor {
  const pageIndex = options.pageIndex ?? 0;
  const extract = options.extract ?? noContours;
  return async (job) => {
    const pdfBytes = await readSource(job, options.blobPath);
    if (!pdfBytes) return undefined;
    try {
      const pageBoxes = await readPageBoxes(pdfBytes, pageIndex);
      const geometry = computeGeometry(pageSourceOfBoxes(pageBoxes), job.ticket.edits ?? []);
      return {
        pageBoxes,
        frame: { widthPt: geometry.trimWidthPt, heightPt: geometry.trimHeightPt },
        toolMap: options.toolMap ?? {},
        cut: options.cut,
        extract: (selection) => extract({ pdfBytes, pageIndex }, selection),
      };
    } catch (error) {
      // An unreadable source PDF or edits that can't apply to its page are the job's problem, not the server's.
      if (error instanceof CutterDriverError) throw new HttpError(422, 'unreadable_pdf', error.message);
      if (error instanceof EditError) throw new HttpError(422, 'invalid_cut_contour', error.message);
      throw error;
    }
  };
}
