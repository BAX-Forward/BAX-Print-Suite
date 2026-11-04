import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { RPC_ERRORS, RpcConnection } from "./bpp.js";
import { BPP_PROTOCOL, RpcError } from "./stub.js";
import {
  FixupRequestSchema,
  FixupResultSchema,
  INSPECTOR_INTERFACE,
  INSPECTOR_INTERFACE_VERSION,
  InspectRequestSchema,
  PreflightReportSchema,
  type FixupRequest,
  type FixupResult,
  type InspectRequest,
  type Inspector,
  type PreflightReport,
} from "./inspector.js";

/**
 * `Inspector/1` over BPP v1. Methods: `initialize`, `inspector/inspect`, `inspector/fixup`,
 * `$/ping`, `shutdown`, and the `exit` notification. Both ends validate payloads against the
 * JSON Schemas in `inspector.ts`, so a plugin in any language sees the same contract.
 */

export const INSPECT_METHOD = "inspector/inspect";
export const FIXUP_METHOD = "inspector/fixup";

export interface InspectorInitializeResult {
  protocol: string;
  plugin: { id: string; version: string };
  provides: { interface: string; version: string }[];
  capabilities: { fixupTargets: string[]; [key: string]: unknown };
}

function checked<T>(schema: TSchema, value: unknown, what: string, code: number): T {
  if (Value.Check(schema, value)) return value as T;
  const errors = [...Value.Errors(schema, value)].slice(0, 5).map((e) => `${e.path || "/"}: ${e.message}`);
  throw new RpcError(code, `invalid ${what}: ${errors.join("; ")}`);
}

export interface InspectorServeOptions {
  input?: Readable;
  output?: Writable;
  /** Extra dynamic capabilities for `initialize`, e.g. a detected engine version. */
  capabilities?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Called on `exit`. Defaults to ending the process. */
  onExit?: () => void;
}

/** Serves an `Inspector` implementation on stdio (or the given streams). Plugin side. */
export function serveInspector(inspector: Inspector, options: InspectorServeOptions = {}): RpcConnection {
  const connection = new RpcConnection(options.input ?? process.stdin, options.output ?? process.stdout);
  const fixupTargets = inspector.fixup ? [...(inspector.fixupTargets ?? [])] : [];
  connection.onRequest("initialize", async (): Promise<InspectorInitializeResult> => ({
    protocol: BPP_PROTOCOL,
    plugin: { id: inspector.id, version: inspector.version },
    provides: [{ interface: INSPECTOR_INTERFACE, version: INSPECTOR_INTERFACE_VERSION }],
    capabilities: { ...(await options.capabilities?.()), fixupTargets },
  }));
  connection.onRequest("$/ping", () => ({}));
  connection.onRequest(INSPECT_METHOD, (params, signal) =>
    inspector.inspect(checked<InspectRequest>(InspectRequestSchema, params, "inspect request", RPC_ERRORS.invalidParams), signal),
  );
  connection.onRequest(FIXUP_METHOD, (params, signal) => {
    const request = checked<FixupRequest>(FixupRequestSchema, params, "fixup request", RPC_ERRORS.invalidParams);
    if (!inspector.fixup || !fixupTargets.includes(request.target)) {
      throw new RpcError(RPC_ERRORS.invalidParams, `fixup target ${JSON.stringify(request.target)} is not supported`);
    }
    return inspector.fixup(request, signal);
  });
  connection.onRequest("shutdown", () => null);
  connection.onNotification("exit", () => {
    connection.close();
    (options.onExit ?? (() => process.exit(0)))();
  });
  return connection;
}

/** Host-side proxy for a plugin process. */
export class RemoteInspector implements Inspector {
  readonly id: string;
  readonly version: string;
  readonly fixupTargets: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  private readonly connection: RpcConnection;
  private readonly terminate: () => void;

  constructor(connection: RpcConnection, init: InspectorInitializeResult, terminate: () => void = () => {}) {
    this.connection = connection;
    this.id = init.plugin.id;
    this.version = init.plugin.version;
    this.fixupTargets = init.capabilities.fixupTargets;
    this.capabilities = init.capabilities;
    this.terminate = terminate;
  }

  /** Connects over existing streams and runs `initialize`. */
  static async connect(input: Readable, output: Writable, terminate?: () => void): Promise<RemoteInspector> {
    const connection = new RpcConnection(input, output);
    const init = (await connection.request("initialize", { protocol: BPP_PROTOCOL, host: { name: "bps" } })) as InspectorInitializeResult;
    if (init?.protocol !== BPP_PROTOCOL) throw new Error(`plugin speaks ${String(init?.protocol)}, expected ${BPP_PROTOCOL}`);
    const major = INSPECTOR_INTERFACE_VERSION.split(".")[0];
    const provided = init.provides?.find((p) => p.interface === INSPECTOR_INTERFACE && p.version.split(".")[0] === major);
    if (!provided) throw new Error(`plugin does not provide ${INSPECTOR_INTERFACE}/${major}`);
    return new RemoteInspector(connection, { ...init, capabilities: { ...init.capabilities, fixupTargets: init.capabilities?.fixupTargets ?? [] } }, terminate);
  }

  async inspect(request: InspectRequest, signal?: AbortSignal): Promise<PreflightReport> {
    const result = await this.connection.request(INSPECT_METHOD, request, signal);
    return checked<PreflightReport>(PreflightReportSchema, result, "inspect result", RPC_ERRORS.internalError);
  }

  readonly fixup = async (request: FixupRequest, signal?: AbortSignal): Promise<FixupResult> => {
    const result = await this.connection.request(FIXUP_METHOD, request, signal);
    return checked<FixupResult>(FixupResultSchema, result, "fixup result", RPC_ERRORS.internalError);
  };

  async close(): Promise<void> {
    if (!this.connection.closed) {
      try {
        await this.connection.request("shutdown");
        this.connection.notify("exit");
      } catch {
        // The plugin is going away either way.
      }
    }
    this.connection.close();
    this.terminate();
  }
}

export interface SpawnOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** The plugin gets this environment only (ARCHITECTURE §3.7: scrubbed environment). */
  env?: Record<string, string>;
  /** Receives the plugin's stderr log lines. */
  onLog?: (line: string) => void;
}

/** Starts a plugin process and connects to it. */
export async function spawnInspector(options: SpawnOptions): Promise<RemoteInspector> {
  const child = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.env ?? { PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const lines = (stderrTail + chunk).split("\n");
    stderrTail = lines.pop() ?? "";
    lines.filter(Boolean).forEach((line) => options.onLog?.(line));
  });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await spawned;
  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  try {
    const inspector = await RemoteInspector.connect(child.stdout, child.stdin, kill);
    child.once("exit", () => inspector.close());
    return inspector;
  } catch (error) {
    kill();
    throw error;
  }
}
