/**
 * Generic crop and bleed mark geometry in points (Spec 046a).
 *
 * Thin, validated wrappers around `cropSegments()` in marks-local.ts: the
 * corner lines are computed there and translated here into the sheet frame.
 */
import { MarkSpecError } from "./errors.js";
import type { Segment } from "./geometry.js";
import { cropSegments } from "./marks-local.js";

/** Largest trim side, and largest trim x / y, in points (200 in). */
export const MAX_MARK_SHEET_SIDE_PT = 14_400;
/** Largest bleed, offset or mark length, in points (10 in). */
export const MAX_MARK_DISTANCE_PT = 720;
/** Largest stroke weight, in points. */
export const MAX_MARK_LINE_WEIGHT_PT = 36;

/** Matches the CropMarkSchema default; only passed through, never drawn here. */
const DEFAULT_LINE_WEIGHT_PT = 0.25;

export interface TrimBox {
  /** Bottom-left corner of the trim box, in points. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CornerMarkInput {
  readonly trim: TrimBox;
  /** Bleed around every trim edge, in points. */
  readonly bleed: number;
  /** Gap between the bleed box and the start of each mark, in points. */
  readonly offset: number;
  /** Length of each mark line, in points. */
  readonly length: number;
  /** Stroke weight the caller will draw with; validated only, the segments are centrelines. */
  readonly lineWeight?: number;
}

function checkNumber(issues: string[], name: string, value: number, max: number, positive: boolean): void {
  if (!Number.isFinite(value)) {
    issues.push(`${name} must be a finite number, got ${String(value)}`);
  } else if (positive ? value <= 0 : value < 0) {
    issues.push(`${name} must be ${positive ? "positive" : "non-negative"}, got ${value}`);
  } else if (value > max) {
    issues.push(`${name} ${value} is over the limit of ${max}`);
  }
}

function validate(input: CornerMarkInput): void {
  const issues: string[] = [];
  const { trim } = input;
  checkNumber(issues, "trim.x", trim.x, MAX_MARK_SHEET_SIDE_PT, false);
  checkNumber(issues, "trim.y", trim.y, MAX_MARK_SHEET_SIDE_PT, false);
  checkNumber(issues, "trim.width", trim.width, MAX_MARK_SHEET_SIDE_PT, true);
  checkNumber(issues, "trim.height", trim.height, MAX_MARK_SHEET_SIDE_PT, true);
  checkNumber(issues, "bleed", input.bleed, MAX_MARK_DISTANCE_PT, false);
  checkNumber(issues, "offset", input.offset, MAX_MARK_DISTANCE_PT, false);
  checkNumber(issues, "length", input.length, MAX_MARK_DISTANCE_PT, true);
  if (input.lineWeight !== undefined) {
    checkNumber(issues, "lineWeight", input.lineWeight, MAX_MARK_LINE_WEIGHT_PT, true);
  }
  if (issues.length > 0) throw new MarkSpecError("invalid corner mark geometry", issues);
}

/** Eight corner lines for a box at (x, y), each `near` to `near + length` beyond its edges. */
function cornerLines(
  x: number,
  y: number,
  width: number,
  height: number,
  bleed: number,
  near: number,
  input: CornerMarkInput,
): Segment[] {
  const { value } = cropSegments(
    { widthMm: width, heightMm: height, bleedMm: bleed },
    { kind: "crop", offsetMm: near, lengthMm: input.length, lineWidthPt: input.lineWeight ?? DEFAULT_LINE_WEIGHT_PT },
  );
  return value.map((s) => ({ x1: x + s.x1, y1: y + s.y1, x2: x + s.x2, y2: y + s.y2 }));
}

/**
 * Crop (trim) marks: eight lines in points, two per trim corner.
 *
 * Geometry convention (PDF user space, y up; `trim.x`, `trim.y` is the trim
 * box bottom-left):
 * - Each line lies on the extension of a trim edge: the horizontal lines on
 *   y = trim.y and y = trim.y + height, the vertical lines on x = trim.x and
 *   x = trim.x + width.
 * - Each line starts `bleed + offset` beyond the trim edge it is
 *   perpendicular to (so outside trim + bleed + offset) and runs `length`
 *   outward. (x1, y1) is the inner end, (x2, y2) the outer end.
 * - Order: corners bottom-left, bottom-right, top-right, top-left; within a
 *   corner the horizontal line, then the vertical line.
 * - Segments are centrelines; with butt caps a stroke of any width stays
 *   outside the trim + bleed + offset box.
 *
 * Throws `MarkSpecError` when a number is not finite, is negative (trim width,
 * height and length must be positive) or is over its MAX_MARK_* limit.
 */
export function cropMarkSegments(input: CornerMarkInput): Segment[] {
  validate(input);
  const { trim, bleed, offset } = input;
  // cropSegments starts at max(offset, bleed); bleed + offset is never below bleed.
  return cornerLines(trim.x, trim.y, trim.width, trim.height, bleed, bleed + offset, input);
}

/**
 * Bleed marks: eight lines in points, two per bleed box corner.
 *
 * Same convention as `cropMarkSegments()`, but each line lies on the extension
 * of a bleed box edge (trim grown by `bleed` on every side) and starts
 * `offset` beyond the bleed box, i.e. `bleed + offset` beyond the trim. With
 * zero bleed the bleed marks coincide with the crop marks.
 *
 * Throws `MarkSpecError` on the same inputs as `cropMarkSegments()`.
 */
export function bleedMarkSegments(input: CornerMarkInput): Segment[] {
  validate(input);
  const { trim, bleed, offset } = input;
  const width = trim.width + 2 * bleed;
  const height = trim.height + 2 * bleed;
  return cornerLines(trim.x - bleed, trim.y - bleed, width, height, 0, offset, input);
}
