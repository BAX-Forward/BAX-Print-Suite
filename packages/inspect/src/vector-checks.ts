import { Type, type Static, type TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { defineCheck, type AnyCheck, type RawFinding, type RuleSpec } from "./check.js";
import type { DxfHeader, DxfPoint, SvgHeader, VectorHeader } from "./vector-header.js";

/**
 * Header-level preflight of SVG and ASCII DXF inputs (Spec 035a). Each check is registered
 * like any other, so profiles list, configure and validate it; its PDF `run` finds nothing,
 * and its vector form runs on the 035a header facts. No drawing content is parsed.
 */

export interface VectorCheck {
  /** The registry entry. It finds nothing in a PDF. */
  readonly check: AnyCheck;
  /** Runs on the header with params already resolved against `check.params`. */
  run(header: VectorHeader, params: Record<string, unknown>): RawFinding[];
}

/** A `PreflightCheck` whose `run` takes the vector header instead of the document model. */
export interface VectorCheckSpec<S extends TObject> {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly rules: Readonly<Record<string, RuleSpec>>;
  readonly params: S;
  runVector(header: VectorHeader, params: Static<S>): RawFinding[];
}

export function defineVectorCheck<S extends TObject>(spec: VectorCheckSpec<S>): VectorCheck {
  const check = defineCheck<S>({
    id: spec.id,
    title: spec.title,
    description: spec.description,
    rules: spec.rules,
    params: spec.params,
    run: () => [],
  });
  return {
    check,
    run(header, params) {
      if (Value.Check(spec.params, params)) return spec.runVector(header, params);
      throw new TypeError(`Check ${spec.id}: parameters do not match the schema`);
    },
  };
}

const RELATIVE_SVG_UNITS: ReadonlySet<string> = new Set(["%", "em", "ex"]);

function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

function svgSizeData(header: SvgHeader): Record<string, unknown> {
  return {
    format: "svg",
    ...(header.width === undefined ? {} : { width: header.width }),
    ...(header.height === undefined ? {} : { height: header.height }),
    ...(header.unit === undefined ? {} : { unit: header.unit }),
    ...(header.viewBox === undefined ? {} : { viewBox: header.viewBox }),
  };
}

function svgSizeFindings(header: SvgHeader): RawFinding[] {
  const data = svgSizeData(header);
  const { width, height, unit, viewBox } = header;
  if (width === undefined || height === undefined) {
    if (viewBox === undefined) {
      return [{ rule: "missing-size", message: "SVG declares no width, height or viewBox; its print size is undefined", data }];
    }
    const size = `${formatNumber(viewBox.width)} × ${formatNumber(viewBox.height)}`;
    return [
      {
        rule: "missing-units",
        message: `SVG declares no width and height; its size is the viewBox, ${size} user units, which print tools scale differently`,
        data,
      },
    ];
  }
  const size = `${formatNumber(width)} × ${formatNumber(height)}`;
  if (unit === undefined) {
    return [
      {
        rule: "missing-units",
        message: `SVG width and height (${size}) carry no absolute unit; print tools read user units at 72 or 96 per inch`,
        data,
      },
    ];
  }
  if (RELATIVE_SVG_UNITS.has(unit)) {
    return [{ rule: "missing-size", message: `SVG width and height are relative (${size} ${unit}); its print size depends on the viewer`, data }];
  }
  return [];
}

function hasExtent(min: DxfPoint | undefined, max: DxfPoint | undefined): boolean {
  // An empty drawing stores inverted extents (min above max).
  if (min === undefined || max === undefined) return false;
  return min.x <= max.x && min.y <= max.y;
}

function dxfSizeFindings(header: DxfHeader): RawFinding[] {
  const findings: RawFinding[] = [];
  const data = {
    format: "dxf",
    ...(header.acadVer === undefined ? {} : { acadVer: header.acadVer }),
    ...(header.insUnits === undefined ? {} : { insUnits: header.insUnits }),
    ...(header.extMin === undefined ? {} : { extMin: header.extMin }),
    ...(header.extMax === undefined ? {} : { extMax: header.extMax }),
  };
  if (header.insUnits === undefined || header.insUnits === 0) {
    findings.push({
      rule: "missing-units",
      message: "DXF declares no drawing units ($INSUNITS); its coordinates could be millimetres or inches",
      data,
    });
  }
  if (hasExtent(header.extMin, header.extMax) === false) {
    findings.push({
      rule: "missing-extents",
      message: "DXF declares no valid drawing extents ($EXTMIN, $EXTMAX); its size is unknown from the header",
      data,
    });
  }
  return findings;
}

export const vectorSizeCheck = defineVectorCheck({
  id: "vector-size",
  title: "Vector size and units",
  description: "Print size and units declared in an SVG root element or a DXF HEADER section.",
  rules: {
    "missing-size": { defaultSeverity: "warn", description: "The SVG declares no absolute size: no width, height or viewBox, or relative units." },
    "missing-units": { defaultSeverity: "warn", description: "The SVG size is in user units only, or the DXF declares no $INSUNITS." },
    "missing-extents": { defaultSeverity: "warn", description: "The DXF header has no valid $EXTMIN and $EXTMAX." },
  },
  params: Type.Object({}),
  runVector(header) {
    return header.kind === "svg" ? svgSizeFindings(header) : dxfSizeFindings(header);
  },
});

export const vectorMarkupCheck = defineVectorCheck({
  id: "vector-markup",
  title: "SVG markup",
  description: "Markup in an SVG that a renderer may resolve before printing: a DTD, entity declarations, external references.",
  rules: {
    doctype: { defaultSeverity: "warn", description: "The SVG has a DOCTYPE or entity declarations, which a renderer may expand." },
    "external-reference": { defaultSeverity: "warn", description: "The SVG references files or URLs outside itself." },
  },
  params: Type.Object({}),
  runVector(header) {
    if (header.kind === "dxf") return [];
    const findings: RawFinding[] = [];
    if (header.hasDoctype || header.hasEntityDecl) {
      const what = header.hasEntityDecl ? "entity declarations" : "a DOCTYPE";
      findings.push({
        rule: "doctype",
        message: `SVG contains ${what}; renderers may expand or fetch them, so the output can differ from the file`,
        data: { format: "svg", hasDoctype: header.hasDoctype, hasEntityDecl: header.hasEntityDecl },
      });
    }
    if (header.externalRefs > 0) {
      const count = header.externalRefs === 1 ? "1 external reference" : `${header.externalRefs} external references`;
      findings.push({
        rule: "external-reference",
        message: `SVG has ${count}; embed linked images and fonts so the file prints on its own`,
        data: { format: "svg", externalRefs: header.externalRefs },
      });
    }
    return findings;
  },
});

/** Built-in vector checks, in report order. */
export const VECTOR_CHECKS: readonly VectorCheck[] = [vectorSizeCheck, vectorMarkupCheck];
