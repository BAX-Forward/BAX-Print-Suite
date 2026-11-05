// Core CutJob validation against a declared CutterProfile (spec 004 Part C).
// Branches only on declared capabilities, never on vendor or model. All
// problems are collected and reported before export.
//
// Axis convention: frame X runs across the machine width, frame Y along the
// feed (roll) or bed length (flatbed). Plugins that swap axes for output still
// receive frame coordinates in this convention.

import {
  CutterDriverError,
  type CutJob,
  type CutterProfile,
  type Point,
  type Range,
  type RegistrationMethod,
  type ToolAssignment,
} from "@bax-print/plugin-sdk";
import { bboxOf, formatCompact, ptToMm } from "./geometry.js";

export type ValidationCode =
  | "invalid-geometry"
  | "extent-width"
  | "extent-length"
  | "unmapped-tool"
  | "unknown-tool"
  | "param-out-of-range"
  | "param-unsupported"
  | "registration-unsupported"
  | "mark-shape-unsupported"
  | "mark-size-out-of-range"
  | "origin-mark-missing"
  | "invalid-panel"
  | "no-cut-contours";

export interface ValidationIssue {
  severity: "error" | "warning";
  code: ValidationCode;
  message: string;
  /** JSON-pointer-like location in the job, e.g. "toolMap.kiss.force". */
  path?: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Tolerance for extent comparisons, in mm (floating point noise from pt <-> mm). */
const EXTENT_EPSILON_MM = 1e-6;

const PARAM_NAMES = ["speed", "force", "depth", "passes"] as const;

function isFinitePoint(p: unknown): p is Point {
  return Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function inRange(value: number, range: Range): boolean {
  return value >= range.min && value <= range.max;
}

function rangeText(range: Range): string {
  return `${range.min}..${range.max} ${range.unit}`;
}

/** Bounding box (mm) of everything the machine has to reach: contours and registration marks. */
export function jobExtentMm(job: Pick<CutJob, "contours" | "marks">): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  const points: Point[] = job.contours.flatMap((c) => c.points.filter(isFinitePoint));
  for (const m of job.marks?.marks ?? []) {
    const r = m.dPt / 2;
    points.push([m.xPt - r, m.yPt - r], [m.xPt + r, m.yPt + r]);
  }
  if (points.length === 0) return undefined;
  const box = bboxOf(points);
  return { minX: ptToMm(box.minX), minY: ptToMm(box.minY), maxX: ptToMm(box.maxX), maxY: ptToMm(box.maxY) };
}

/** Registration method the job asks for: the marks' method, "corner-marks" for unlabeled marks, "none" without marks. */
export function requestedRegistrationMethod(job: Pick<CutJob, "marks">): RegistrationMethod {
  if (!job.marks || job.marks.marks.length === 0) return "none";
  return job.marks.method ?? "corner-marks";
}

function checkGeometry(job: CutJob, error: (code: ValidationCode, message: string, path?: string) => void): void {
  if (!(job.frame?.widthPt > 0) || !(job.frame?.heightPt > 0)) error("invalid-geometry", "frame width and height must be > 0", "frame");
  job.contours.forEach((contour, i) => {
    if (!Array.isArray(contour.points) || !contour.points.every(isFinitePoint)) {
      error("invalid-geometry", `contour ${contour.id}: points must be finite [x, y] pairs`, `contours.${i}.points`);
    }
  });
}

function checkExtent(job: CutJob, profile: CutterProfile, error: (code: ValidationCode, message: string, path?: string) => void): void {
  const extent = jobExtentMm(job);
  if (!extent) return;
  const width = extent.maxX - extent.minX;
  if (width > profile.workArea.widthMm + EXTENT_EPSILON_MM) {
    error("extent-width", `job is ${formatCompact(width, 2)} mm wide, work area is ${profile.workArea.widthMm} mm`);
  }
  const lengthLimit = profile.workArea.lengthMm;
  const length = extent.maxY - extent.minY;
  // Roll machines have an open length; flatbeds with a conveyor are segmented into steps (see segment.ts).
  if (profile.class === "flatbed" && lengthLimit !== undefined && length > lengthLimit + EXTENT_EPSILON_MM && !profile.flatbed?.conveyor) {
    error("extent-length", `job is ${formatCompact(length, 2)} mm long, bed is ${lengthLimit} mm and the machine has no conveyor`);
  }
}

function checkTools(job: CutJob, profile: CutterProfile, issue: (severity: ValidationIssue["severity"], code: ValidationCode, message: string, path?: string) => void): void {
  const usedTools = new Set(job.contours.map((c) => String(c.tool)));
  for (const tool of usedTools) {
    if (!job.toolMap[tool]) issue("error", "unmapped-tool", `semantic tool "${tool}" has no entry in toolMap`, `toolMap.${tool}`);
  }
  for (const [semantic, assignment] of Object.entries(job.toolMap) as [string, ToolAssignment][]) {
    const def = profile.tools.find((t) => t.id === assignment?.toolId);
    if (!def) {
      issue("error", "unknown-tool", `toolMap.${semantic}: tool "${String(assignment?.toolId)}" is not in the profile`, `toolMap.${semantic}.toolId`);
      continue;
    }
    for (const param of PARAM_NAMES) {
      const value = assignment[param];
      if (value === undefined) continue;
      const path = `toolMap.${semantic}.${param}`;
      const range = def.params[param];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issue("error", "param-out-of-range", `${path} must be a finite number`, path);
      } else if (!range) {
        issue("warning", "param-unsupported", `${path}: tool "${def.id}" declares no ${param} range; the value may be ignored`, path);
      } else if (!inRange(value, range)) {
        issue("error", "param-out-of-range", `${path} = ${value} is outside ${rangeText(range)}`, path);
      }
    }
  }
}

