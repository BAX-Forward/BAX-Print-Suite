/**
 * FR7: panels as nestable items.
 *
 * `PanelNestItem` is structurally a Spec 003 `NestItem` plus a `clipBox`; the
 * imposer embeds the source page as a Form XObject and clips it to that box
 * (no rasterization). Until `packages/nest` honours `clipBox`, `panelPdf()`
 * produces the same clipped pages directly.
 */
import type { Panel } from "./types.js";
import { mmToPt } from "./units.js";

export interface ClipBoxPt {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelSource {
  jobId?: string;
  pageIndex: number;
  /** Bottom-left of the source page's TrimBox in PDF user space (pt). */
  trimOriginPt: { x: number; y: number };
}

export interface PanelNestItem {
  id: string;
  jobId?: string;
  pageIndex: number;
  widthPt: number;
  heightPt: number;
  quantity: number;
  rotation: "none";
  /** Panels are validated in one orientation; the lock keeps the nester to it. */
  lock: { orientation: 0 | 90 };
  /** The panel's printed area in the source page's user space (pt). */
  clipBox: ClipBoxPt;
  panel: { id: string; row: number; col: number; index: number; label: string };
}

/** The printed area of a panel in the source page's user space. */
export function panelClipBox(panel: Panel, trimOriginPt: { x: number; y: number }): ClipBoxPt {
  return {
    x: trimOriginPt.x + mmToPt(panel.printed.x),
    y: trimOriginPt.y + mmToPt(panel.printed.y),
    width: mmToPt(panel.printed.width),
    height: mmToPt(panel.printed.height),
  };
}

/** Item id: `<jobId>/panel/<row>-<col>`, so a reprint (Spec 008) can name one panel. */
export function panelItemId(panelId: string, jobId?: string): string {
  return jobId ? `${jobId}/panel/${panelId}` : `panel/${panelId}`;
}

export function toNestItems(panels: readonly Panel[], source: PanelSource): PanelNestItem[] {
  return panels.map((panel) => {
    const clipBox = panelClipBox(panel, source.trimOriginPt);
    return {
      id: panelItemId(panel.id, source.jobId),
      ...(source.jobId !== undefined ? { jobId: source.jobId } : {}),
      pageIndex: source.pageIndex,
      widthPt: clipBox.width,
      heightPt: clipBox.height,
      quantity: 1,
      rotation: "none",
      lock: { orientation: panel.rotate ? 90 : 0 },
      clipBox,
      panel: { id: panel.id, row: panel.row, col: panel.col, index: panel.index, label: panel.label },
    };
  });
}
