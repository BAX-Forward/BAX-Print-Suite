import type { ClipBox } from "./types.js";

/** Slack for a clip box that touches the source box edge (mm-to-pt rounding). */
export const CLIP_BOX_TOLERANCE_PT = 1e-6;

export type ClipBoxProblemCode = "invalid-clip-box" | "clip-outside-source";

export interface ClipBoxProblem {
  readonly code: ClipBoxProblemCode;
  readonly message: string;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function describeBox(box: Box): string {
  return `[${box.x}, ${box.y}, ${box.width}×${box.height}]`;
}

/** Why `clip` cannot be drawn from `box` (the source page box), or undefined if it can. */
export function clipBoxProblem(clip: ClipBox, box: Box): ClipBoxProblem | undefined {
  const { x, y, width, height } = clip;
  if (![x, y, width, height].every((value) => Number.isFinite(value))) {
    return { code: "invalid-clip-box", message: `clip box ${describeBox(clip)} has a non-finite value` };
  }
  if (width <= 0 || height <= 0) {
    return { code: "invalid-clip-box", message: `clip box ${describeBox(clip)} must have width and height > 0` };
  }
  const tol = CLIP_BOX_TOLERANCE_PT;
  const inside =
    x >= box.x - tol &&
    y >= box.y - tol &&
    x + width <= box.x + box.width + tol &&
    y + height <= box.y + box.height + tol;
  return inside
    ? undefined
    : {
        code: "clip-outside-source",
        message: `clip box ${describeBox(clip)} is outside the source box ${describeBox(box)}`,
      };
}
