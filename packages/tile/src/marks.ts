/**
 * Geometry for panel labels (FR5) and seam alignment ticks (FR6).
 *
 * This module only computes where things go; `packages/marks` (Spec 006)
 * draws them in the `BPS Marks` optional-content group. All output is in the
 * **panel frame**: mm from the bottom-left corner of the panel's printed area.
 */
import type { Mm, Panel, RectMm, Side } from "./types.js";
import { EPS_MM, rect } from "./units.js";

/** Long enough to find by eye on the wall, short enough to stay at the panel ends. */
export const DEFAULT_TICK_LENGTH_MM = 5;

/** Default clearance between a label and the edges of the strip it sits in. */
export const DEFAULT_LABEL_INSET_MM = 2;

/**
 * Panels are usually hung left to right and top to bottom, each one lapping
 * over the one hung before it. That hides the earlier panel's right and bottom
 * overlap strips, so those are where a hidden label goes by default.
 */
export const DEFAULT_UNDER_SIDES: readonly Side[] = ["right", "bottom"];

/** Values for Spec 006 label templates (`{{panel.row}}`, `{{panel.col}}`). */
export function panelTemplateFields(panel: Panel): { "panel.row": string; "panel.col": string } {
  return { "panel.row": panel.labelParts.row, "panel.col": panel.labelParts.col };
}

/** The overlap strip printed past the seam on one side, in the artwork frame (undefined if none). */
export function overlapStrip(panel: Panel, side: Side): RectMm | undefined {
  const ov = panel.overlapMm[side];
  if (panel.edges[side] !== "overlap" || ov <= EPS_MM) return undefined;
  const v = panel.visible;
  switch (side) {
    case "right":
      return rect(v.x + v.width, v.y, ov, v.height);
    case "left":
      return rect(v.x - ov, v.y, ov, v.height);
    case "top":
      return rect(v.x, v.y + v.height, v.width, ov);
    case "bottom":
      return rect(v.x, v.y - ov, v.width, ov);
  }
}

export interface LabelPlacementOptions {
  /** Label block size as read: text runs along `widthMm`. */
  widthMm: Mm;
  heightMm: Mm;
  /** Sides tucked under a neighbour after installation, in order of preference. */
  underSides?: readonly Side[];
  insetMm?: Mm;
}

export interface LabelPlacement {
  /** Footprint on the panel, panel frame. */
  box: RectMm;
  /** 90 = text runs bottom to top, used in vertical strips. */
  rotation: 0 | 90;
  /** Where it went: an overlap strip, or the visible area's bottom-left corner as a fallback. */
  side: Side | "inside";
  /** True when the label will be covered after installation. */
  hidden: boolean;
}

/**
 * Place a panel label in the first hidden overlap strip that can hold it,
 * centred in the strip. Falls back to the visible area's bottom-left corner
 * (`hidden: false`) so the caller can warn that the label will show.
 */
export function placePanelLabel(panel: Panel, options: LabelPlacementOptions): LabelPlacement {
  const inset = options.insetMm ?? DEFAULT_LABEL_INSET_MM;
  const toPanel = (r: RectMm): RectMm => rect(r.x - panel.printed.x, r.y - panel.printed.y, r.width, r.height);

  for (const side of options.underSides ?? DEFAULT_UNDER_SIDES) {
    const strip = overlapStrip(panel, side);
    if (!strip) continue;
    const vertical = side === "left" || side === "right";
    const footprintW = vertical ? options.heightMm : options.widthMm;
    const footprintH = vertical ? options.widthMm : options.heightMm;
    if (footprintW + 2 * inset > strip.width + EPS_MM || footprintH + 2 * inset > strip.height + EPS_MM) continue;
    const box = rect(
      strip.x + (strip.width - footprintW) / 2,
      strip.y + (strip.height - footprintH) / 2,
      footprintW,
      footprintH,
    );
    return { box: toPanel(box), rotation: vertical ? 90 : 0, side, hidden: true };
  }

  const v = panel.visible;
  return {
    box: toPanel(rect(v.x + inset, v.y + inset, options.widthMm, options.heightMm)),
    rotation: 0,
    side: "inside",
    hidden: false,
  };
}

export interface SeamTick {
  panelId: string;
  /** The seam's own side of this panel. */
  side: Side;
  from: [Mm, Mm];
  to: [Mm, Mm];
}

/**
 * FR6: short ticks on the seam line at both ends of each overlap seam, so
 * neighbours line up. Both neighbours carry ticks, since both print past the
 * seam. Butt and gap seams get none (there is no shared strip to mark).
 */
export function seamTicks(panel: Panel, lengthMm: Mm = DEFAULT_TICK_LENGTH_MM): SeamTick[] {
  const { printed, visible } = panel;
  const ticks: SeamTick[] = [];
  const add = (side: Side, from: [Mm, Mm], to: [Mm, Mm]): void => {
    ticks.push({ panelId: panel.id, side, from, to });
  };

  for (const side of ["left", "right"] as const) {
    if (panel.edges[side] !== "overlap") continue;
    const x = (side === "left" ? visible.x : visible.x + visible.width) - printed.x;
    const len = Math.min(lengthMm, printed.height / 2);
    add(side, [x, 0], [x, len]);
    add(side, [x, printed.height - len], [x, printed.height]);
  }
  for (const side of ["bottom", "top"] as const) {
    if (panel.edges[side] !== "overlap") continue;
    const y = (side === "bottom" ? visible.y : visible.y + visible.height) - printed.y;
    const len = Math.min(lengthMm, printed.width / 2);
    add(side, [0, y], [len, y]);
    add(side, [printed.width - len, y], [printed.width, y]);
  }
  return ticks;
}
