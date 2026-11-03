// Units, origin and axes shared by all exporters (spec 004 Part C).
// Input: contour points in pt, relative to the CutFrame bottom-left, y up.
// Output: mm in the cutter frame. Order of operations:
//   1. translate to the origin (origin mark center if marks are present and
//      `useMarkOrigin`, otherwise the frame corner named by `origin`),
//   2. flip axes so they point away from that corner,
//   3. optionally swap X and Y (cutters whose X axis is the feed axis),
//   4. scale (calibration), then add `offsetMm`.

import { CORNERS, CutterDriverError, type Corner, type CutJob, type Point } from "@bax-print/plugin-sdk";
import { ptToMm } from "./geometry.js";

export interface FrameOptions {
  origin?: Corner;
  swapXY?: boolean;
  offsetMm?: [number, number];
  scale?: [number, number];
  /** Use the origin mark center as origin when marks are present (default true). */
  useMarkOrigin?: boolean;
}

export const FRAME_OPTIONS_SCHEMA = {
  origin: { type: "string", enum: [...CORNERS], default: "bottom-left" },
  swapXY: { type: "boolean", default: false },
  offsetMm: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, default: [0, 0] },
  scale: { type: "array", items: { type: "number", exclusiveMinimum: 0 }, minItems: 2, maxItems: 2, default: [1, 1] },
} as const;

export type FrameTransform = (pointPt: Point) => Point;

function originPointPt(job: Pick<CutJob, "frame" | "marks">, origin: Corner, useMarkOrigin: boolean): Point {
  if (useMarkOrigin && job.marks) {
    const mark = job.marks.marks.find((m) => m.id === job.marks?.originMarkId);
    if (!mark) throw new CutterDriverError("invalid-job", `origin mark "${job.marks.originMarkId}" not found in marks`);
    return [mark.xPt, mark.yPt];
  }
  const x = origin.endsWith("right") ? job.frame.widthPt : 0;
  const y = origin.startsWith("top") ? job.frame.heightPt : 0;
  return [x, y];
}

/** Returns a function mapping frame points (pt) to cutter-frame coordinates (mm). */
export function createFrameTransform(job: Pick<CutJob, "frame" | "marks">, options: FrameOptions = {}): FrameTransform {
  const origin = options.origin ?? "bottom-left";
  const [ox, oy] = originPointPt(job, origin, options.useMarkOrigin ?? true);
  const sx = origin.endsWith("right") ? -1 : 1;
  const sy = origin.startsWith("top") ? -1 : 1;
  const [scaleX, scaleY] = options.scale ?? [1, 1];
  const [offsetX, offsetY] = options.offsetMm ?? [0, 0];
  const swap = options.swapXY ?? false;
  return ([x, y]) => {
    const u = sx * ptToMm(x - ox);
    const v = sy * ptToMm(y - oy);
    const [a, b] = swap ? [v, u] : [u, v];
    return [a * scaleX + offsetX, b * scaleY + offsetY];
  };
}

function isFiniteTuple(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number" && Number.isFinite(v));
}

/** Validates frame options taken from untrusted `CutJob.options`. Unknown keys are ignored. */
export function parseFrameOptions(raw: Record<string, unknown>): FrameOptions {
  const out: FrameOptions = {};
  if (raw.origin !== undefined) {
    if (!CORNERS.includes(raw.origin as Corner)) throw new CutterDriverError("invalid-options", `origin must be one of ${CORNERS.join(", ")}`);
    out.origin = raw.origin as Corner;
  }
  if (raw.swapXY !== undefined) {
    if (typeof raw.swapXY !== "boolean") throw new CutterDriverError("invalid-options", "swapXY must be a boolean");
    out.swapXY = raw.swapXY;
  }
  if (raw.offsetMm !== undefined) {
    if (!isFiniteTuple(raw.offsetMm)) throw new CutterDriverError("invalid-options", "offsetMm must be [x, y] in mm");
    out.offsetMm = [raw.offsetMm[0], raw.offsetMm[1]];
  }
  if (raw.scale !== undefined) {
    if (!isFiniteTuple(raw.scale) || raw.scale[0] <= 0 || raw.scale[1] <= 0) {
      throw new CutterDriverError("invalid-options", "scale must be [sx, sy] with positive factors");
    }
    out.scale = [raw.scale[0], raw.scale[1]];
  }
  return out;
}
