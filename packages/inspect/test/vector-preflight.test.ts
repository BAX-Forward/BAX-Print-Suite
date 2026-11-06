import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_CHECKS,
  CheckRegistry,
  DEFAULT_PROFILE,
  VECTOR_CHECKS,
  builtinRegistry,
  inspectBytes,
  readVectorHeader,
  validateProfile,
  vectorMarkupCheck,
  vectorSizeCheck,
  type RawFinding,
  type VectorCheck,
  type VectorHeader,
} from "../src/index.js";

/** Spec 035a: header-level preflight of SVG and ASCII DXF inputs, from tiny fixtures built here. */

const NOW = (): Date => new Date("2026-11-06T12:00:00.000Z");
// Markup openers are built from the code point so that no literal bang character appears here.
const BANG = String.fromCharCode(0x21);
const DOCTYPE = `<${BANG}DOCTYPE`;
const ENTITY = `<${BANG}ENTITY`;

function header(text: string): VectorHeader {
  const result = readVectorHeader(new TextEncoder().encode(text));
  if (result.kind === "error") throw new Error(`fixture does not read: ${result.message}`);
  return result;
}

function run(check: VectorCheck, text: string): RawFinding[] {
  return check.run(header(text), {});
}

function rules(findings: readonly RawFinding[]): string[] {
  return findings.map((finding) => finding.rule);
}

function dxf(pairs: readonly (readonly [number, string])[]): string {
  return `${pairs.map(([code, value]) => `${String(code).padStart(3)}\n${value}`).join("\n")}\n`;
}

const DXF_START = [
  [0, "SECTION"],
  [2, "HEADER"],
  [9, "$ACADVER"],
  [1, "AC1027"],
] as const;

function dxfWith(variables: readonly (readonly [number, string])[]): string {
  return dxf([...DXF_START, ...variables, [0, "ENDSEC"], [0, "EOF"]]);
}

const MM: readonly (readonly [number, string])[] = [
  [9, "$INSUNITS"],
  [70, "4"],
];

function extents(min: readonly [string, string], max: readonly [string, string]): (readonly [number, string])[] {
  return [
    [9, "$EXTMIN"],
    [10, min[0]],
    [20, min[1]],
    [9, "$EXTMAX"],
    [10, max[0]],
    [20, max[1]],
  ];
}

describe("vector-size: SVG", () => {
  it("is silent for an absolute width and height", () => {
    expect(run(vectorSizeCheck, `<svg width="210mm" height="297mm" viewBox="0 0 210 297">`)).toEqual([]);
    expect(run(vectorSizeCheck, `<svg width="800px" height="600px">`)).toEqual([]);
  });

  it("warns when no size is declared", () => {
    const findings = run(vectorSizeCheck, `<svg>`);
    expect(rules(findings)).toEqual(["missing-size"]);
    expect(findings[0]?.data).toEqual({ format: "svg" });
  });

  it("warns for missing units when only a viewBox is declared", () => {
    const findings = run(vectorSizeCheck, `<svg viewBox="0 0 210 297">`);
    expect(rules(findings)).toEqual(["missing-units"]);
    expect(findings[0]?.message).toContain("210 × 297 user units");
    expect(findings[0]?.data).toMatchObject({ viewBox: { width: 210, height: 297 } });
  });

  it("warns for missing units on unitless or partly declared lengths", () => {
    const unitless = run(vectorSizeCheck, `<svg width="100" height="50">`);
    expect(rules(unitless)).toEqual(["missing-units"]);
    expect(unitless[0]?.message).toContain("(100 × 50)");
    expect(rules(run(vectorSizeCheck, `<svg width="100%" height="50mm">`))).toEqual(["missing-units"]);
    expect(rules(run(vectorSizeCheck, `<svg width="100mm">`))).toEqual(["missing-size"]);
  });

  it("warns for a relative size", () => {
    const findings = run(vectorSizeCheck, `<svg width="100%" height="100%">`);
    expect(rules(findings)).toEqual(["missing-size"]);
    expect(findings[0]?.data).toMatchObject({ width: 100, height: 100, unit: "%" });
  });

  it("does not read an entity reference as a size", () => {
    const text = `${DOCTYPE} svg [${ENTITY} w "210mm">]><svg width="&w;" height="&w;">`;
    expect(rules(run(vectorSizeCheck, text))).toEqual(["missing-size"]);
  });
});

