// Summa S Class 2 (roll) capability profile. Public basis: the S Class 2 user
// manual and the Summa Cutter Tools manual (docs/research/cutter-integration.md
// [S2], [SC], [CT]). Remote queries need undocumented commands, so the work area
// and options come from user-entered device configuration.

import { CORNERS, CutterDriverError, type Corner, type CutterProfile, type DeviceConfig, type Range, type ToolParams } from "@bax-print/plugin-sdk";
import { parseTcpEndpoint, type TcpEndpoint } from "@bax-print/cut-export";

export const TOOL_IDS = { knife: "knife", pen: "pen", pouncing: "pouncing" } as const;

export type DeliveryConfig =
  | { method: "file"; outputDir: string }
  | { method: "tcp"; tcp: TcpEndpoint; enableUnverified: boolean }
  | { method: "usb"; devicePath: string; enableUnverified: boolean };

export interface S2DeviceConfig {
  /** Usable cutting width in mm, entered by the user for their model (e.g. a 160 cm class machine). */
  workAreaWidthMm: number;
  /** Tangential-knife models (T) vs. drag-knife models (D). Default "drag". */
  knife: "drag" | "tangential";
  /** Corner of the loaded media that is the cutter origin. Default "bottom-left". */
  loadOrigin: Corner;
  maxPanelLengthMm?: number;
  /** Velocity range for `VS`, in cm/s as in HP-GL/2. Without it, tools declare no speed range. */
  velocityRangeCmPerS?: { min: number; max: number };
  /** Lists `edge-mark-rows` (sensor marks) as supported. Experimental, off by default. */
  enableExperimentalOpos: boolean;
  delivery?: DeliveryConfig;
}

function invalid(message: string): CutterDriverError {
  return new CutterDriverError("invalid-device-config", message);
}

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw invalid(`${name} must be a positive number`);
  return value;
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

function parseDelivery(raw: unknown): DeliveryConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) throw invalid("delivery must be an object");
  const d = raw as Record<string, unknown>;
  switch (d.method) {
    case "file":
      return { method: "file", outputDir: nonEmptyString(d.outputDir, "delivery.outputDir") };
    case "tcp":
      try {
        return { method: "tcp", tcp: parseTcpEndpoint(d.tcp), enableUnverified: optionalBoolean(d.enableUnverified, "delivery.enableUnverified") };
      } catch (error) {
        if (error instanceof CutterDriverError) throw error;
        throw invalid(`delivery.${error instanceof Error ? error.message : String(error)}`);
      }
    case "usb":
      return {
        method: "usb",
        devicePath: nonEmptyString(d.devicePath, "delivery.devicePath"),
        enableUnverified: optionalBoolean(d.enableUnverified, "delivery.enableUnverified"),
      };
    default:
      throw invalid('delivery.method must be "file", "tcp" or "usb"');
  }
}

export function parseS2DeviceConfig(raw: DeviceConfig): S2DeviceConfig {
  const knife = raw.knife ?? "drag";
  if (knife !== "drag" && knife !== "tangential") throw invalid('knife must be "drag" or "tangential"');
  const loadOrigin = raw.loadOrigin ?? "bottom-left";
  if (!CORNERS.includes(loadOrigin as Corner)) throw invalid(`loadOrigin must be one of ${CORNERS.join(", ")}`);
  const config: S2DeviceConfig = {
    workAreaWidthMm: positive(raw.workAreaWidthMm, "workAreaWidthMm"),
    knife: knife as S2DeviceConfig["knife"],
    loadOrigin: loadOrigin as Corner,
    enableExperimentalOpos: optionalBoolean(raw.enableExperimentalOpos, "enableExperimentalOpos"),
  };
  if (raw.maxPanelLengthMm !== undefined) config.maxPanelLengthMm = positive(raw.maxPanelLengthMm, "maxPanelLengthMm");
  if (raw.velocityRangeCmPerS !== undefined) {
    const v = raw.velocityRangeCmPerS as Record<string, unknown> | null;
    const min = positive(v?.min, "velocityRangeCmPerS.min");
    const max = positive(v?.max, "velocityRangeCmPerS.max");
    if (min > max) throw invalid("velocityRangeCmPerS.min must be <= max");
    config.velocityRangeCmPerS = { min, max };
  }
  const delivery = parseDelivery(raw.delivery);
  if (delivery) config.delivery = delivery;
  return config;
}

export function buildS2Profile(config: S2DeviceConfig): CutterProfile {
  const speed: Range | undefined = config.velocityRangeCmPerS && { ...config.velocityRangeCmPerS, unit: "cm/s" };
  // Force and offset are set on the cutter or in the vendor's tools, so no ranges are declared for them.
  const params: ToolParams = speed ? { speed } : {};
  return {
    class: "roll",
    workArea: { widthMm: config.workAreaWidthMm },
    roll: {
      // No documented command advances panels or cuts sheets off.
      supportsPanelAdvance: false,
      supportsSheetOff: false,
      loadOrigin: config.loadOrigin,
      ...(config.maxPanelLengthMm === undefined ? {} : { maxPanelLengthMm: config.maxPanelLengthMm }),
    },
    tools: [
      { id: TOOL_IDS.knife, kind: config.knife === "tangential" ? "tangential-knife" : "drag-knife", params },
      { id: TOOL_IDS.pen, kind: "pen", params },
      { id: TOOL_IDS.pouncing, kind: "pouncing", params },
    ],
    registration: {
      methods: config.enableExperimentalOpos ? ["none", "edge-mark-rows"] : ["none"],
      experimental: ["edge-mark-rows"],
      markShapes: ["square"],
      supportsDeformationComp: ["x", "xy", "segmented"],
      // The barcode feature is described publicly; its encoding is not, and it is activation-code locked.
      barcodeJobId: { supported: true, documented: false },
    },
    delivery: ["file", "usb", "tcp"],
    formats: ["hpgl"],
  };
}
