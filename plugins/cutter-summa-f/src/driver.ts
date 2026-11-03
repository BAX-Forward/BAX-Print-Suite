// CutterDriver/2 for Summa F-series flatbeds (spec 004 Part G). We don't drive
// the machine: GoProduce (proprietary) stays the controller. This plugin writes
// cut files for its documented import paths ([GPF], [GPN], [GP]):
// - `pdf-cut`: one optional-content layer per method, a `Regmark` layer with
//   5 mm filled circles, no print data,
// - `dxf`: AutoCAD R12, one layer per method, optional TEXT labels, registration
//   circles on the Regmark layer,
// delivered into a hot folder (Pro Pack) or a folder the operator imports from.
// Open paths whose ends are within 0.5 mm are closed, as the importer does.
// Not used: the GoProduce SDK (license terms unreviewed, ADR-0005).

import { access, constants } from "node:fs/promises";
import {
  CutterDriverError,
  makeExportResult,
  type Contour,
  type CutFormat,
  type CutJob,
  type CutterDriver,
  type DeviceConfig,
  type DeviceStatus,
  type ExportResult,
  type SendResult,
} from "@bax-print/plugin-sdk";
import {
  assertValidCutJob,
  distance,
  DXF_OPTIONS_SCHEMA,
  makeContour,
  mmToPt,
  parseDxfOptions,
  parseLayerNames,
  ptToMm,
  resolveLayerName,
  safeFileStem,
  writeDxf,
  writeFileAtomic,
  writeLayeredCutPdf,
  type PdfCutLayer,
} from "@bax-print/cut-export";
import { buildFProfile, DEFAULT_REGMARK_DIAMETER_MM, FORMAT_IDS, parseFDeviceConfig, type FFormatId } from "./profile.js";

export const PDF_MIME = "application/pdf";
export const DXF_MIME = "application/dxf";
export const REGMARK_LAYER = "Regmark";
/** Open paths whose ends are this close are closed by the importer, so we close them too. */
export const DEFAULT_CLOSE_TOLERANCE_MM = 0.5;
/** Barcode-driven import needs file names of 8 to 13 characters ([GPF]). */
export const BARCODE_ID_PATTERN = /^[A-Z0-9.-]{8,13}$/;
const REGMARK_SIZE_TOLERANCE_MM = 0.01;

/**
 * Layer names per semantic tool. GoProduce maps layers to methods in its own
 * material and action settings, so every name can be overridden with
 * `options.layerNames` (keys: tool ids or semantic tools; tool ids win).
 */
export const F_DEFAULT_LAYER_NAMES: Readonly<Record<string, string>> = {
  kiss: "Kiss-cut",
  thru: "Thru-cut",
  crease: "Crease",
  perforate: "Perforate",
  "v-cut": "V-cut",
  router: "Router",
  drill: "Drill",
  pen: "Pen",
};

const COMMON_OPTIONS = {
  layerNames: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
  regmarkLayerName: { type: "string", minLength: 1, default: REGMARK_LAYER },
  regmarkDiameterMm: { type: "number", exclusiveMinimum: 0, default: DEFAULT_REGMARK_DIAMETER_MM },
  closeToleranceMm: { type: "number", minimum: 0, default: DEFAULT_CLOSE_TOLERANCE_MM },
  enableExperimentalBarcode: { type: "boolean", default: false, "x-experimental": true },
  barcodeJobId: {
    type: "string",
    pattern: BARCODE_ID_PATTERN.source,
    "x-experimental": true,
    description: "Code 39 job id printed with the marks; the cut file is named after it. Needs enableExperimentalBarcode.",
  },
} as const;

const FORMATS: CutFormat[] = [
  {
    id: FORMAT_IDS.pdfCut,
    mime: PDF_MIME,
    ext: "pdf",
    optionsSchema: {
      type: "object",
      properties: { ...COMMON_OPTIONS, strokeWidthMm: { type: "number", exclusiveMinimum: 0, default: 0.1 } },
      additionalProperties: true,
    },
  },
  {
    id: FORMAT_IDS.dxf,
    mime: DXF_MIME,
    ext: "dxf",
    optionsSchema: { ...DXF_OPTIONS_SCHEMA, properties: { ...DXF_OPTIONS_SCHEMA.properties, ...COMMON_OPTIONS } },
  },
];

interface FOptions {
  layerNames?: Record<string, string>;
  regmarkLayerName: string;
  regmarkDiameterMm: number;
  closeToleranceMm: number;
  strokeWidthMm?: number;
  barcodeJobId?: string;
}

