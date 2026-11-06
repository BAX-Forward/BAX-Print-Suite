import { Type, type Static, type TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { defineCheck, type AnyCheck, type RawFinding, type RuleSpec } from "./check.js";
import type { RasterHeader } from "./raster-header.js";

/**
 * Header-only preflight of PNG, JPEG and TIFF inputs (Spec 031b). Each check is registered
 * like any other, so profiles list, configure and validate it; its PDF `run` finds nothing,
 * and its raster form runs on the 031a header facts. No pixel data is decoded.
 */

export interface RasterCheck {
  /** The registry entry. It finds nothing in a PDF. */
  readonly check: AnyCheck;
  /** Runs on the header with params already resolved against `check.params`. */
  run(header: RasterHeader, params: Record<string, unknown>): RawFinding[];
}

/** A `PreflightCheck` whose `run` takes the raster header instead of the document model. */
export interface RasterCheckSpec<S extends TObject> {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly rules: Readonly<Record<string, RuleSpec>>;
  readonly params: S;
  runRaster(header: RasterHeader, params: Static<S>): RawFinding[];
}

export function defineRasterCheck<S extends TObject>(spec: RasterCheckSpec<S>): RasterCheck {
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
      if (Value.Check(spec.params, params)) return spec.runRaster(header, params);
      throw new TypeError(`Check ${spec.id}: parameters do not match the schema`);
    },
  };
}

/** RIPs commonly print a raster without a declared resolution at 72 dpi. */
export const ASSUMED_RASTER_DPI = 72;
const MM_PER_INCH = 25.4;

function formatName(header: RasterHeader): string {
  return header.type.toUpperCase();
}

function sizeData(header: RasterHeader): Record<string, unknown> {
  return { format: header.type, widthPx: header.widthPx, heightPx: header.heightPx };
}

export const rasterResolutionCheck = defineRasterCheck({
  id: "raster-resolution",
  title: "Raster resolution",
  description: "Resolution declared in a PNG, JPEG or TIFF header. PDF inputs are covered by image-resolution.",
  rules: {
    "below-minimum": { defaultSeverity: "warn", description: "The horizontal or vertical resolution is below `minDpi`." },
    "missing-resolution": {
      defaultSeverity: "info",
      description: `The header declares no resolution; RIPs commonly assume ${ASSUMED_RASTER_DPI} dpi.`,
    },
  },
  params: Type.Object({
    minDpi: Type.Number({ minimum: 0, maximum: 10_000, default: 100 }),
  }),
  runRaster(header, params) {
    const { dpiX, dpiY } = header;
    if (dpiX === undefined || dpiY === undefined) {
      const widthMm = (header.widthPx / ASSUMED_RASTER_DPI) * MM_PER_INCH;
      const heightMm = (header.heightPx / ASSUMED_RASTER_DPI) * MM_PER_INCH;
      return [
        {
          rule: "missing-resolution",
          message:
            `${formatName(header)} declares no resolution; at the ${ASSUMED_RASTER_DPI} dpi most RIPs assume, ` +
            `${header.widthPx} × ${header.heightPx} px prints at ${widthMm.toFixed(1)} × ${heightMm.toFixed(1)} mm`,
          data: { ...sizeData(header), assumedDpi: ASSUMED_RASTER_DPI },
        },
      ];
    }
    if (dpiX >= params.minDpi && dpiY >= params.minDpi) return [];
    return [
      {
        rule: "below-minimum",
        message: `${formatName(header)} declares ${dpiX} × ${dpiY} dpi, below ${params.minDpi} dpi`,
        data: { ...sizeData(header), dpiX, dpiY, thresholdDpi: params.minDpi },
      },
    ];
  },
});

export const rasterColorModeCheck = defineRasterCheck({
  id: "raster-color-mode",
  title: "Raster colour mode",
  description: "Colour mode and alpha channel declared in a PNG, JPEG or TIFF header. CMYK and gray need nothing.",
  rules: {
    rgb: { defaultSeverity: "info", description: "RGB data, converted to the output colour space by the RIP." },
    indexed: { defaultSeverity: "warn", description: "Indexed (palette) colour." },
    lab: { defaultSeverity: "warn", description: "CIE Lab data." },
    alpha: { defaultSeverity: "warn", description: "The image has an alpha channel or transparency." },
  },
  params: Type.Object({}),
  runRaster(header) {
    const name = formatName(header);
    const data = { ...sizeData(header), colorMode: header.colorMode };
    const findings: RawFinding[] = [];
    if (header.colorMode === "rgb") {
      findings.push({ rule: "rgb", message: `${name} is RGB; the RIP converts it to the output colour space`, data });
    }
    if (header.colorMode === "indexed") {
      findings.push({ rule: "indexed", message: `${name} uses indexed (palette) colour; convert it to RGB or CMYK for print`, data });
    }
    if (header.colorMode === "lab") {
      findings.push({ rule: "lab", message: `${name} is CIE Lab; check that the RIP accepts Lab input`, data });
    }
    if (header.hasAlpha) {
      findings.push({ rule: "alpha", message: `${name} has an alpha channel; flatten transparency before printing`, data });
    }
    return findings;
  },
});

/** Built-in raster checks, in report order. */
export const RASTER_CHECKS: readonly RasterCheck[] = [rasterResolutionCheck, rasterColorModeCheck];
