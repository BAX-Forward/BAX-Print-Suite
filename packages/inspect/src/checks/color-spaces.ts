import { Type } from "@sinclair/typebox";
import { mapColorant, spotMappingsOf } from "@bax-print/edits";
import { defineCheck, formatPages, sortedPages, type RawFinding } from "../check.js";
import { isSpotColorant } from "../colorspace.js";

/**
 * Colour spaces used and named colorants of Separation/DeviceN spaces (ISO 32000-1 §8.6.6).
 * Colorants matching the job's cut-contour names (Spec 004 `CutConfig.spotNames`) are listed
 * as cut contours. `spotMap` edits are honoured: a mapped colorant is judged by its new name.
 */
export const colorSpacesCheck = defineCheck({
  id: "color-spaces",
  title: "Colour spaces and named colorants",
  description: "Lists the colour spaces and named colorants used, and identifies the cut-contour colorants.",
  rules: {
    "color-spaces-used": { defaultSeverity: "info", description: "Summary of colour space families used." },
    "spot-colorant": { defaultSeverity: "info", description: "A named (spot) colorant is used." },
    "cut-contour-colorant": { defaultSeverity: "info", description: "A colorant matches a configured cut-contour name." },
    "cut-contour-missing": {
      defaultSeverity: "info",
      description: "Cut-contour names are configured but none is used in the file.",
    },
    "disallowed-color-space": {
      defaultSeverity: "error",
      description: "A colour space family listed in `disallowedFamilies` is used.",
    },
  },
  params: Type.Object({
    /** Added to the job's configured cut-contour names. Matched exactly, as names are case-sensitive in PDF. */
    cutSpotNames: Type.Array(Type.String({ minLength: 1, maxLength: 127 }), { default: [], maxItems: 100 }),
    /** E.g. `["DeviceRGB"]` for a CMYK-only workflow. */
    disallowedFamilies: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { default: [], maxItems: 20 }),
  }),
  run(doc, params) {
    const findings: RawFinding[] = [];
    const families = new Map<string, Set<number>>();
    const colorants = new Map<string, Set<number>>();
    for (const use of doc.scan.colors.values()) {
      const pages = families.get(use.space.family) ?? new Set<number>();
      use.pages.forEach((p) => pages.add(p));
      families.set(use.space.family, pages);
      for (const name of use.space.colorants.filter(isSpotColorant)) {
        const colorantPages = colorants.get(name) ?? new Set<number>();
        use.pages.forEach((p) => colorantPages.add(p));
        colorants.set(name, colorantPages);
      }
    }

    if (families.size > 0) {
      const familyList = [...families.keys()].sort();
      findings.push({
        rule: "color-spaces-used",
        message: `Colour spaces used: ${familyList.join(", ")}`,
        data: { families: familyList, colorants: [...colorants.keys()].sort() },
      });
    }

    const disallowed = new Set(params.disallowedFamilies);
    for (const [family, pages] of families) {
      if (!disallowed.has(family)) continue;
      const sorted = sortedPages(pages);
      findings.push({
        rule: "disallowed-color-space",
        page: sorted[0],
        message: `Colour space ${family} is not allowed by this profile; used on ${formatPages(sorted)}`,
        data: { family, pages: sorted },
      });
    }

    const cutNames = new Set([...(doc.context.cutSpotNames ?? []), ...params.cutSpotNames]);
    const mappings = spotMappingsOf(doc.context.edits ?? []);
    let cutFound = false;
    for (const [name, pageSet] of [...colorants].sort(([a], [b]) => a.localeCompare(b))) {
      const pages = sortedPages(pageSet);
      const target = mapColorant(mappings, name);
      const effective = target.kind === "colorant" ? target.name : null;
      const mappedTo = effective === name ? undefined : (effective ?? "process");
      const isCut = effective !== null && cutNames.has(effective);
      cutFound ||= isCut;
      const mapping = mappedTo ? ` (mapped to ${mappedTo === "process" ? "process" : `"${mappedTo}"`})` : "";
      findings.push({
        rule: isCut ? "cut-contour-colorant" : "spot-colorant",
        page: pages[0],
        message: isCut
          ? `Cut contour colorant "${name}"${mapping} on ${formatPages(pages)}`
          : `Spot colorant "${name}"${mapping} on ${formatPages(pages)}`,
        data: { colorant: name, ...(mappedTo ? { mappedTo } : {}), cut: isCut, pages },
      });
    }

    if (cutNames.size > 0 && !cutFound) {
      const names = [...cutNames].sort();
      findings.push({
        rule: "cut-contour-missing",
        message: `None of the configured cut-contour colorants (${names.map((n) => `"${n}"`).join(", ")}) is used`,
        data: { cutSpotNames: names },
      });
    }
    return findings;
  },
});