function invalidOption(message: string): CutterDriverError {
  return new CutterDriverError("invalid-options", message);
}

function positiveOption(value: unknown, name: string, fallback: number, allowZero = false): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw invalidOption(`${name} must be a ${allowZero ? "non-negative" : "positive"} number`);
  }
  return value;
}

function parseFOptions(raw: Record<string, unknown>): FOptions {
  const out: FOptions = {
    regmarkLayerName: REGMARK_LAYER,
    regmarkDiameterMm: positiveOption(raw.regmarkDiameterMm, "regmarkDiameterMm", DEFAULT_REGMARK_DIAMETER_MM),
    closeToleranceMm: positiveOption(raw.closeToleranceMm, "closeToleranceMm", DEFAULT_CLOSE_TOLERANCE_MM, true),
  };
  if (raw.layerNames !== undefined) out.layerNames = parseLayerNames(raw.layerNames);
  if (raw.regmarkLayerName !== undefined) {
    if (typeof raw.regmarkLayerName !== "string" || raw.regmarkLayerName.trim().length === 0) throw invalidOption("regmarkLayerName must be a non-empty string");
    out.regmarkLayerName = raw.regmarkLayerName;
  }
  if (raw.strokeWidthMm !== undefined) out.strokeWidthMm = positiveOption(raw.strokeWidthMm, "strokeWidthMm", 0.1);
  if (raw.barcodeJobId !== undefined) {
    if (raw.enableExperimentalBarcode !== true) {
      throw new CutterDriverError("experimental-disabled", "barcode job ids are experimental; set options.enableExperimentalBarcode to use them");
    }
    if (typeof raw.barcodeJobId !== "string" || !BARCODE_ID_PATTERN.test(raw.barcodeJobId)) {
      throw invalidOption("barcodeJobId must be 8 to 13 characters of A-Z, 0-9, '-' or '.' (Code 39 subset, file-name safe)");
    }
    out.barcodeJobId = raw.barcodeJobId;
  }
  return out;
}

/** Closes open contours whose ends are within the tolerance, as the importer would. */
function closeNearlyClosed(contours: readonly Contour[], toleranceMm: number): { contours: Contour[]; closedIds: string[] } {
  const tolerancePt = mmToPt(toleranceMm);
  const closedIds: string[] = [];
  const out = contours.map((c) => {
    if (c.closed || c.points.length < 3) return c;
    const [first, last] = [c.points[0], c.points[c.points.length - 1]];
    if (distance(first, last) > tolerancePt) return c;
    closedIds.push(c.id);
    // Drop a duplicated end point so the closing segment is not zero-length.
    const points = distance(first, last) === 0 ? c.points.slice(0, -1) : [...c.points];
    return makeContour({ id: c.id, tool: c.tool, source: c.source, points, closed: true });
  });
  return { contours: out, closedIds };
}

function prepare(job: CutJob, options: FOptions): { job: CutJob; warnings: string[] } {
  const warnings: string[] = [];
  const { contours, closedIds } = closeNearlyClosed(job.contours, options.closeToleranceMm);
  if (closedIds.length > 0) warnings.push(`closed ${closedIds.length} open path(s) within ${options.closeToleranceMm} mm: ${closedIds.join(", ")}`);
  for (const mark of job.marks?.marks ?? []) {
    if (Math.abs(ptToMm(mark.dPt) - options.regmarkDiameterMm) > REGMARK_SIZE_TOLERANCE_MM) {
      warnings.push(`mark ${mark.id}: ${ptToMm(mark.dPt).toFixed(2)} mm, the importer looks for ${options.regmarkDiameterMm} mm circles`);
    }
  }
  if (job.marks?.shape === "square") warnings.push("square marks are not recognized by camera registration; use circles");
  return { job: { ...job, contours }, warnings };
}

function outsideFrameWarnings(job: CutJob): string[] {
  const { widthPt, heightPt } = job.frame;
  const outside = (x: number, y: number): boolean => x < 0 || y < 0 || x > widthPt || y > heightPt;
  const warnings = job.contours
    .filter((c) => c.points.some(([x, y]) => outside(x, y)))
    .map((c) => `contour ${c.id}: extends beyond the page and is clipped in the PDF`);
  for (const m of job.marks?.marks ?? []) {
    const r = m.dPt / 2;
    if (outside(m.xPt - r, m.yPt - r) || outside(m.xPt + r, m.yPt + r)) warnings.push(`mark ${m.id}: extends beyond the page`);
  }
  return warnings;
}

function fileNameFor(job: CutJob, options: FOptions, ext: string): string {
  return `${options.barcodeJobId ?? safeFileStem(job.jobId)}.${ext}`;
}

