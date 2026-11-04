import { Type } from "@sinclair/typebox";
import { rectContains } from "@bax-print/edits";
import { defineCheck, formatRect, formatSize, type RawFinding } from "../check.js";

/** Page boxes present and nested: TrimBox ⊆ BleedBox ⊆ MediaBox (ISO 32000-1 §14.11.2). */
export const pageBoxesCheck = defineCheck({
  id: "page-boxes",
  title: "Page boxes",
  description: "Page boxes are present and nested: TrimBox inside BleedBox inside MediaBox (ISO 32000-1 §14.11.2).",
  rules: {
    "missing-trim-box": { defaultSeverity: "warn", description: "No TrimBox; the MediaBox is used as the finished size." },
    "missing-media-box": { defaultSeverity: "error", description: "No MediaBox on the page or its ancestors." },
    "invalid-box": { defaultSeverity: "error", description: "A box is present but not a rectangle with positive area." },
    "trim-outside-bleed": { defaultSeverity: "error", description: "TrimBox extends outside the BleedBox." },
    "bleed-outside-media": { defaultSeverity: "error", description: "BleedBox extends outside the MediaBox." },
    "trim-outside-media": { defaultSeverity: "error", description: "TrimBox extends outside the MediaBox." },
  },
  params: Type.Object({
    /** Slack for rounding in the producing application. */
    tolerancePt: Type.Number({ minimum: 0, maximum: 72, default: 0.01 }),
  }),
  run(doc, params) {
    const findings: RawFinding[] = [];
    for (const page of doc.pages) {
      const n = page.index + 1;
      const { MediaBox: media, BleedBox: bleed, TrimBox: trim } = page.boxes;
      for (const box of page.invalidBoxes) {
        findings.push({ rule: "invalid-box", page: page.index, message: `Page ${n}: ${box} is not a valid rectangle`, data: { box } });
      }
      if (!media && !page.invalidBoxes.includes("MediaBox")) {
        findings.push({ rule: "missing-media-box", page: page.index, message: `Page ${n} has no MediaBox`, data: {} });
      }
      if (!trim && !page.invalidBoxes.includes("TrimBox")) {
        const size = media ? ` (${formatSize(media.x1 - media.x0, media.y1 - media.y0)})` : "";
        findings.push({
          rule: "missing-trim-box",
          page: page.index,
          message: `Page ${n} has no TrimBox; the MediaBox${size} is used as the finished size`,
          data: { mediaBox: media },
        });
      }
      const nesting: [string, typeof trim, typeof trim, string, string][] = [
        ["trim-outside-bleed", trim, bleed, "TrimBox", "BleedBox"],
        ["bleed-outside-media", bleed, media, "BleedBox", "MediaBox"],
        ["trim-outside-media", trim, media, "TrimBox", "MediaBox"],
      ];
      for (const [rule, inner, outer, innerName, outerName] of nesting) {
        if (!inner || !outer || rectContains(outer, inner, params.tolerancePt)) continue;
        findings.push({
          rule,
          page: page.index,
          message: `Page ${n}: ${innerName} ${formatRect(inner)} extends outside the ${outerName} ${formatRect(outer)}`,
          data: { [innerName]: inner, [outerName]: outer },
        });
      }
    }
    return findings;
  },
});
