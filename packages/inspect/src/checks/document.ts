import { Type } from "@sinclair/typebox";
import { defineCheck, type RawFinding } from "../check.js";

/** Problems with the file itself and with applying the job's edits, which other checks depend on. */
export const documentCheck = defineCheck({
  id: "document",
  title: "Document structure",
  description: "The file can be read, is not encrypted, its content parses, and the job's edits apply to every page.",
  rules: {
    "unreadable-pdf": { defaultSeverity: "error", description: "The file is not a readable PDF." },
    encrypted: { defaultSeverity: "error", description: "The file is encrypted, so its content cannot be inspected." },
    "content-problem": { defaultSeverity: "warn", description: "Page content refers to missing resources or could not be decoded." },
    "edit-not-applicable": { defaultSeverity: "error", description: "A job edit cannot be applied to a page (e.g. a crop past the edge)." },
  },
  params: Type.Object({}),
  run(doc) {
    const findings: RawFinding[] = [];
    if (doc.encrypted) {
      findings.push({ rule: "encrypted", message: "The file is encrypted; its content was not inspected", data: {} });
    }
    for (const problem of doc.scan.problems) {
      findings.push({ rule: "content-problem", page: problem.page, message: `Page ${problem.page + 1}: ${problem.message}`, data: {} });
    }
    for (const page of doc.pages) {
      if (!page.geometryError) continue;
      const where = page.geometryError.editIndex >= 0 ? `edit ${page.geometryError.editIndex + 1}` : "page box";
      findings.push({
        rule: "edit-not-applicable",
        page: page.index,
        message: `Page ${page.index + 1}, ${where}: ${page.geometryError.message}`,
        data: { editIndex: page.geometryError.editIndex },
      });
    }
    return findings;
  },
});
