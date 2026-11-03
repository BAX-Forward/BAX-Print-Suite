// Panels and segmentation (spec 004 Part C, core and generic). Roll jobs
// longer than `roll.maxPanelLengthMm`, and flatbed jobs longer than the bed on
// machines with a conveyor, are split along frame Y (the feed axis) into panels.
// When registration marks are present, panel boundaries snap to mark rows so
// adjacent panels share a row and every panel has its own marks.
//
// A contour crossing a boundary is assigned to the panel containing its bbox
// max (with a warning), or split at the boundary when `allowSplit` is set.

import { CutterDriverError, type Contour, type CutJob, type CutPanel, type CutterProfile, type Point, type RegistrationMarks } from "@bax-print/plugin-sdk";
import { bboxOf, makeContour, mmToPt, ptToMm } from "./geometry.js";

export interface SegmentOptions {
  /** Overrides the profile limit (roll: `roll.maxPanelLengthMm`; flatbed with conveyor: `workArea.lengthMm`). */
  maxPanelLengthMm?: number;
  /** Split contours that cross a panel boundary instead of moving them whole to one panel. */
  allowSplit?: boolean;
}

export interface SegmentResult {
  /** The input job with `segmentation.panels` filled in (unchanged when one panel suffices). */
  job: CutJob;
  /** One job per panel: its contours and its marks, in frame coordinates. */
  panelJobs: CutJob[];
  warnings: string[];
}

/** Floating point tolerance for boundary comparisons, in mm. */
const EPS_MM = 1e-6;
/** Mark rows closer than this (mm) are treated as one row. */
const ROW_RESOLUTION_MM = 0.01;

/** The panel length limit the profile implies, or undefined when the job need not be segmented. */
export function panelLimitMm(profile: CutterProfile): number | undefined {
  if (profile.class === "roll") return profile.roll?.maxPanelLengthMm;
  return profile.flatbed?.conveyor ? profile.workArea.lengthMm : undefined;
}

function markRowsMm(marks: RegistrationMarks | undefined): number[] {
  const rows = (marks?.marks ?? []).map((m) => Math.round(ptToMm(m.yPt) / ROW_RESOLUTION_MM) * ROW_RESOLUTION_MM);
  return [...new Set(rows)].sort((a, b) => a - b);
}

/** Panel boundaries [0, b1, ..., length] in mm. Each panel is at most `maxMm` long. */
export function panelBoundariesMm(lengthMm: number, maxMm: number, rowsMm: readonly number[] = []): number[] {
  const out = [0];
  let y0 = 0;
  while (lengthMm - y0 > maxMm + EPS_MM) {
    const limit = y0 + maxMm;
    const snapped = rowsMm.filter((r) => r > y0 + EPS_MM && r <= limit + EPS_MM).pop();
    y0 = snapped ?? limit;
    out.push(y0);
  }
  out.push(lengthMm);
  return out;
}

function panelIndexOf(yMm: number, boundaries: readonly number[]): number {
  for (let i = 0; i < boundaries.length - 2; i++) if (yMm <= boundaries[i + 1] + EPS_MM) return i;
  return boundaries.length - 2;
}

interface Piece {
  panel: number;
  points: Point[];
}

/** Cuts a polyline (pt) at the interior boundaries (mm) and groups the edges by panel. */
function splitAtBoundaries(points: readonly Point[], closed: boolean, boundaries: readonly number[]): Piece[] {
  const seq = closed ? [...points, points[0]] : [...points];
  const interior = boundaries.slice(1, -1).map(mmToPt);
  const refined: Point[] = [seq[0]];
  for (let i = 1; i < seq.length; i++) {
    const [a, b] = [seq[i - 1], seq[i]];
    const crossings = interior
      .filter((y) => (a[1] < y && y < b[1]) || (b[1] < y && y < a[1]))
      .map((y) => (y - a[1]) / (b[1] - a[1]))
      .sort((s, t) => s - t);
    for (const t of crossings) refined.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    refined.push(b);
  }
  const pieces: Piece[] = [];
  for (let i = 1; i < refined.length; i++) {
    const panel = panelIndexOf(ptToMm((refined[i - 1][1] + refined[i][1]) / 2), boundaries);
    const last = pieces[pieces.length - 1];
    if (last && last.panel === panel) last.points.push(refined[i]);
    else pieces.push({ panel, points: [refined[i - 1], refined[i]] });
  }
  if (closed && pieces.length > 1 && pieces[0].panel === pieces[pieces.length - 1].panel) {
    const tail = pieces.pop() as Piece;
    pieces[0] = { panel: tail.panel, points: [...tail.points, ...pieces[0].points.slice(1)] };
  }
  return pieces;
}

