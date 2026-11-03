// CutterDriver/2 over BPP. Artifacts travel by handle: when the host configures
// a spool directory the plugin writes the file there and returns its path,
// otherwise the bytes are inlined as base64 (small files, tests).

import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  CUTTER_DRIVER_INTERFACE,
  CUTTER_DRIVER_VERSION,
  CutterDriverError,
  type ArtifactHandle,
  type CutFormat,
  type CutJob,
  type CutterDriver,
  type CutterErrorCode,
  type CutterProfile,
  type DeviceConfig,
  type DeviceStatus,
  type ExportResult,
  type SendResult,
} from "./cutter.js";
import { BppClient, RpcError, RpcErrorCode, serveBpp, type PluginInfo, type RequestHandler, type ServeOptions } from "./stub.js";

export const CutterMethods = {
  configure: "configure",
  describe: "cutter/describe",
  formats: "cutter/formats",
  export: "cutter/export",
  send: "cutter/send",
  getStatus: "cutter/getStatus",
  cancel: "cutter/cancel",
} as const;

export interface WireExportResult {
  handle: ArtifactHandle;
  sha256: string;
  warnings: string[];
  fileName: string;
  mime: string;
  /** Present only for inline handles. */
  bytesBase64?: string;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RpcError(RpcErrorCode.InvalidParams, `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new RpcError(RpcErrorCode.InvalidParams, `${what} must be a non-empty string`);
  return value;
}

function cutterErrorToRpc(error: unknown): RpcError | undefined {
  if (error instanceof CutterDriverError) {
    return new RpcError(RpcErrorCode.PluginError, error.message, { code: error.code });
  }
  return undefined;
}

/** Serves a CutterDriver/2 implementation over stdio. Call from the plugin's `main`. */
export function serveCutterDriver(
  driver: CutterDriver,
  info: Omit<PluginInfo, "interfaces">,
  options: ServeOptions = {},
): void {
  let spoolDir: string | undefined;

  const handlers: Record<string, RequestHandler> = {
    [CutterMethods.configure]: (params) => {
      const p = params === undefined ? {} : asRecord(params, "configure params");
      spoolDir = p.spoolDir === undefined ? undefined : requireString(p.spoolDir, "spoolDir");
      return {};
    },
    [CutterMethods.describe]: (params) => {
      const p = params === undefined ? {} : asRecord(params, "describe params");
      return driver.describe(p.deviceConfig === undefined ? {} : asRecord(p.deviceConfig, "deviceConfig"));
    },
    [CutterMethods.formats]: () => driver.formats(),
    [CutterMethods.export]: async (params) => {
      const p = asRecord(params, "export params");
      const job = asRecord(p.job, "job") as unknown as CutJob;
      const result = await driver.export(job, requireString(p.format, "format"));
      return toWire(result, spoolDir);
    },
  };
  if (driver.send) {
    const send = driver.send.bind(driver);
    handlers[CutterMethods.send] = (params) => {
      const p = asRecord(params, "send params");
      return send(asRecord(p.job, "job") as unknown as CutJob, asRecord(p.deviceConfig ?? {}, "deviceConfig"));
    };
  }
  if (driver.getStatus) {
    const getStatus = driver.getStatus.bind(driver);
    handlers[CutterMethods.getStatus] = (params) => {
      const p = params === undefined ? {} : asRecord(params, "getStatus params");
      return getStatus(asRecord(p.deviceConfig ?? {}, "deviceConfig"));
    };
  }
  if (driver.cancel) {
    const cancel = driver.cancel.bind(driver);
    handlers[CutterMethods.cancel] = async (params) => {
      await cancel(requireString(asRecord(params, "cancel params").jobId, "jobId"));
      return null;
    };
  }

  serveBpp(
    { ...info, interfaces: [{ interface: CUTTER_DRIVER_INTERFACE, version: CUTTER_DRIVER_VERSION }] },
    handlers,
    { ...options, mapError: options.mapError ?? cutterErrorToRpc },
  );
}

async function toWire(result: ExportResult, spoolDir: string | undefined): Promise<WireExportResult> {
  const base = { sha256: result.sha256, warnings: result.warnings, fileName: result.fileName, mime: result.mime };
  if (spoolDir === undefined) {
    return { ...base, handle: { kind: "inline" }, bytesBase64: Buffer.from(result.bytes).toString("base64") };
  }
  const path = join(spoolDir, `${result.sha256.slice(0, 16)}-${basename(result.fileName)}`);
  await writeFile(path, result.bytes);
  return { ...base, handle: { kind: "file", path } };
}

async function call<T>(client: BppClient, method: string, params?: unknown): Promise<T> {
  try {
    return await client.request<T>(method, params);
  } catch (error) {
    if (error instanceof RpcError && error.code === RpcErrorCode.PluginError) {
      const data = error.data as { code?: CutterErrorCode } | undefined;
      if (data?.code) throw new CutterDriverError(data.code, error.message);
    }
    throw error;
  }
}

export interface CutterDriverClient extends Required<Pick<CutterDriver, "describe" | "formats" | "export" | "send" | "getStatus" | "cancel">> {
  configure(params: { spoolDir?: string }): Promise<void>;
}

/** Host-side adapter that presents a running plugin process as a `CutterDriver`. */
export function createCutterDriverClient(client: BppClient): CutterDriverClient {
  return {
    configure: async (params) => {
      await call(client, CutterMethods.configure, params);
    },
    describe: (deviceConfig: DeviceConfig) => call<CutterProfile>(client, CutterMethods.describe, { deviceConfig }),
    formats: () => call<CutFormat[]>(client, CutterMethods.formats),
    export: async (job: CutJob, format: string): Promise<ExportResult> => {
      const wire = await call<WireExportResult>(client, CutterMethods.export, { job, format });
      const bytes =
        wire.handle.kind === "file"
          ? new Uint8Array(await readFile(wire.handle.path))
          : new Uint8Array(Buffer.from(wire.bytesBase64 ?? "", "base64"));
      return { handle: wire.handle, bytes, sha256: wire.sha256, warnings: wire.warnings, fileName: wire.fileName, mime: wire.mime };
    },
    send: (job: CutJob, deviceConfig: DeviceConfig) => call<SendResult>(client, CutterMethods.send, { job, deviceConfig }),
    getStatus: (deviceConfig: DeviceConfig) => call<DeviceStatus>(client, CutterMethods.getStatus, { deviceConfig }),
    cancel: async (jobId: string) => {
      await call(client, CutterMethods.cancel, { jobId });
    },
  };
}