describe("vector-size: DXF", () => {
  it("is silent for declared units and extents", () => {
    expect(run(vectorSizeCheck, dxfWith([...MM, ...extents(["0", "0"], ["210", "297"])]))).toEqual([]);
  });

  it("warns for missing or unitless $INSUNITS", () => {
    const missing = run(vectorSizeCheck, dxfWith(extents(["0", "0"], ["1", "1"])));
    expect(rules(missing)).toEqual(["missing-units"]);
    expect(missing[0]?.data).toMatchObject({ format: "dxf", acadVer: "AC1027" });
    expect(rules(run(vectorSizeCheck, dxfWith([[9, "$INSUNITS"], [70, "0"], ...extents(["0", "0"], ["1", "1"])])))).toEqual([
      "missing-units",
    ]);
  });

  it("warns for missing, partial or inverted extents", () => {
    expect(rules(run(vectorSizeCheck, dxfWith(MM)))).toEqual(["missing-extents"]);
    expect(rules(run(vectorSizeCheck, dxfWith([...MM, ...extents(["0", "0"], ["1", "1"]).slice(0, 3)])))).toEqual(["missing-extents"]);
    // An empty drawing stores min 1e20 and max -1e20.
    const empty = dxfWith([...MM, ...extents(["1.0E+20", "1.0E+20"], ["-1.0E+20", "-1.0E+20"])]);
    expect(rules(run(vectorSizeCheck, empty))).toEqual(["missing-extents"]);
  });

  it("warns for both when the drawing has no HEADER section", () => {
    const text = dxf([
      [0, "SECTION"],
      [2, "ENTITIES"],
      [0, "ENDSEC"],
      [0, "EOF"],
    ]);
    expect(rules(run(vectorSizeCheck, text))).toEqual(["missing-units", "missing-extents"]);
  });
});

describe("vector-markup", () => {
  it("is silent for a plain SVG and for any DXF", () => {
    expect(run(vectorMarkupCheck, `<svg width="1in" height="1in"><use href="#a"/></svg>`)).toEqual([]);
    expect(run(vectorMarkupCheck, dxfWith(MM))).toEqual([]);
  });

  it("warns for a DOCTYPE", () => {
    const findings = run(vectorMarkupCheck, `${DOCTYPE} svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd"><svg>`);
    expect(rules(findings)).toEqual(["doctype"]);
    expect(findings[0]?.message).toContain("a DOCTYPE");
    expect(findings[0]?.data).toEqual({ format: "svg", hasDoctype: true, hasEntityDecl: false });
  });

  it("warns once for a DOCTYPE with entity declarations", () => {
    const findings = run(vectorMarkupCheck, `${DOCTYPE} svg [${ENTITY} a "b">]><svg>`);
    expect(rules(findings)).toEqual(["doctype"]);
    expect(findings[0]?.message).toContain("entity declarations");
    expect(findings[0]?.data).toMatchObject({ hasDoctype: true, hasEntityDecl: true });
  });

  it("warns for external references with their count", () => {
    const text = `<svg><image href="http://example.com/a.png"/><image xlink:href="/srv/art/b.tif"/><use href="#c"/></svg>`;
    const findings = run(vectorMarkupCheck, text);
    expect(rules(findings)).toEqual(["external-reference"]);
    expect(findings[0]?.message).toContain("2 external references");
    expect(findings[0]?.data).toEqual({ format: "svg", externalRefs: 2 });
    expect(run(vectorMarkupCheck, `<svg><image href="a.png"/></svg>`)[0]?.message).toContain("1 external reference;");
  });

  it("reports the DOCTYPE before external references", () => {
    const text = `${DOCTYPE} svg><svg><image href="a.png"/></svg>`;
    expect(rules(run(vectorMarkupCheck, text))).toEqual(["doctype", "external-reference"]);
  });
});

describe("vector check registration", () => {
  it("lists the vector checks in the built-in registry, in report order", () => {
    expect(VECTOR_CHECKS.map((vector) => vector.check.id)).toEqual(["vector-size", "vector-markup"]);
    expect(builtinRegistry().list().map((check) => check.id)).toEqual(expect.arrayContaining(["vector-size", "vector-markup"]));
  });

  it("validates vector checks in profiles", () => {
    const profile = { ...DEFAULT_PROFILE, id: "vector", checks: [{ check: "vector-size", params: {} }, { check: "vector-markup", params: {} }] };
    expect(validateProfile(profile).ok).toBe(true);
  });

  it("declares a default severity for every rule", () => {
    for (const vector of VECTOR_CHECKS) {
      for (const rule of Object.values(vector.check.rules)) expect(rule.defaultSeverity).toBe("warn");
    }
  });

  it("finds nothing in a PDF", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const bytes = await doc.save();
    const vectorIds = new Set(VECTOR_CHECKS.map((vector) => vector.check.id));
    const before = new CheckRegistry(BUILTIN_CHECKS.filter((check) => vectorIds.has(check.id) === false));
    const report = await inspectBytes(bytes, { now: NOW });
    expect(report.findings.some((finding) => vectorIds.has(finding.checkId))).toBe(false);
    expect(report).toEqual(await inspectBytes(bytes, { now: NOW, registry: before }));
  });
});
