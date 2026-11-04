import { Type } from "@sinclair/typebox";
import { PT_PER_INCH, axisLengths, ptToMm, rectsOverlap, transformRect, type Matrix } from "@bax-print/edits";
import { defineCheck, type RawFinding } from "../check.js";

export interface EffectiveResolution {
  ppiX: number;
  ppiY: number;
  /** The lower of the two axes. */
  ppi: number;
  widthPt: number;
  heightPt: number;
}

/**
 * Effective resolution of an image at final size: pixels per inch of the placed image after
 * the CTM (which maps the image's unit square to user space), times `finalScale` (UserUnit
 * times the uniform scale of the job's edits).
 */
export function effectiveResolution(widthPx: number, heightPx: number, ctm: Matrix, finalScale: number): EffectiveResolution {
  const lengths = axisLengths(ctm);
  const widthPt = lengths.x * finalScale;
  const heightPt = lengths.y * finalScale;
  const ppiX = widthPt > 0 ? (widthPx * PT_PER_INCH) / widthPt : Number.POSITIVE_INFINITY;
  const ppiY = heightPt > 0 ? (heightPx * PT_PER_INCH) / heightPt : Number.POSITIVE_INFINITY;
  return { ppiX, ppiY, ppi: Math.min(ppiX, ppiY), widthPt, heightPt };
}

const UNIT_SQUARE = { x0: 0, y0: 0, x1: 1, y1: 1 };

/**
 * Defaults (Spec 007 FR2): wide-format work is typically viewed from 1 m or more, where about
 * 100 ppi is near the eye's resolving limit and 50 ppi shows visible pixelation.
 */
export const imageResolutionCheck = defineCheck({
  id: "image-resolution",
  title: "Effective image resolution",
  description: "Effective resolution of each placed image at final size, after the content CTM and the job's scale edits.",
  rules: {
    "below-error-threshold": { defaultSeverity: "error", description: "Below `errorBelowPpi` at final size." },
    "below-warn-threshold": { defaultSeverity: "warn", description: "Below `warnBelowPpi` at final size." },
  },
  params: Type.Object({
    warnBelowPpi: Type.Number({ minimum: 0, maximum: 10_000, default: 100 }),
    errorBelowPpi: Type.Number({ minimum: 0, maximum: 10_000, default: 50 }),
    /** Whether 1-bit stencil masks are held to the same thresholds. */
    includeImageMasks: Type.Boolean({ default: true }),
  }),
  validateParams(params) {
    return params.errorBelowPpi > params.warnBelowPpi ? ["errorBelowPpi must not exceed warnBelowPpi"] : [];
  },
  run(doc, params) {
    const findings = new Map<string, RawFinding>();
    doc.scan.images.forEach((image, index) => {
      const page = doc.pages[image.page];
      const g = page?.geometry;
      if (!page || !g || image.widthPx <= 0 || image.heightPx <= 0) return;
      if (image.imageMask && !params.includeImageMasks) return;
      // Images entirely outside the visible (cropped) artwork don't print.
      if (!rectsOverlap(transformRect(image.ctm, UNIT_SQUARE), g.visibleSource)) return;
      const finalScale = g.scaleFactor * page.userUnit;
      const res = effectiveResolution(image.widthPx, image.heightPx, image.ctm, finalScale);
      const rule =
        res.ppi < params.errorBelowPpi ? "below-error-threshold" : res.ppi < params.warnBelowPpi ? "below-warn-threshold" : null;
      if (!rule) return;
      const threshold = rule === "below-error-threshold" ? params.errorBelowPpi : params.warnBelowPpi;
      const label = image.objectRef ?? (image.inline ? "inline image" : `/${image.name}`);
      const key = `${image.page}|${image.objectRef ?? `#${index}`}|${res.ppi.toFixed(1)}`;
      const existing = findings.get(key);
      if (existing?.data) {
        existing.data.placements = Number(existing.data.placements) + 1;
        return;
      }
      findings.set(key, {
        rule,
        page: image.page,
        objectRef: image.objectRef,
        message:
          `Image ${label} on page ${image.page + 1} is ${Math.floor(res.ppi)} ppi at final size ` +
          `(${image.widthPx} × ${image.heightPx} px over ${ptToMm(res.widthPt).toFixed(1)} × ${ptToMm(res.heightPt).toFixed(1)} mm), ` +
          `below ${threshold} ppi`,
        data: {
          ppi: res.ppi,
          ppiX: res.ppiX,
          ppiY: res.ppiY,
          widthPx: image.widthPx,
          heightPx: image.heightPx,
          placedWidthMm: ptToMm(res.widthPt),
          placedHeightMm: ptToMm(res.heightPt),
          jobScale: g.scaleFactor,
          thresholdPpi: threshold,
          imageMask: image.imageMask,
          placements: 1,
        },
      });
    });
    return [...findings.values()];
  },
});
