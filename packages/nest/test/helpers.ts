import type { Layout, NestItem, Placement, RollMedia } from "../src/types.js";

export const INCH = 72;
/** Geometric tolerance for assertions (points). */
export const TOL = 1e-6;

export function roll(widthPt: number, margin = 0, maxLengthPt?: number): RollMedia {
  return {
    widthPt,
    margins: { left: margin, right: margin, lead: margin, trail: margin },
    ...(maxLengthPt !== undefined ? { maxLengthPt } : {}),
  };
}

export function item(id: string, widthPt: number, heightPt: number, extra: Partial<NestItem> = {}): NestItem {
  return { id, widthPt, heightPt, quantity: 1, rotation: "none", ...extra };
}

export function usableWidth(media: RollMedia): number {
  return media.widthPt - media.margins.left - media.margins.right;
}

/** Footprints inflated by gutter/2 per side overlap (touching is allowed). */
export function overlaps(a: Placement, b: Placement, gutter: number): boolean {
  const g = gutter / 2;
  return (
    a.xPt - g < b.xPt + b.footprint.w + g - TOL &&
    b.xPt - g < a.xPt + a.footprint.w + g - TOL &&
    a.yPt - g < b.yPt + b.footprint.h + g - TOL &&
    b.yPt - g < a.yPt + a.footprint.h + g - TOL
  );
}

/** Every geometric invariant a valid layout must satisfy; returns human-readable violations. */
export function layoutViolations(layout: Layout, media: RollMedia, gutter: number): string[] {
  const problems: string[] = [];
  const width = usableWidth(media);
  for (const p of layout.placements) {
    const panel = layout.panels[p.panel];
    const label = `${p.itemId}#${p.copy}`;
    if (!panel) {
      problems.push(`${label}: unknown panel ${p.panel}`);
      continue;
    }
    const localY = p.yPt - panel.offsetPt;
    if (p.xPt < -TOL || p.xPt + p.footprint.w > width + TOL) problems.push(`${label}: outside width`);
    if (localY < -TOL || localY + p.footprint.h > panel.lengthPt + TOL) problems.push(`${label}: outside panel`);
    if (media.maxLengthPt !== undefined && localY + p.footprint.h > media.maxLengthPt + TOL) {
      problems.push(`${label}: beyond max length`);
    }
    if (p.yPt + p.footprint.h > layout.lengthUsedPt + TOL) problems.push(`${label}: beyond length used`);
  }
  const { placements } = layout;
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i];
      const b = placements[j];
      if (a && b && a.panel === b.panel && overlaps(a, b, gutter)) {
        problems.push(`${a.itemId}#${a.copy} overlaps ${b.itemId}#${b.copy}`);
      }
    }
  }
  return problems;
}
