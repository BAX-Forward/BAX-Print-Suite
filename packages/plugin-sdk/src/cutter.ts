// CutterDriver/2 (spec 004 Part C). One interface covers roll and flatbed
// cutters through a declared profile. It supersedes the CutterDriver/1 sketch
// in ARCHITECTURE §3.3 (pre-1.0, nothing shipped on /1). Core code branches only
// on declared capabilities, never on vendor or model names.

import { createHash } from "node:crypto";

export const CUTTER_DRIVER_INTERFACE = "CutterDriver";
export const CUTTER_DRIVER_VERSION = "2.0.0";

/** A point in PDF points (1/72 in) unless stated otherwise. */
export type Point = [number, number];

export type Corner = "bottom-left" | "top-left" | "bottom-right" | "top-right";
export const CORNERS: readonly Corner[] = ["bottom-left", "top-left", "bottom-right", "top-right"];

export type MachineClass = "roll" | "flatbed";

/** Semantic tool of a contour. Plugins map these to physical tools via `CutJob.toolMap`. */
export type SemanticTool = "kiss" | "thru" | "crease" | "pen" | (string & {});

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * A flattened cut contour. Minimal local copy of the spec 004 Part A output so
 * this package stays free of imports from other packages.
 */
export interface Contour {
  id: string;
  tool: SemanticTool;
  source: { kind: "spot" | "layer"; name: string };
  closed: boolean;
  /** Points in pt, relative to the CutFrame bottom-left, y up. */
  points: Point[];
  bbox: BBox;
  areaSigned: number;
}

export interface Range {
  min: number;
  max: number;
  unit: string;
  step?: number;
}

export type ToolKind =
  | "drag-knife"
  | "tangential-knife"
  | "kiss"
  | "thru"
  | "crease"
  | "perforate"
  | "pen"
  | "router"
  | "drill"
  | "v-cut"
  | (string & {});

export interface ToolParams {
  speed?: Range;
  force?: Range;
  depth?: Range;
  offset?: Range;
  passes?: Range;
}

export interface ToolDef {
  id: string;
  kind: ToolKind;
  params: ToolParams;
  /** Flatbed module slot. */
  module?: string;
}

export type RegistrationMethod =
  | "none"
  | "corner-marks"
  | "edge-mark-rows"
  | "camera-marks"
  | "camera-contour"
  | (string & {});

export type DeformationComp = "x" | "xy" | "segmented";

export interface RegistrationModel {
  methods: RegistrationMethod[];
  markShapes?: ("circle" | "square")[];
  markSizeMm?: Range;
  /** e.g. scale along feed only, both axes, per segment. */
  supportsDeformationComp?: DeformationComp[];
  /** Vendor barcode formats are plugin-private. */
  barcodeJobId?: { supported: boolean; documented: boolean };
  /** Methods that exist but are experimental. They only appear in `methods` once the operator opts in. */
  experimental?: RegistrationMethod[];
}

export type DeliveryMethod = "file" | "folder-import" | "usb" | "tcp" | "serial" | (string & {});

export interface CutterProfile {
  class: MachineClass;
  /** `lengthMm`: flatbed bed length. For roll machines undefined means open-ended. */
  workArea: { widthMm: number; lengthMm?: number };
  roll?: {
    maxPanelLengthMm?: number;
    supportsSheetOff?: boolean;
    supportsPanelAdvance: boolean;
    loadOrigin: Corner;
  };
  flatbed?: { bedOrigin: Corner; vacuumZones?: number; conveyor?: boolean };
  tools: ToolDef[];
  toolSlots?: number;
  registration: RegistrationModel;
  /** How jobs reach the machine. */
  delivery: DeliveryMethod[];
  /** e.g. ["hpgl", "dxf"]. Plugin-specific ids are allowed. */
  formats: string[];
}

/** The sheet or layout area the contours are expressed in. Contours are relative to its bottom-left. */
export interface CutFrame {
  widthPt: number;
  heightPt: number;
}

export interface RegistrationMark {
  id: string;
  /** Mark center, in pt, in the CutFrame. */
  xPt: number;
  yPt: number;
  /** Mark diameter (or square side), in pt. */
  dPt: number;
}

export interface RegistrationMarks {
  marks: RegistrationMark[];
  originMarkId: string;
  /** Registration method the marks were drawn for. Defaults to "corner-marks". */
  method?: RegistrationMethod;
  shape?: "circle" | "square";
}

export interface ToolAssignment {
  toolId: string;
  speed?: number;
  force?: number;
  depth?: number;
  passes?: number;
}

export interface CutPanel {
  y0Mm: number;
  y1Mm: number;
  /** Ids of the registration marks this panel uses. */
  marks: string[];
}

export interface CutJob {
  jobId: string;
  /** `contour.tool` is a semantic tool ("kiss", "thru", ...). */
  contours: Contour[];
  /** Semantic tool -> physical tool of the profile, plus parameters. */
  toolMap: Record<string, ToolAssignment>;
  frame: CutFrame;
  marks?: RegistrationMarks;
  /** Roll panels or flatbed conveyor steps. */
  segmentation?: { panels: CutPanel[] };
  options: Record<string, unknown>;
}

export type JSONSchema = Record<string, unknown>;

export interface CutFormat {
  id: string;
  mime: string;
  /** File extension without the dot. */
  ext: string;
  optionsSchema: JSONSchema;
}

export type ArtifactHandle = { kind: "inline" } | { kind: "file"; path: string };

export interface ExportResult {
  handle: ArtifactHandle;
  bytes: Uint8Array;
  /** Lower-case hex SHA-256 of `bytes`. */
  sha256: string;
  warnings: string[];
  fileName: string;
  mime: string;
}

export interface SendResult {
  status: "delivered" | "failed";
  detail?: string;
}

export interface DeviceStatus {
  state: "ready" | "busy" | "offline" | "unknown";
  reason?: string;
}

/** Plugin-specific device configuration (user-entered or detected). Plugins validate it themselves. */
export type DeviceConfig = Record<string, unknown>;

type MaybePromise<T> = T | Promise<T>;

export interface CutterDriver {
  /** Static values from the manifest plus dynamic (detected or configured) values. */
  describe(deviceConfig: DeviceConfig): MaybePromise<CutterProfile>;
  formats(): MaybePromise<CutFormat[]>;
  export(job: CutJob, format: string): MaybePromise<ExportResult>;
  /** Folder drop, raw TCP, USB, ... */
  send?(job: CutJob, deviceConfig: DeviceConfig): MaybePromise<SendResult>;
  getStatus?(deviceConfig: DeviceConfig): MaybePromise<DeviceStatus>;
  cancel?(jobId: string): MaybePromise<void>;
}

export type CutterErrorCode =
  | "unsupported"
  | "experimental-disabled"
  | "invalid-job"
  | "invalid-options"
  | "invalid-device-config"
  | "delivery-failed";

export class CutterDriverError extends Error {
  readonly code: CutterErrorCode;

  constructor(code: CutterErrorCode, message: string) {
    super(message);
    this.name = "CutterDriverError";
    this.code = code;
  }
}

export function isCutterDriverError(error: unknown): error is CutterDriverError {
  return error instanceof CutterDriverError;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Builds an in-process export result with an inline handle and the computed hash. */
export function makeExportResult(args: {
  bytes: Uint8Array;
  fileName: string;
  mime: string;
  warnings?: string[];
}): ExportResult {
  return {
    handle: { kind: "inline" },
    bytes: args.bytes,
    sha256: sha256Hex(args.bytes),
    warnings: [...(args.warnings ?? [])],
    fileName: args.fileName,
    mime: args.mime,
  };
}
