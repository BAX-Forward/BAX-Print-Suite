import { Type } from "@sinclair/typebox";
import { PDFArray, PDFName, type PDFDict } from "pdf-lib";
import { defineCheck, sortedPages, type RawFinding } from "../check.js";
import { boolIn, lookupIn, nameIn, nameText, numberIn } from "../pdf-objects.js";

const NORMAL_BLEND_MODES = new Set(["Normal", "Compatible"]);

/** Reasons a graphics state introduces transparency (ISO 32000-1 §11.6.4, Table 58). */
function transparencyReasons(gs: PDFDict): string[] {
  const reasons: string[] = [];
  const smask = lookupIn(gs, "SMask");
  if (smask !== undefined && nameIn(gs, "SMask") !== "None") reasons.push("soft mask");
  const strokeAlpha = numberIn(gs, "CA");
  const fillAlpha = numberIn(gs, "ca");
  if ((strokeAlpha !== undefined && strokeAlpha < 1) || (fillAlpha !== undefined && fillAlpha < 1)) reasons.push("constant alpha");
  const bm = lookupIn(gs, "BM");
  const modes = bm instanceof PDFArray ? bm.asArray() : bm !== undefined ? [bm] : [];
  const blend = modes.filter((m): m is PDFName => m instanceof PDFName).map(nameText);
  const first = blend[0];
  if (first !== undefined && !NORMAL_BLEND_MODES.has(first)) reasons.push(`blend mode ${first}`);
  return reasons;
}

function addTo(map: Map<number, Set<string>>, page: number, reason: string): void {
  const set = map.get(page) ?? new Set<string>();
  set.add(reason);
  map.set(page, set);
}

/** Transparency and overprint use, per page. Both are informational by default; profiles may raise them. */
export const transparencyOverprintCheck = defineCheck({
  id: "transparency-overprint",
  title: "Transparency and overprint",
  description: "Reports pages that use transparency (groups, soft masks, alpha, blend modes) or overprint.",
  rules: {
    transparency: { defaultSeverity: "info", description: "The page uses transparency." },
    overprint: { defaultSeverity: "info", description: "The page sets overprint for fills or strokes." },
  },
  params: Type.Object({}),
  run(doc) {
    const transparency = new Map<number, Set<string>>();
    const overprint = new Map<number, { fill: boolean; stroke: boolean; mode: number }>();

    for (const group of doc.scan.transparencyGroups) {
      addTo(transparency, group.page, group.objectRef ? "transparency group" : "page transparency group");
    }
    for (const image of doc.scan.images) {
      if (image.softMask) addTo(transparency, image.page, "image soft mask");
    }
    for (const gs of doc.scan.gstates.values()) {
      const reasons = transparencyReasons(gs.dict);
      const stroke = boolIn(gs.dict, "OP") === true;
      // `op` defaults to `OP` when absent (ISO 32000-1 Table 58).
      const fill = boolIn(gs.dict, "op") ?? stroke;
      const mode = numberIn(gs.dict, "OPM") ?? 0;
      for (const page of gs.pages) {
        reasons.forEach((reason) => addTo(transparency, page, reason));
        if (!fill && !stroke) continue;
        const current = overprint.get(page) ?? { fill: false, stroke: false, mode: 0 };
        overprint.set(page, { fill: current.fill || fill, stroke: current.stroke || stroke, mode: Math.max(current.mode, mode) });
      }
    }

    const findings: RawFinding[] = [];
    for (const page of sortedPages(transparency.keys())) {
      const reasons = [...(transparency.get(page) ?? [])].sort();
      findings.push({
        rule: "transparency",
        page,
        message: `Page ${page + 1} uses transparency (${reasons.join(", ")})`,
        data: { reasons },
      });
    }
    for (const page of sortedPages(overprint.keys())) {
      const op = overprint.get(page);
      if (!op) continue;
      const parts = [op.fill ? "fill" : "", op.stroke ? "stroke" : ""].filter(Boolean).join(" and ");
      findings.push({
        rule: "overprint",
        page,
        message: `Page ${page + 1} sets overprint for ${parts} (mode ${op.mode})`,
        data: op,
      });
    }
    return findings;
  },
});
