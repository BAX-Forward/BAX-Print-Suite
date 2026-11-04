import { Type } from "@sinclair/typebox";
import { PDFArray, PDFDict, PDFStream } from "pdf-lib";
import { defineCheck, formatPages, sortedPages, type RawFinding } from "../check.js";
import { dictIn, lookupIn, nameIn } from "../pdf-objects.js";

const FONT_FILE_KEYS = ["FontFile", "FontFile2", "FontFile3"] as const;

/** The descriptor of a simple font, or of the descendant of a Type 0 font (ISO 32000-1 §9.7). */
function fontDescriptorOf(font: PDFDict): PDFDict | undefined {
  if (nameIn(font, "Subtype") !== "Type0") return dictIn(font, "FontDescriptor");
  const descendants = lookupIn(font, "DescendantFonts");
  const first = descendants instanceof PDFArray ? descendants.lookup(0) : undefined;
  return first instanceof PDFDict ? dictIn(first, "FontDescriptor") : undefined;
}

/** True when the glyph programs travel with the file. Type 3 glyphs are content streams, so always embedded. */
export function isFontEmbedded(font: PDFDict): boolean {
  if (nameIn(font, "Subtype") === "Type3") return true;
  const descriptor = fontDescriptorOf(font);
  return FONT_FILE_KEYS.some((key) => lookupIn(descriptor, key) instanceof PDFStream);
}

/**
 * Fonts that show text are embedded (ISO 32000-1 §9.9). Text converted to outlines uses no
 * font and passes. Only fonts that actually show text are considered, not every resource.
 */
export const fontsCheck = defineCheck({
  id: "fonts",
  title: "Fonts embedded",
  description: "Every font that shows text is embedded in the file, or the text is outlined.",
  rules: {
    "not-embedded": {
      defaultSeverity: "error",
      description: "A font shows visible text but is not embedded; output becomes unpredictable.",
    },
    "invisible-not-embedded": {
      defaultSeverity: "info",
      description: "A font is not embedded but only shows invisible text (rendering mode 3 or 7), e.g. a searchable text layer.",
    },
    "undefined-font": {
      defaultSeverity: "error",
      description: "Text is shown with a font that the page resources do not define.",
    },
  },
  params: Type.Object({}),
  run(doc) {
    const findings: RawFinding[] = [];
    for (const font of doc.scan.fonts.values()) {
      const pages = sortedPages(font.pages);
      const where = formatPages(pages);
      if (!font.dict) {
        findings.push({
          rule: "undefined-font",
          page: pages[0],
          message: `Text on ${where} uses font /${font.resourceName}, which is not defined`,
          data: { resourceName: font.resourceName, pages },
        });
        continue;
      }
      if (isFontEmbedded(font.dict)) continue;
      const baseFont = nameIn(font.dict, "BaseFont") ?? font.resourceName;
      const label = font.objectRef ? `${baseFont} (${font.objectRef})` : baseFont;
      findings.push({
        rule: font.visible ? "not-embedded" : "invisible-not-embedded",
        page: pages[0],
        objectRef: font.objectRef,
        message: font.visible
          ? `Font ${label} is not embedded; used on ${where}. Embed it or convert the text to outlines`
          : `Font ${label} is not embedded but only shows invisible text on ${where}`,
        data: { baseFont, subtype: nameIn(font.dict, "Subtype"), pages },
      });
    }
    return findings;
  },
});
