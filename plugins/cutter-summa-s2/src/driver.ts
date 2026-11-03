// CutterDriver/2 for Summa S Class 2 roll cutters (spec 004 Part F).
// Implemented from public documentation only:
// - HP-GL / HP-GL/2 output (the cutter's language menu must be set to HP-GL or HP-GL/2),
// - tool selection with `SP<n>;` (needs the cutter's "Tool command" setting enabled),
// - `VS` velocity only when the user opts in. Force and offset stay on the cutter.
// Not implemented: DM/PL (format id reserved, no public command reference),
// OPOS reading commands, barcode job identification. Supported workaround:
// export HPGL plus a print PDF with generic marks to a folder for the vendor's
// own cutter software, which then drives mark reading and barcodes.

import {
  CutterDriverError,
  makeExportResult,
  type CutFormat,
  type CutJob,
  type CutterDriver,
  type DeviceConfig,
  type DeviceStatus,
  type ExportResult,
  type SendResult,
} from "@bax-print/plugin-sdk";
import {
  HPGL_OPTIONS_SCHEMA,
  parseHpglOptions,
  safeFileStem,
  sendRawTcp,
  writeFileAtomic,
  writeHpgl,
  writeToDevicePath,
} from "@bax-print/cut-export";
import { buildS2Profile, parseS2DeviceConfig, TOOL_IDS } from "./profile.js";

export const HPGL_FORMAT_ID = "hpgl";
/** Reserved: DM/PL has no public command reference. Exports fail with "unsupported". */
export const DMPL_FORMAT_ID = "dmpl";
export const HPGL_MIME = "application/vnd.hp-hpgl";
export const HPGL_EXT = "plt";

/**
 * Pen numbers per physical tool id. A starting point only: the numbering the
 * cutter applies to `SP` depends on its tool settings. Override with
 * `options.penMap` (keys: tool ids or semantic tools; tool ids win).
 */
export const S2_DEFAULT_PEN_MAP: Readonly<Record<string, number>> = {
  [TOOL_IDS.knife]: 1,
  [TOOL_IDS.pen]: 2,
  [TOOL_IDS.pouncing]: 3,
};

export const S2_HPGL_OPTIONS_SCHEMA = {
  ...HPGL_OPTIONS_SCHEMA,
  properties: {
    ...HPGL_OPTIONS_SCHEMA.properties,
    penMap: { ...HPGL_OPTIONS_SCHEMA.properties.penMap, default: S2_DEFAULT_PEN_MAP },
    sendForce: {
      type: "boolean",
      default: false,
      description: "Ignored: no documented force command. Set force on the cutter or in the vendor's tools.",
    },
    enableExperimentalOpos: {
      type: "boolean",
      default: false,
      "x-experimental": true,
      description:
        "Allow jobs with edge-mark-rows registration. No mark-reading commands are emitted; start reading on the cutter. Coordinates are relative to the origin mark.",
    },
    barcodeJobId: { type: "boolean", default: false, description: "Not implemented (undocumented format)." },
  },
} as const;

const FORMATS: CutFormat[] = [{ id: HPGL_FORMAT_ID, mime: HPGL_MIME, ext: HPGL_EXT, optionsSchema: S2_HPGL_OPTIONS_SCHEMA }];

function wantsOpos(job: CutJob): boolean {
  return job.marks?.method === "edge-mark-rows" || job.options?.opos === true;
}

function exportHpgl(job: CutJob): ExportResult {
  const options = job.options ?? {};
  if (options.barcodeJobId === true) {
    throw new CutterDriverError("unsupported", "barcode job identification is not implemented: the barcode format is not publicly documented");
  }
  const oposEnabled = options.enableExperimentalOpos === true;
  if (wantsOpos(job) && !oposEnabled) {
    throw new CutterDriverError(
      "experimental-disabled",
      "edge-mark-rows (sensor mark) registration is experimental and disabled; set options.enableExperimentalOpos to use it",
    );
  }
  const warnings: string[] = [];
  const parsed = parseHpglOptions(options);
  if (parsed.sendForce) warnings.push("sendForce ignored: no documented force command; set force on the cutter");
  const { text, warnings: writerWarnings } = writeHpgl(job, {
    ...parsed,
    sendForce: false,
    penMap: { ...S2_DEFAULT_PEN_MAP, ...parsed.penMap },
  });
  warnings.push(...writerWarnings);
  if (wantsOpos(job)) {
    warnings.push("experimental: no mark-reading commands are emitted; start mark reading on the cutter before cutting");
  } else if (job.marks && job.marks.marks.length > 0) {
    warnings.push("coordinates are relative to the origin mark; align the cutter origin to it");
  }
  return makeExportResult({
    bytes: new TextEncoder().encode(text),
    fileName: `${safeFileStem(job.jobId)}.${HPGL_EXT}`,
    mime: HPGL_MIME,
    warnings,
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSummaS2Driver(): CutterDriver {
  const driver: CutterDriver = {
    describe(deviceConfig: DeviceConfig) {
      return buildS2Profile(parseS2DeviceConfig(deviceConfig));
    },

    formats() {
      return FORMATS.map((f) => ({ ...f }));
    },

    export(job: CutJob, format: string) {
      if (format === DMPL_FORMAT_ID) {
        throw new CutterDriverError("unsupported", "DM/PL is reserved but not implemented: no public command reference is available");
      }
      if (format !== HPGL_FORMAT_ID) throw new CutterDriverError("unsupported", `unknown format "${format}"`);
      return exportHpgl(job);
    },

    async send(job: CutJob, deviceConfig: DeviceConfig): Promise<SendResult> {
      const config = parseS2DeviceConfig(deviceConfig);
      const delivery = config.delivery;
      if (!delivery) return { status: "failed", detail: "no delivery configured (deviceConfig.delivery)" };
      const result = exportHpgl(job);
      try {
        switch (delivery.method) {
          case "file": {
            const path = await writeFileAtomic(delivery.outputDir, result.fileName, result.bytes);
            return { status: "delivered", detail: path };
          }
          case "tcp":
            // Ethernet is documented, the raw protocol and port are not. Verify with our own HPGL before relying on it.
            if (!delivery.enableUnverified) {
              return { status: "failed", detail: "raw TCP delivery is not verified on hardware; set delivery.enableUnverified to try it" };
            }
            await sendRawTcp(delivery.tcp, result.bytes);
            return { status: "delivered", detail: `${delivery.tcp.host}:${delivery.tcp.port}` };
          case "usb":
            if (!delivery.enableUnverified) {
              return { status: "failed", detail: "USB device-path delivery is not verified on hardware; set delivery.enableUnverified to try it" };
            }
            await writeToDevicePath(delivery.devicePath, result.bytes);
            return { status: "delivered", detail: delivery.devicePath };
        }
      } catch (error) {
        return { status: "failed", detail: errorText(error) };
      }
    },

    getStatus(): DeviceStatus {
      return { state: "unknown", reason: "no documented status query" };
    },
  };
  return driver;
}