function checkRegistration(job: CutJob, profile: CutterProfile, issue: (severity: ValidationIssue["severity"], code: ValidationCode, message: string, path?: string) => void): void {
  const method = requestedRegistrationMethod(job);
  const registration = profile.registration;
  if (!registration.methods.includes(method)) {
    const hint = registration.experimental?.includes(method) ? " (experimental; enable it in the device configuration)" : "";
    issue("error", "registration-unsupported", `registration method "${method}" is not supported${hint}`, "marks.method");
  }
  if (!job.marks || job.marks.marks.length === 0) return;
  if (!job.marks.marks.some((m) => m.id === job.marks?.originMarkId)) {
    issue("error", "origin-mark-missing", `origin mark "${job.marks.originMarkId}" is not in marks`, "marks.originMarkId");
  }
  const shape = job.marks.shape ?? "circle";
  if (registration.markShapes && !registration.markShapes.includes(shape)) {
    issue("error", "mark-shape-unsupported", `mark shape "${shape}" is not supported`, "marks.shape");
  }
  const size = registration.markSizeMm;
  if (size) {
    job.marks.marks.forEach((m, i) => {
      const dMm = ptToMm(m.dPt);
      // Mark sizes are compared at 0.01 mm resolution so pt <-> mm noise doesn't fail exact-size profiles.
      const rounded = Math.round(dMm * 100) / 100;
      if (!inRange(rounded, size)) {
        issue("error", "mark-size-out-of-range", `mark ${m.id}: size ${formatCompact(dMm, 2)} mm is outside ${rangeText(size)}`, `marks.marks.${i}.dPt`);
      }
    });
  }
}

function checkPanels(job: CutJob, error: (code: ValidationCode, message: string, path?: string) => void): void {
  const markIds = new Set(job.marks?.marks.map((m) => m.id) ?? []);
  job.segmentation?.panels.forEach((panel, i) => {
    if (!(Number.isFinite(panel.y0Mm) && Number.isFinite(panel.y1Mm) && panel.y0Mm < panel.y1Mm)) {
      error("invalid-panel", `panel ${i}: y0Mm must be < y1Mm`, `segmentation.panels.${i}`);
    }
    for (const id of panel.marks) {
      if (!markIds.has(id)) error("invalid-panel", `panel ${i}: unknown mark "${id}"`, `segmentation.panels.${i}.marks`);
    }
  });
}

/** Validates a job against a profile. Never throws on bad input; every problem is reported. */
export function validateCutJob(job: CutJob, profile: CutterProfile): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const issue = (severity: ValidationIssue["severity"], code: ValidationCode, message: string, path?: string): void => {
    const entry: ValidationIssue = path === undefined ? { severity, code, message } : { severity, code, message, path };
    (severity === "error" ? errors : warnings).push(entry);
  };
  const error = (code: ValidationCode, message: string, path?: string): void => issue("error", code, message, path);

  checkGeometry(job, error);
  if (errors.length === 0) checkExtent(job, profile, error);
  checkTools(job, profile, issue);
  checkRegistration(job, profile, issue);
  checkPanels(job, error);
  return { ok: errors.length === 0, errors, warnings };
}

/** Throws `CutterDriverError("invalid-job")` listing every error. Returns the warnings otherwise. */
export function assertValidCutJob(job: CutJob, profile: CutterProfile): ValidationIssue[] {
  const report = validateCutJob(job, profile);
  if (!report.ok) {
    throw new CutterDriverError("invalid-job", report.errors.map((e) => `${e.code}: ${e.message}`).join("; "));
  }
  return report.warnings;
}