async function exportPdfCut(job: CutJob, options: FOptions, warnings: string[]): Promise<ExportResult> {
  const layers: PdfCutLayer[] = [];
  for (const contour of job.contours) {
    const name = resolveLayerName(contour.tool, job.toolMap[contour.tool]?.toolId, options.layerNames, F_DEFAULT_LAYER_NAMES);
    let layer = layers.find((l) => l.name === name);
    if (!layer) {
      layer = { name, paths: [] };
      layers.push(layer);
    }
    layer.paths.push({ points: contour.points, closed: contour.closed });
  }
  if (layers.some((l) => l.name === options.regmarkLayerName)) {
    throw invalidOption(`a cut layer is named "${options.regmarkLayerName}", which is reserved for registration marks`);
  }
  const marks = job.marks?.marks ?? [];
  const bytes = await writeLayeredCutPdf({
    frame: job.frame,
    layers,
    ...(marks.length > 0 ? { markLayer: { name: options.regmarkLayerName, circles: marks.map((m) => ({ xPt: m.xPt, yPt: m.yPt, dPt: m.dPt })) } } : {}),
    ...(options.strokeWidthMm === undefined ? {} : { strokeWidthMm: options.strokeWidthMm }),
  });
  return makeExportResult({
    bytes,
    fileName: fileNameFor(job, options, "pdf"),
    mime: PDF_MIME,
    warnings: [...warnings, ...outsideFrameWarnings(job)],
  });
}

function exportDxf(job: CutJob, options: FOptions, warnings: string[]): ExportResult {
  const { text, warnings: writerWarnings } = writeDxf(job, {
    ...parseDxfOptions(job.options ?? {}),
    defaultLayerNames: F_DEFAULT_LAYER_NAMES,
    ...(options.layerNames ? { layerNames: options.layerNames } : {}),
    markLayer: options.regmarkLayerName,
  });
  return makeExportResult({
    bytes: new TextEncoder().encode(text),
    fileName: fileNameFor(job, options, "dxf"),
    mime: DXF_MIME,
    warnings: [...warnings, ...writerWarnings],
  });
}

async function exportJob(job: CutJob, format: FFormatId): Promise<ExportResult> {
  const options = parseFOptions(job.options ?? {});
  const prepared = prepare(job, options);
  return format === FORMAT_IDS.pdfCut ? exportPdfCut(prepared.job, options, prepared.warnings) : exportDxf(prepared.job, options, prepared.warnings);
}

function isFormatId(format: string): format is FFormatId {
  return format === FORMAT_IDS.pdfCut || format === FORMAT_IDS.dxf;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSummaFDriver(): CutterDriver {
  return {
    describe(deviceConfig: DeviceConfig) {
      return buildFProfile(parseFDeviceConfig(deviceConfig));
    },

    formats() {
      return FORMATS.map((f) => ({ ...f }));
    },

    export(job: CutJob, format: string) {
      if (!isFormatId(format)) throw new CutterDriverError("unsupported", `unknown format "${format}"`);
      return exportJob(job, format);
    },

    async send(job: CutJob, deviceConfig: DeviceConfig): Promise<SendResult> {
      const config = parseFDeviceConfig(deviceConfig);
      if (!config.delivery) return { status: "failed", detail: "no import folder configured (deviceConfig.delivery)" };
      const validationWarnings = assertValidCutJob(job, buildFProfile(config));
      const options = config.enableExperimentalBarcode ? { ...job.options, enableExperimentalBarcode: true } : job.options;
      const result = await exportJob({ ...job, options }, config.delivery.format);
      try {
        const path = await writeFileAtomic(config.delivery.folder, result.fileName, result.bytes);
        const notes = [...validationWarnings.map((w) => w.message), ...result.warnings];
        return { status: "delivered", detail: notes.length > 0 ? `${path} (${notes.join("; ")})` : path };
      } catch (error) {
        return { status: "failed", detail: errorText(error) };
      }
    },

    async getStatus(deviceConfig: DeviceConfig): Promise<DeviceStatus> {
      // Machine state belongs to GoProduce; we can only report whether the import folder is usable.
      const config = parseFDeviceConfig(deviceConfig);
      if (!config.delivery) return { state: "unknown", reason: "no import folder configured; the machine is controlled by GoProduce" };
      try {
        await access(config.delivery.folder, constants.W_OK);
        return { state: "ready", reason: "import folder is writable" };
      } catch (error) {
        return { state: "offline", reason: `import folder unavailable: ${errorText(error)}` };
      }
    },
  };
}
