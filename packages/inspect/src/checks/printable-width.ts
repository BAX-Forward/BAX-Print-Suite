import { Type } from "@sinclair/typebox";
import { ptToMm } from "@bax-print/edits";
import { defineCheck, type RawFinding } from "../check.js";

/** Upper bound for the `printableWidthMm` parameter: a sanity limit, not a device width. */
const MAX_PRINTABLE_WIDTH_MM = 10_000;

/**
 * Finished size (after job edits, including bleed or a page size override) against the
 * printable width of the target medium, in both orientations.
 */
export const printableWidthCheck = defineCheck({
  id: "printable-width",
  title: "Printable width",
  description:
    "The finished size after job edits fits the printable width of the target medium, as placed or rotated by 90°.",
  rules: {
    "exceeds-printable-width": {
      defaultSeverity: "error",
      description: "Wider than the printable width in both orientations.",
    },
    "fits-rotated-only": {
      defaultSeverity: "info",
      description: "Fits the printable width only when rotated by 90°.",
    },
    "unknown-printable-width": {
      defaultSeverity: "info",
      description: "No printable width is known for the job, so the check could not run.",
    },
  },
  params: Type.Object({
    /** Used when the job's medium or device does not state a printable width. */
    printableWidthMm: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_PRINTABLE_WIDTH_MM })),
    toleranceMm: Type.Number({ minimum: 0, maximum: 100, default: 0 }),
  }),
  run(doc, params) {
    const printable = doc.context.printableWidthMm ?? params.printableWidthMm;
    if (printable === undefined) {
      return [{ rule: "unknown-printable-width", message: "No printable width is known for the target medium", data: {} }];
    }
    const findings: RawFinding[] = [];
    for (const page of doc.pages) {
      const g = page.geometry;
      if (!g) continue;
      const widthMm = ptToMm(g.footprintWidthPt);
      const heightMm = ptToMm(g.footprintHeightPt);
      const limit = printable + params.toleranceMm;
      if (widthMm <= limit) continue;
      const size = `${widthMm.toFixed(1)} × ${heightMm.toFixed(1)} mm`;
      const data = { widthMm, heightMm, printableWidthMm: printable };
      findings.push(
        heightMm <= limit
          ? {
              rule: "fits-rotated-only",
              page: page.index,
              message: `Page ${page.index + 1} (${size}) fits the ${printable} mm printable width only when rotated by 90°`,
              data,
            }
          : {
              rule: "exceeds-printable-width",
              page: page.index,
              message: `Page ${page.index + 1} (${size}) is wider than the ${printable} mm printable width in both orientations; scale or tile it`,
              data,
            },
      );
    }
    return findings;
  },
});
