// Cut contour source chosen by a job's edits (Spec 007 FR4 `cutContour`, 007e).
// A job's edits may replace its configured cut settings: `spot` names the
// colorants to extract, `rect` is a ready-made rectangle in the trim frame and
// `none` means the job is not cut. Without such an edit the configured
// settings apply unchanged.

import {
  CutterDriverError,
  type Contour,
  type CutFrame,
  type CutJob,
  type Point,
  type RegistrationMarks,
  type SemanticTool,
  type ToolAssignment,
} from "@bax-print/plugin-sdk";
import { makeContour } from "./geometry.js";
import type { ValidationIssue } from "./validate.js";

/**
 * The effective cut contour of one page, as `resolveCutContour` in `@bax-print/edits`
 * returns it. A structural copy, so this package needs no dependency on the edits package.
 * Spot names are already renamed by later `spotMap` edits. A `rect` is in points in the
 * trim frame (origin at the bottom-left of the finished artwork, y up), the CutFrame.
 */
export type ResolvedCutContour =
  | { kind: "spot"; names: string[] }
  | { kind: "rect"; x: number; y: number; width: number; height: number }
  | { kind: "none" };

/** The contour selection handed to extraction (Spec 004 Part A `CutConfig`). Omitted fields take the extractor's defaults. */
export interface CutContourSelection {
  spotNames?: readonly string[];
  layerNames?: readonly string[];
}

/** What the cut job is built from once a page's cut contour is known. */
export type CutContourPlan =
  /** Extract the page's contours with this selection. */
  | { kind: "extract"; selection: CutContourSelection; warnings: ValidationIssue[] }
  /** Use exactly these contours; nothing is extracted. */
  | { kind: "contours"; contours: Contour[]; warnings: ValidationIssue[] }
  /** The job is not cut. */
  | { kind: "none" };

export interface ResolvedCutOptions {
  /** Semantic tool of a `rect` contour (default "kiss", the tool Spec 004 maps `CutContour` to). */
  rectTool?: SemanticTool;
}

export const RECT_CONTOUR_ID = "cut-rect";

const DEFAULT_RECT_TOOL: SemanticTool = "kiss";

/** One closed counter-clockwise rectangle (pt, trim frame), so it keeps a positive signed area like extracted rings. */
function rectContour(rect: Extract<ResolvedCutContour, { kind: "rect" }>, tool: SemanticTool): Contour {
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isFinite) || !(width > 0 && height > 0)) {
    throw new CutterDriverError("invalid-job", "cut rectangle must have finite coordinates and a positive width and height");
  }
  const points: Point[] = [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
  return makeContour({ id: RECT_CONTOUR_ID, tool, closed: true, points });
}

const noSpotNamesWarning = (): ValidationIssue => ({
  severity: "warning",
  code: "no-cut-contours",
  message: "the cut contour edit names no spot colorants (all were mapped to process), so the job has no cut contours",
  path: "edits.cutContour.source.names",
});

/**
 * Maps a page's resolved cut contour to the geometry the cut job is built from. `undefined`
 * (no `cutContour` edit) keeps the configured selection as given. A `spot` source replaces
 * it with exactly its names and no layer names, since the edit names the only source; with
 * no names left there are no contours and a `no-cut-contours` warning. A `rect` becomes one
 * closed contour in the trim frame; the shared frame transforms apply at export like for any
 * contour. `none` returns `{ kind: "none" }`. Throws `CutterDriverError("invalid-job")` for
 * a rectangle without area.
 */
export function contoursForResolvedCut(
  resolved: ResolvedCutContour | undefined,
  configured: CutContourSelection,
  options: ResolvedCutOptions = {},
): CutContourPlan {
  if (resolved === undefined) return { kind: "extract", selection: configured, warnings: [] };
  switch (resolved.kind) {
    case "spot":
      return resolved.names.length === 0
        ? { kind: "contours", contours: [], warnings: [noSpotNamesWarning()] }
        : { kind: "extract", selection: { spotNames: [...resolved.names], layerNames: [] }, warnings: [] };
    case "rect":
      return { kind: "contours", contours: [rectContour(resolved, options.rectTool ?? DEFAULT_RECT_TOOL)], warnings: [] };
    case "none":
      return { kind: "none" };
  }
}

export interface CutJobInput extends ResolvedCutOptions {
  jobId: string;
  /** The trim frame of the (edited) page, in pt. */
  frame: CutFrame;
  toolMap: Record<string, ToolAssignment>;
  marks?: RegistrationMarks;
  options?: Record<string, unknown>;
  /** The job's configured cut settings. */
  cut: CutContourSelection;
  /** The extraction stage (Spec 004 Part A): the page's contours matching a selection, in pt in the frame. */
  extract: (selection: CutContourSelection) => Contour[] | Promise<Contour[]>;
  /** The page's cut contour after the job's edits (`resolveCutContour`). Omit when the job has no edits. */
  cutContour?: ResolvedCutContour;
}

export type CutJobResult = { kind: "job"; job: CutJob; warnings: ValidationIssue[] } | { kind: "none" };

/**
 * Builds the CutJob of a page. Without `cutContour` the contours come from `extract` with the
 * configured `cut` selection; with one, `contoursForResolvedCut` decides. A `none` source
 * returns `{ kind: "none" }` and never calls `extract`.
 */
export async function buildCutJob(input: CutJobInput): Promise<CutJobResult> {
  const plan = contoursForResolvedCut(input.cutContour, input.cut, input);
  if (plan.kind === "none") return { kind: "none" };
  const contours = plan.kind === "extract" ? await input.extract(plan.selection) : plan.contours;
  const job: CutJob = {
    jobId: input.jobId,
    contours,
    toolMap: input.toolMap,
    frame: input.frame,
    ...(input.marks ? { marks: input.marks } : {}),
    options: input.options ?? {},
  };
  return { kind: "job", job, warnings: plan.warnings };
}
