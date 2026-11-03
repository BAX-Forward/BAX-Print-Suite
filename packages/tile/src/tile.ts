import {
  axisProblems,
  axisSpans,
  DEFAULT_SEAM,
  MAX_PANELS_PER_AXIS,
  minUniformCount,
  seamsError,
  treatmentError,
  uniformSeams,
  type AxisSpan,
} from "./axis.js";
import { panelLabel, panelLabelParts } from "./labels.js";
import type {
  Mm,
  Panel,
  PanelNaming,
  RectMm,
  SeamTreatment,
  SizeAccounting,
  TileIssue,
  TileLimits,
  TilePage,
  TileResult,
  TileSpec,
} from "./types.js";
import { EPS_MM, isFiniteNumber, rect } from "./units.js";

type Axis = "x" | "y";

/** The usable width across the medium: the narrower of printable width and medium width. */
export function widthLimitMm(limits: TileLimits): Mm | undefined {
  const defined = [limits.printableWidthMm, limits.mediaWidthMm].filter((v): v is number => v !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

/** Treatment of seam `i` on an axis: its individual entry, else the spec default, else a 25 mm overlap. */
export function seamTreatmentAt(spec: TileSpec, axis: Axis): (seamIndex: number) => SeamTreatment {
  const list = axis === "x" ? spec.seamTreatmentsX : spec.seamTreatmentsY;
  const fallback = spec.seam ?? DEFAULT_SEAM;
  return (i) => list?.[i] ?? fallback;
}

/**
 * Split artwork into panels (FR1–FR3, FR5).
 *
 * Never throws on user input: problems come back as `issues`. When the grid
 * itself is invalid `panels` is empty; when only device/medium limits fail the
 * panels are returned (so an editor can show them) and `ok` is false.
 */
export function tile(page: TilePage, spec: TileSpec, limits: TileLimits = {}): TileResult {
  const issues = validateInputs(page, spec, limits);
  if (issues.length > 0) return failed(issues);

  const accounting = spec.accounting ?? "printed";
  const bleedMm = spec.bleedMm ?? 0;
  const x = resolveAxis("x", page.widthMm, spec, accounting, bleedMm, widthLimitMm(limits), issues);
  const y = resolveAxis("y", page.heightMm, spec, accounting, bleedMm, limits.maxLengthMm, issues);
  if (!x || !y) return failed(issues);

  const rows = y.spans.length;
  const columns = x.spans.length;
  const panels: Panel[] = [];
  // Spans run bottom-up in the artwork frame; row 1 is the top row.
  for (const [r, ySpan] of y.spans.toReversed().entries()) {
    for (const [c, xSpan] of x.spans.entries()) {
      const panel = makePanel(r + 1, c + 1, panels.length + 1, xSpan, ySpan, spec.naming);
      checkSizeLimit(panel, spec, accounting, issues);
      panels.push(fitToLimits(panel, limits, issues));
    }
  }
  return { ok: issues.length === 0, panels, columns, rows, seamsX: x.seams, seamsY: y.seams, issues };
}

function failed(issues: TileIssue[]): TileResult {
  return { ok: false, panels: [], columns: 0, rows: 0, seamsX: [], seamsY: [], issues };
}

function validateInputs(page: TilePage, spec: TileSpec, limits: TileLimits): TileIssue[] {
  const issues: TileIssue[] = [];
  const positive = (v: unknown): boolean => isFiniteNumber(v) && v > 0;
  if (!positive(page.widthMm) || !positive(page.heightMm)) {
    issues.push({ code: "invalid-page", message: "artwork width and height must be finite numbers > 0" });
  }
  for (const key of ["printableWidthMm", "maxLengthMm", "mediaWidthMm"] as const) {
    const value = limits[key];
    if (value !== undefined && !positive(value)) {
      issues.push({ code: "invalid-limits", message: `${key} must be a finite number > 0` });
    }
  }
  const bleed = spec.bleedMm ?? 0;
  if (!(isFiniteNumber(bleed) && bleed >= 0)) {
    issues.push({ code: "invalid-bleed", message: "bleedMm must be a finite number >= 0" });
  }
  const checkTreatment = (t: SeamTreatment, where: string, axis?: Axis, seamIndex?: number): void => {
    const error = treatmentError(t);
    if (error) issues.push({ code: "invalid-treatment", message: `${where}: ${error}`, axis, seamIndex });
  };
  if (spec.seam) checkTreatment(spec.seam, "default seam");
  spec.seamTreatmentsX?.forEach((t, i) => {
    if (t) checkTreatment(t, `x seam ${i}`, "x", i);
  });
  spec.seamTreatmentsY?.forEach((t, i) => {
    if (t) checkTreatment(t, `y seam ${i}`, "y", i);
  });
  return issues;
}

function resolveAxis(
  axis: Axis,
  length: Mm,
  spec: TileSpec,
  accounting: SizeAccounting,
  bleedMm: Mm,
  printedLimitMm: Mm | undefined,
  issues: TileIssue[],
): { seams: Mm[]; spans: AxisSpan[] } | undefined {
  const seams = resolveSeams(axis, length, spec, accounting, bleedMm, printedLimitMm, issues);
  if (!seams) return undefined;
  const treatmentAt = seamTreatmentAt(spec, axis);
  const spans = axisSpans(length, seams, seams.map((_, i) => treatmentAt(i)), bleedMm);
  const problems = axisProblems(spans);
  for (const p of problems) issues.push({ ...p, axis, message: `${axis}: ${p.message}` });
  return problems.length === 0 ? { seams, spans } : undefined;
}

function resolveSeams(
  axis: Axis,
  length: Mm,
  spec: TileSpec,
  accounting: SizeAccounting,
  bleedMm: Mm,
  printedLimitMm: Mm | undefined,
  issues: TileIssue[],
): Mm[] | undefined {
  const explicit = axis === "x" ? spec.seamsX : spec.seamsY;
  if (explicit) {
    const error = seamsError(length, explicit);
    if (error) {
      issues.push({ code: "invalid-seam", axis, message: `${axis}: ${error}` });
      return undefined;
    }
    return [...explicit];
  }

  const grid = spec.grid;
  if (grid.mode === "count") {
    const count = axis === "x" ? grid.columns : grid.rows;
    if (!Number.isInteger(count) || count < 1 || count > MAX_PANELS_PER_AXIS) {
      issues.push({
        code: "invalid-grid",
        axis,
        message: `${axis === "x" ? "columns" : "rows"} must be an integer from 1 to ${MAX_PANELS_PER_AXIS}`,
      });
      return undefined;
    }
    return uniformSeams(length, count);
  }

  if (grid.mode === "size") {
    const maxMm = axis === "x" ? grid.maxWidthMm : grid.maxHeightMm;
    if (maxMm !== undefined && !(isFiniteNumber(maxMm) && maxMm > 0)) {
      issues.push({ code: "invalid-grid", axis, message: `${axis}: maximum panel size must be a finite number > 0` });
      return undefined;
    }
    // Size mode assumes unrotated panels; suggest() also considers rotation.
    const count = minUniformCount(length, seamTreatmentAt(spec, axis), bleedMm, { maxMm, accounting, printedLimitMm });
    if (count === undefined) {
      issues.push({
        code: "no-grid-fits",
        axis,
        message: `${axis}: no grid of up to ${MAX_PANELS_PER_AXIS} panels fits the size limits (overlap and bleed may exceed the limit)`,
      });
      return undefined;
    }
    return uniformSeams(length, count);
  }

  issues.push({ code: "invalid-grid", message: `unknown grid mode "${String((grid as { mode?: unknown }).mode)}"` });
  return undefined;
}

function makePanel(row: number, col: number, index: number, x: AxisSpan, y: AxisSpan, naming?: PanelNaming): Panel {
  return {
    id: `${row}-${col}`,
    row,
    col,
    index,
    label: panelLabel(row, col, naming),
    labelParts: panelLabelParts(row, col, naming),
    visible: rect(x.visLo, y.visLo, x.visHi - x.visLo, y.visHi - y.visLo),
    printed: rect(x.prLo, y.prLo, x.prHi - x.prLo, y.prHi - y.prLo),
    edges: { left: x.loEdge, right: x.hiEdge, bottom: y.loEdge, top: y.hiEdge },
    overlapMm: { left: x.loOverlap, right: x.hiOverlap, bottom: y.loOverlap, top: y.hiOverlap },
    rotate: false,
  };
}

/** A `size` grid's limits also bind explicitly positioned seams. */
function checkSizeLimit(panel: Panel, spec: TileSpec, accounting: SizeAccounting, issues: TileIssue[]): void {
  if (spec.grid.mode !== "size") return;
  const measured: RectMm = accounting === "visible" ? panel.visible : panel.printed;
  const { maxWidthMm, maxHeightMm } = spec.grid;
  if (maxWidthMm !== undefined && measured.width > maxWidthMm + EPS_MM) {
    issues.push({
      code: "exceeds-size-limit",
      panelId: panel.id,
      message: `panel ${panel.label}: ${accounting} width ${round(measured.width)} mm exceeds ${maxWidthMm} mm`,
    });
  }
  if (maxHeightMm !== undefined && measured.height > maxHeightMm + EPS_MM) {
    issues.push({
      code: "exceeds-size-limit",
      panelId: panel.id,
      message: `panel ${panel.label}: ${accounting} height ${round(measured.height)} mm exceeds ${maxHeightMm} mm`,
    });
  }
}

/** FR3: validate the printed size against the device and medium; turn the panel if allowed and needed. */
function fitToLimits(panel: Panel, limits: TileLimits, issues: TileIssue[]): Panel {
  const across = widthLimitMm(limits);
  const along = limits.maxLengthMm;
  const fitsAs = (w: Mm, h: Mm): boolean =>
    (across === undefined || w <= across + EPS_MM) && (along === undefined || h <= along + EPS_MM);
  const { width, height } = panel.printed;

  if (fitsAs(width, height)) return panel;
  if (limits.allowRotation && fitsAs(height, width)) return { ...panel, rotate: true };

  const exceeded = (code: TileIssue["code"], what: string, size: Mm, limit: Mm): void => {
    issues.push({
      code,
      panelId: panel.id,
      message: `panel ${panel.label}: printed size ${round(size)} mm exceeds the ${what} of ${limit} mm`,
    });
  };
  if (limits.printableWidthMm !== undefined && width > limits.printableWidthMm + EPS_MM) {
    exceeded("exceeds-printable-width", "printable width", width, limits.printableWidthMm);
  }
  if (limits.mediaWidthMm !== undefined && width > limits.mediaWidthMm + EPS_MM) {
    exceeded("exceeds-media-width", "medium width", width, limits.mediaWidthMm);
  }
  if (along !== undefined && height > along + EPS_MM) {
    exceeded("exceeds-max-length", "maximum length", height, along);
  }
  return panel;
}

function round(mm: Mm): number {
  return Math.round(mm * 100) / 100;
}
