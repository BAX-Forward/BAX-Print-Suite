// Summa F-series (flatbed) capability profile. Public basis: the GoProduce
// (Flatbed Edition) user manual and release notes, plus the older GoProduce
// manual (docs/research/cutter-integration.md [GPF], [GPN], [GP]). GoProduce,
// which is proprietary, stays the machine controller: bed size, tools and
// modules come from user-entered device configuration, never from the machine.

import {
  CORNERS,
  CutterDriverError,
  type Corner,
  type CutterProfile,
  type DeviceConfig,
  type Range,
  type ToolDef,
  type ToolParams,
} from "@bax-print/plugin-sdk";

/** Generic tool kinds an operator can declare. Methods and materials themselves live in GoProduce. */
export const TOOL_KIND_CATALOG = [
  "drag-knife",
  "tangential-knife",
  "kiss",
  "thru",
  "crease",
  "perforate",
  "router",
  "drill",
  "v-cut",
  "pen",
] as const;

export const FORMAT_IDS = { pdfCut: "pdf-cut", dxf: "dxf" } as const;
export type FFormatId = (typeof FORMAT_IDS)[keyof typeof FORMAT_IDS];

/** The registration circle size GoProduce looks for on the Regmark layer by default ([GP]). */
export const DEFAULT_REGMARK_DIAMETER_MM = 5;

export interface FolderDelivery {
  method: "folder-import";
  /** A GoProduce hot folder (Pro Pack) or a folder the operator imports from manually. */
  folder: string;
  format: FFormatId;
}

export interface FDeviceConfig {
  bedWidthMm: number;
  bedLengthMm: number;
  bedOrigin: Corner;
  conveyor: boolean;
  vacuumZones?: number;
  tools: ToolDef[];
  toolSlots?: number;
  regmarkDiameterMm: number;
  /** Allows the Code 39 job-id file naming (`options.barcodeJobId`). */
  enableExperimentalBarcode: boolean;
  delivery?: FolderDelivery;
}

const PARAM_NAMES = ["speed", "force", "depth", "offset", "passes"] as const;

function invalid(message: string): CutterDriverError {
  return new CutterDriverError("invalid-device-config", message);
}

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw invalid(`${name} must be a positive number`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw invalid(`${name} must be a positive integer`);
  return value as number;
}

function optionalBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw invalid(`${name} must be a boolean`);
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw invalid(`${name} must be a non-empty string`);
  return value;
}

function parseRange(raw: unknown, name: string): Range {
  if (typeof raw !== "object" || raw === null) throw invalid(`${name} must be an object { min, max, unit }`);
  const r = raw as Record<string, unknown>;
  if (typeof r.min !== "number" || typeof r.max !== "number" || !Number.isFinite(r.min) || !Number.isFinite(r.max) || r.min > r.max) {
    throw invalid(`${name}: min and max must be finite numbers with min <= max`);
  }
  const range: Range = { min: r.min, max: r.max, unit: nonEmptyString(r.unit, `${name}.unit`) };
  if (r.step !== undefined) range.step = positive(r.step, `${name}.step`);
  return range;
}

function parseTool(raw: unknown, index: number): ToolDef {
  const where = `tools[${index}]`;
  if (typeof raw !== "object" || raw === null) throw invalid(`${where} must be an object`);
  const t = raw as Record<string, unknown>;
  const kind = nonEmptyString(t.kind, `${where}.kind`);
  if (!(TOOL_KIND_CATALOG as readonly string[]).includes(kind)) throw invalid(`${where}.kind must be one of ${TOOL_KIND_CATALOG.join(", ")}`);
  const params: ToolParams = {};
  if (t.params !== undefined) {
    if (typeof t.params !== "object" || t.params === null) throw invalid(`${where}.params must be an object`);
    const p = t.params as Record<string, unknown>;
    for (const name of PARAM_NAMES) if (p[name] !== undefined) params[name] = parseRange(p[name], `${where}.params.${name}`);
  }
  const tool: ToolDef = { id: nonEmptyString(t.id, `${where}.id`), kind, params };
  if (t.module !== undefined) tool.module = nonEmptyString(t.module, `${where}.module`);
  return tool;
}

function parseDelivery(raw: unknown): FolderDelivery | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) throw invalid("delivery must be an object");
  const d = raw as Record<string, unknown>;
  if (d.method !== "folder-import") throw invalid('delivery.method must be "folder-import"');
  const format = d.format ?? FORMAT_IDS.pdfCut;
  if (format !== FORMAT_IDS.pdfCut && format !== FORMAT_IDS.dxf) throw invalid(`delivery.format must be "${FORMAT_IDS.pdfCut}" or "${FORMAT_IDS.dxf}"`);
  return { method: "folder-import", folder: nonEmptyString(d.folder, "delivery.folder"), format };
}

export function parseFDeviceConfig(raw: DeviceConfig): FDeviceConfig {
  const bedOrigin = raw.bedOrigin ?? "bottom-left";
  if (!CORNERS.includes(bedOrigin as Corner)) throw invalid(`bedOrigin must be one of ${CORNERS.join(", ")}`);
  if (!Array.isArray(raw.tools) || raw.tools.length === 0) throw invalid("tools must list the installed tools and modules");
  const tools = raw.tools.map(parseTool);
  const ids = tools.map((t) => t.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) throw invalid(`duplicate tool id "${duplicate}"`);

  const config: FDeviceConfig = {
    bedWidthMm: positive(raw.bedWidthMm, "bedWidthMm"),
    bedLengthMm: positive(raw.bedLengthMm, "bedLengthMm"),
    bedOrigin: bedOrigin as Corner,
    conveyor: optionalBoolean(raw.conveyor, "conveyor"),
    tools,
    regmarkDiameterMm: raw.regmarkDiameterMm === undefined ? DEFAULT_REGMARK_DIAMETER_MM : positive(raw.regmarkDiameterMm, "regmarkDiameterMm"),
    enableExperimentalBarcode: optionalBoolean(raw.enableExperimentalBarcode, "enableExperimentalBarcode"),
  };
  if (raw.vacuumZones !== undefined) config.vacuumZones = positiveInteger(raw.vacuumZones, "vacuumZones");
  if (raw.toolSlots !== undefined) config.toolSlots = positiveInteger(raw.toolSlots, "toolSlots");
  const delivery = parseDelivery(raw.delivery);
  if (delivery) config.delivery = delivery;
  return config;
}

export function buildFProfile(config: FDeviceConfig): CutterProfile {
  return {
    class: "flatbed",
    workArea: { widthMm: config.bedWidthMm, lengthMm: config.bedLengthMm },
    flatbed: {
      bedOrigin: config.bedOrigin,
      conveyor: config.conveyor,
      ...(config.vacuumZones === undefined ? {} : { vacuumZones: config.vacuumZones }),
    },
    tools: config.tools.map((t) => ({ ...t, params: { ...t.params } })),
    ...(config.toolSlots === undefined ? {} : { toolSlots: config.toolSlots }),
    registration: {
      methods: ["camera-marks", "none"],
      markShapes: ["circle"],
      markSizeMm: { min: config.regmarkDiameterMm, max: config.regmarkDiameterMm, unit: "mm" },
      // Code 39 job ids are ours (an open symbology); the camera-side reading details are not documented.
      barcodeJobId: { supported: config.enableExperimentalBarcode, documented: false },
    },
    delivery: ["folder-import"],
    formats: [FORMAT_IDS.pdfCut, FORMAT_IDS.dxf],
  };
}
