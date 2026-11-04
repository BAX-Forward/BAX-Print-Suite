import { Type } from "@sinclair/typebox";
import { defineCheck, type RawFinding } from "../check.js";

/** Output intent presence (ISO 32000-1 §14.11.5). */
export const outputIntentCheck = defineCheck({
  id: "output-intent",
  title: "Output intent",
  description: "Whether the file declares an output intent, and whether each one identifies its printing condition.",
  rules: {
    "output-intent": { defaultSeverity: "info", description: "An output intent is present." },
    "missing-output-intent": { defaultSeverity: "info", description: "The file declares no output intent." },
    "incomplete-output-intent": {
      defaultSeverity: "warn",
      description: "An output intent has neither an OutputConditionIdentifier nor a destination profile.",
    },
    "missing-required-output-intent": {
      defaultSeverity: "error",
      description: "No output intent has the subtype the profile requires.",
    },
  },
  params: Type.Object({
    /** E.g. `GTS_PDFX` or `GTS_PDFA1`. */
    requiredSubtype: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  }),
  run(doc, params) {
    const findings: RawFinding[] = [];
    if (doc.outputIntents.length === 0) {
      findings.push({ rule: "missing-output-intent", message: "The file declares no output intent", data: {} });
    }
    doc.outputIntents.forEach((intent, index) => {
      const scope = intent.page === undefined ? "document" : `page ${intent.page + 1}`;
      const data = { index, ...intent };
      if (!intent.outputConditionIdentifier && !intent.hasDestOutputProfile) {
        findings.push({
          rule: "incomplete-output-intent",
          page: intent.page,
          message: `Output intent ${intent.subtype ?? "(no subtype)"} (${scope}) has no condition identifier or profile`,
          data,
        });
        return;
      }
      findings.push({
        rule: "output-intent",
        page: intent.page,
        message: `Output intent ${intent.subtype ?? "(no subtype)"} (${scope}): ${intent.outputConditionIdentifier ?? "embedded profile"}`,
        data,
      });
    });
    if (params.requiredSubtype && !doc.outputIntents.some((intent) => intent.subtype === params.requiredSubtype)) {
      findings.push({
        rule: "missing-required-output-intent",
        message: `No output intent of subtype ${params.requiredSubtype}`,
        data: { requiredSubtype: params.requiredSubtype },
      });
    }
    return findings;
  },
});
