import { Type } from "@sinclair/typebox";
import type { ConformanceClaim } from "@bax-print/plugin-sdk";
import { defineCheck, type RawFinding } from "../check.js";
import { versionAtMost, type DocumentModel } from "../document-model.js";

/**
 * PDF/X (ISO 15930) and PDF/A (ISO 19005) conformance *claims*: the version keys and a short
 * list of required entries. This is not validation; a full validator runs as a plugin.
 */

const NS_PDFAID = "http://www.aiim.org/pdfa/ns/id/";
const NS_PDFXID = "http://www.npes.org/pdfx/ns/id/";
const NS_PDF = "http://ns.adobe.com/pdf/1.3/";
const DEVICE_FAMILIES = new Set(["DeviceGray", "DeviceRGB", "DeviceCMYK"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A simple XMP property, written as an attribute or an element. The prefix is resolved from its namespace URI. */
export function xmpProperty(xmp: string | undefined, namespace: string, local: string): string | undefined {
  if (!xmp) return undefined;
  const prefixes = [...xmp.matchAll(new RegExp(`xmlns:([A-Za-z_][\\w.-]*)\\s*=\\s*["']${escapeRegExp(namespace)}["']`, "g"))]
    .map((m) => m[1])
    .filter((p): p is string => p !== undefined);
  for (const prefix of prefixes) {
    const name = `${escapeRegExp(prefix)}:${escapeRegExp(local)}`;
    const attribute = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(xmp)?.[1];
    if (attribute !== undefined) return attribute.trim();
    const element = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xmp)?.[1];
    if (element !== undefined) return element.trim();
  }
  return undefined;
}

/** Highest PDF version each PDF/X version is based on (ISO 15930 parts 1, 3, 4, 6, 7). */
function pdfxMaxVersion(claim: string): string | undefined {
  if (/^PDF\/X-1a:2001$/.test(claim) || /^PDF\/X-3:2002$/.test(claim)) return "1.3";
  if (/^PDF\/X-1a:2003$/.test(claim) || /^PDF\/X-3:2003$/.test(claim)) return "1.4";
  if (/^PDF\/X-4/.test(claim)) return "1.6";
  return undefined;
}

function trappedKnown(doc: DocumentModel): boolean {
  const info = doc.info.Trapped;
  const xmp = xmpProperty(doc.xmp, NS_PDF, "Trapped");
  return info === "True" || info === "False" || xmp === "True" || xmp === "False";
}

function pdfxClaim(doc: DocumentModel): ConformanceClaim | undefined {
  const claim = doc.info.GTS_PDFXVersion ?? xmpProperty(doc.xmp, NS_PDFXID, "GTS_PDFXVersion");
  if (!claim) return undefined;
  const missing: string[] = [];
  if (!doc.outputIntents.some((i) => i.page === undefined && i.subtype === "GTS_PDFX" && i.outputConditionIdentifier)) {
    missing.push("document OutputIntent of subtype GTS_PDFX with an OutputConditionIdentifier");
  }
  const pagesWithoutTrim = doc.pages.filter((p) => !p.boxes.TrimBox && !p.boxes.ArtBox).map((p) => p.index + 1);
  if (pagesWithoutTrim.length > 0) missing.push(`TrimBox or ArtBox on page(s) ${pagesWithoutTrim.join(", ")}`);
  if (!doc.hasTrailerId) missing.push("trailer /ID");
  if (doc.encrypted) missing.push("no encryption");
  if (!trappedKnown(doc)) missing.push("/Trapped set to True or False");
  if (/^PDF\/X-1a:2001$/.test(claim) && !doc.info.GTS_PDFXConformance) missing.push("Info /GTS_PDFXConformance");
  if (/^PDF\/X-4/.test(claim) && !xmpProperty(doc.xmp, NS_PDFXID, "GTS_PDFXVersion")) missing.push("XMP pdfxid:GTS_PDFXVersion");
  const max = pdfxMaxVersion(claim);
  if (max && !versionAtMost(doc.pdfVersion, max)) missing.push(`PDF version ${max} or lower (file is ${doc.pdfVersion ?? "unknown"})`);
  return { family: "PDF/X", claim, structural: missing.length === 0 ? "pass" : "fail", missing };
}

function pdfaClaim(doc: DocumentModel): ConformanceClaim | undefined {
  const part = xmpProperty(doc.xmp, NS_PDFAID, "part");
  if (!part) return undefined;
  const level = xmpProperty(doc.xmp, NS_PDFAID, "conformance");
  const claim = `PDF/A-${part}${level ? level.toLowerCase() : ""}`;
  const missing: string[] = [];
  if (!/^[1-4]$/.test(part)) missing.push(`a known pdfaid:part (found "${part}")`);
  if (part !== "4" && !level) missing.push("XMP pdfaid:conformance");
  if (doc.encrypted) missing.push("no encryption");
  if (part === "1" && !doc.hasTrailerId) missing.push("trailer /ID");
  const usesDeviceColor = [...doc.scan.colors.values()].some((c) => DEVICE_FAMILIES.has(c.space.family));
  if (usesDeviceColor && !doc.outputIntents.some((i) => i.subtype === "GTS_PDFA1" && i.hasDestOutputProfile)) {
    missing.push("OutputIntent of subtype GTS_PDFA1 with a destination profile (device colour is used)");
  }
  const max = part === "1" ? "1.4" : part === "4" ? "2.0" : "1.7";
  if (!versionAtMost(doc.pdfVersion, max)) missing.push(`PDF version ${max} or lower (file is ${doc.pdfVersion ?? "unknown"})`);
  return { family: "PDF/A", claim, structural: missing.length === 0 ? "pass" : "fail", missing };
}

export function conformanceClaims(doc: DocumentModel): ConformanceClaim[] {
  return [pdfxClaim(doc), pdfaClaim(doc)].filter((c): c is ConformanceClaim => c !== undefined);
}

export const conformanceCheck = defineCheck({
  id: "conformance",
  title: "PDF/X and PDF/A claims",
  description: "Checks the version keys and required entries of PDF/X (ISO 15930) and PDF/A (ISO 19005) claims. Not full validation.",
  rules: {
    claim: { defaultSeverity: "info", description: "A conformance claim with its required entries present." },
    "claim-incomplete": { defaultSeverity: "error", description: "A conformance claim is missing required entries." },
    "required-claim-missing": { defaultSeverity: "error", description: "The profile requires a claim the file does not make." },
  },
  params: Type.Object({
    requireFamily: Type.Optional(Type.Union([Type.Literal("PDF/X"), Type.Literal("PDF/A")])),
  }),
  run(doc, params) {
    const claims = conformanceClaims(doc);
    const findings: RawFinding[] = claims.map((c) =>
      c.structural === "pass"
        ? { rule: "claim", message: `Claims ${c.claim}; required entries present (not fully validated)`, data: { ...c } }
        : { rule: "claim-incomplete", message: `Claims ${c.claim} but is missing: ${c.missing.join("; ")}`, data: { ...c } },
    );
    if (params.requireFamily && !claims.some((c) => c.family === params.requireFamily)) {
      findings.push({
        rule: "required-claim-missing",
        message: `The file makes no ${params.requireFamily} claim`,
        data: { requireFamily: params.requireFamily },
      });
    }
    return findings;
  },
});