function panelMarks(marks: RegistrationMarks | undefined, y0Mm: number, y1Mm: number): RegistrationMarks | undefined {
  if (!marks) return undefined;
  const inPanel = marks.marks.filter((m) => {
    const y = ptToMm(m.yPt);
    return y >= y0Mm - ROW_RESOLUTION_MM && y <= y1Mm + ROW_RESOLUTION_MM;
  });
  if (inPanel.length === 0) return undefined;
  const originMarkId = inPanel.some((m) => m.id === marks.originMarkId)
    ? marks.originMarkId
    : [...inPanel].sort((a, b) => a.yPt - b.yPt || a.xPt - b.xPt)[0].id;
  return { ...marks, marks: inPanel, originMarkId };
}

/** Splits a job into panels. Returns the job unchanged (one panel) when no limit applies or it fits. */
export function segmentCutJob(job: CutJob, profile: CutterProfile, options: SegmentOptions = {}): SegmentResult {
  const limit = options.maxPanelLengthMm ?? panelLimitMm(profile);
  if (limit !== undefined && !(Number.isFinite(limit) && limit > 0)) {
    throw new CutterDriverError("invalid-options", "maxPanelLengthMm must be > 0");
  }
  const contentMaxY = job.contours.reduce((max, c) => Math.max(max, bboxOf(c.points).maxY), 0);
  const lengthMm = ptToMm(Math.max(job.frame.heightPt, contentMaxY));
  if (limit === undefined || lengthMm <= limit + EPS_MM) return { job, panelJobs: [job], warnings: [] };

  const boundaries = panelBoundariesMm(lengthMm, limit, markRowsMm(job.marks));
  const panelCount = boundaries.length - 1;
  const contoursByPanel: Contour[][] = Array.from({ length: panelCount }, () => []);
  const warnings: string[] = [];

  for (const contour of job.contours) {
    const box = bboxOf(contour.points);
    const panel = panelIndexOf(ptToMm(box.maxY), boundaries);
    const crosses = ptToMm(box.minY) < boundaries[panel] - EPS_MM;
    if (!crosses) {
      contoursByPanel[panel].push(contour);
    } else if (options.allowSplit) {
      const pieces = splitAtBoundaries(contour.points, contour.closed, boundaries);
      pieces.forEach((piece, k) =>
        contoursByPanel[piece.panel].push(
          makeContour({ id: `${contour.id}.${k + 1}`, tool: contour.tool, source: contour.source, points: piece.points, closed: false }),
        ),
      );
      warnings.push(`contour ${contour.id}: split into ${pieces.length} open pieces at panel boundaries`);
    } else {
      contoursByPanel[panel].push(contour);
      warnings.push(`contour ${contour.id}: crosses a panel boundary, assigned whole to panel ${panel + 1}`);
    }
  }

  const panels: CutPanel[] = [];
  const panelJobs: CutJob[] = [];
  for (let i = 0; i < panelCount; i++) {
    const [y0Mm, y1Mm] = [boundaries[i], boundaries[i + 1]];
    const marks = panelMarks(job.marks, y0Mm, y1Mm);
    if (job.marks && (marks?.marks.length ?? 0) < 3) warnings.push(`panel ${i + 1}: fewer than 3 registration marks`);
    panels.push({ y0Mm, y1Mm, marks: marks?.marks.map((m) => m.id) ?? [] });
    const { segmentation: _ignored, marks: _marks, ...rest } = job;
    panelJobs.push({ ...rest, jobId: `${job.jobId}-p${i + 1}`, contours: contoursByPanel[i], ...(marks ? { marks } : {}) });
  }
  return { job: { ...job, segmentation: { panels } }, panelJobs, warnings };
}
