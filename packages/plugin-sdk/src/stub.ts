// Minimal BPP v1 stub (ARCHITECTURE §3.2): JSON-RPC 2.0 over stdio with
// LSP-style Content-Length framing, `initialize` / `shutdown` / `exit` /
// `$/ping`, and a small client that launches a plugin from its manifest.
// Replace with the spec 001 plugin-sdk on merge; the wire format must not change.

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const BPP_PROTOCOL = "bpp/1";

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  /** Application error raised by the plugin; `data.code` carries the plugin error code. */
  PluginError: -32001,
} as const;

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

/** Incremental Content-Length frame decoder. Feed it raw chunks, get whole messages back. */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = Buffer.alloc(0);
        throw new RpcError(RpcErrorCode.ParseError, "BPP frame without Content-Length header");
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) break;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      messages.push(JSON.parse(body));
    }
    return messages;
  }
}

/** Structured JSON-line log on stderr (stdout is reserved for the protocol). */
export function logToStderr(level: "debug" | "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`);
}

// ---------------------------------------------------------------------------
// Plugin side
// ---------------------------------------------------------------------------

export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

export interface PluginInfo {
  id: string;
  version: string;
  interfaces: { interface: string; version: string }[];
  capabilities?: Record<string, unknown>;
}

export interface ServeOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Called on `exit` or when the input closes. Defaults to `process.exit(0)`. */
  onExit?: () => void;
  /** Maps thrown application errors to RPC errors. Return undefined to use the default mapping. */
  mapError?: (error: unknown) => RpcError | undefined;
}

function toRpcError(error: unknown, mapError?: ServeOptions["mapError"]): RpcError {
  const mapped = mapError?.(error);
  if (mapped) return mapped;
  if (error instanceof RpcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RpcError(RpcErrorCode.Internal, message);
}

/** Serves a plugin over stdio (or the given streams). */
export function serveBpp(info: PluginInfo, handlers: Record<string, RequestHandler>, options: ServeOptions = {}): void {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const onExit = options.onExit ?? (() => process.exit(0));
  const reader = new MessageReader();
  const send = (message: JsonRpcMessage): void => {
    output.write(encodeMessage(message));
  };

  const builtins: Record<string, RequestHandler> = {
    initialize: () => ({
      protocol: BPP_PROTOCOL,
      plugin: { id: info.id, version: info.version },
      interfaces: info.interfaces,
      capabilities: info.capabilities ?? {},
    }),
    shutdown: () => null,
    "$/ping": () => ({}),
  };

  const dispatch = async (message: JsonRpcMessage): Promise<void> => {
    if (typeof message.method !== "string") return; // responses are not expected on the plugin side
    if (message.method === "exit") {
      onExit();
      return;
    }
    const handler = handlers[message.method] ?? builtins[message.method];
    const isNotification = message.id === undefined || message.id === null;
    if (!handler) {
      if (!isNotification) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: RpcErrorCode.MethodNotFound, message: `Method not found: ${message.method}` } });
      }
      return;
    }
    try {
      const result = await handler(message.params);
      if (!isNotification) send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch (error) {
      const rpcError = toRpcError(error, options.mapError);
      if (isNotification) {
        logToStderr("error", "notification handler failed", { method: message.method, error: rpcError.message });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: rpcError.code, message: rpcError.message, ...(rpcError.data === undefined ? {} : { data: rpcError.data }) },
      });
    }
  };

  input.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = reader.push(chunk);
    } catch (error) {
      logToStderr("error", "invalid BPP frame", { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    for (const message of messages) void dispatch(message as JsonRpcMessage);
  });
  input.on("end", onExit);
}

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  license: string;
  provides: { interface: string; versions: string }[];
  protocol: string;
  exec: { command: string; args?: string[]; platforms?: string[] };
  externalDependencies?: { name: string; license: string; userInstalled?: boolean; detect?: string }[];
  permissions?: { fs?: string[]; network?: boolean; devices?: string[] };
  capabilities?: Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseManifest(raw: unknown): PluginManifest {
  if (typeof raw !== "object" || raw === null) throw new Error("manifest: not an object");
  const m = raw as Record<string, unknown>;
  for (const key of ["id", "name", "version", "license", "protocol"] as const) {
    if (!isNonEmptyString(m[key])) throw new Error(`manifest: "${key}" must be a non-empty string`);
  }
  if (!Array.isArray(m.provides) || m.provides.length === 0) throw new Error('manifest: "provides" must be a non-empty array');
  for (const p of m.provides as unknown[]) {
    const entry = p as Record<string, unknown>;
    if (!isNonEmptyString(entry?.interface) || !isNonEmptyString(entry?.versions)) {
      throw new Error('manifest: each "provides" entry needs "interface" and "versions"');
    }
  }
  const exec = m.exec as Record<string, unknown> | undefined;
  if (!exec || !isNonEmptyString(exec.command)) throw new Error('manifest: "exec.command" is required');
  if (exec.args !== undefined && !(Array.isArray(exec.args) && exec.args.every((a) => typeof a === "string"))) {
    throw new Error('manifest: "exec.args" must be an array of strings');
  }
  return m as unknown as PluginManifest;
}

export async function readManifest(manifestPath: string): Promise<PluginManifest> {
  return parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
}

const ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
];

/** Plugins run with a scrubbed environment (ARCHITECTURE §3.7). */
export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(ENV_ALLOWLIST.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}


/** When a plugin is launched via node+tsx on TypeScript sources, enable the
 *  workspace `@bax-print/source` export condition so unbuilt workspace packages
 *  resolve. Plain `node dist/...` launches are left unchanged so they keep the
 *  compiled `default` export. */
function withSourceCondition(command: string, args: string[]): string[] {
  if (command !== "node" && command !== process.execPath) return args;
  if (args.includes("--conditions") || args.some((a) => a.startsWith("--conditions="))) return args;
  const usesTsx = args.includes("tsx") || args.includes("--import=tsx") || args.some((a, i) => a === "--import" && args[i + 1] === "tsx");
  const runsTs = args.some((a) => a.endsWith(".ts"));
  if (!usesTsx && !runsTs) return args;
  return ["--conditions=@bax-print/source", ...args];
}

export class BppClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly reader = new MessageReader();
  private exited = false;
  private readonly exitPromise: Promise<void>;

  constructor(private readonly child: ChildProcess, onStderrLine?: (line: string) => void) {
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    let stderrBuffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onStderrLine?.(line);
    });
    this.exitPromise = new Promise((resolveExit) => {
      child.on("exit", (code, signal) => {
        this.exited = true;
        this.rejectAll(new Error(`plugin process exited (code ${code ?? "null"}, signal ${signal ?? "none"})`));
        resolveExit();
      });
      child.on("error", (error) => {
        this.exited = true;
        this.rejectAll(error);
        resolveExit();
      });
    });
  }

  static spawn(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; onStderrLine?: (line: string) => void }): BppClient {
    const resolvedCommand = command === "node" ? process.execPath : command;
    const child = spawn(resolvedCommand, withSourceCondition(resolvedCommand, args), {
      cwd: options.cwd,
      env: options.env ?? scrubEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return new BppClient(child, options.onStderrLine);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error("plugin process is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`BPP request "${method}" timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest as (value: unknown) => void, reject: rejectRequest, timer });
      this.child.stdin?.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.exited) return;
    this.child.stdin?.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  /** Graceful `shutdown` + `exit`, then kill if the process does not exit in time. */
  async close(timeoutMs = 5_000): Promise<void> {
    if (this.exited) return;
    try {
      await this.request("shutdown", undefined, timeoutMs);
    } catch {
      // The process may already be gone; fall through to exit/kill.
    }
    this.notify("exit");
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill(), timeoutMs);
    await this.exitPromise;
    clearTimeout(timer);
  }

  private onData(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.reader.push(chunk);
    } catch (error) {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const raw of messages) {
      const message = raw as JsonRpcMessage;
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export interface LaunchedPlugin {
  client: BppClient;
  manifest: PluginManifest;
  initializeResult: Record<string, unknown>;
}

/** Spawns a plugin from its `bps-plugin.json` (cwd = manifest directory) and runs `initialize`. */
export async function launchPlugin(
  manifestPath: string,
  options: { initializeTimeoutMs?: number; onStderrLine?: (line: string) => void } = {},
): Promise<LaunchedPlugin> {
  const absolute = resolve(manifestPath);
  const manifest = await readManifest(absolute);
  if (manifest.protocol !== BPP_PROTOCOL) throw new Error(`unsupported protocol ${manifest.protocol}`);
  const client = BppClient.spawn(manifest.exec.command, manifest.exec.args ?? [], {
    cwd: dirname(absolute),
    onStderrLine: options.onStderrLine,
  });
  try {
    const initializeResult = await client.request<Record<string, unknown>>(
      "initialize",
      { protocol: BPP_PROTOCOL, host: { name: "bps-host", version: "0.1.0" } },
      options.initializeTimeoutMs ?? 5_000,
    );
    return { client, manifest, initializeResult };
  } catch (error) {
    await client.close(1_000);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Minimal semver range check for manifest `provides[].versions`
// ---------------------------------------------------------------------------

function parseVersion(version: string): [number, number, number] {
  const parts = version.trim().split(".").map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) throw new Error(`invalid version "${version}"`);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** Supports space-separated comparators (`>=2.0 <3`, `=2.0.0`, `2.1`). */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => {
      const match = /^(>=|<=|>|<|=)?(.+)$/.exec(comparator);
      if (!match) return false;
      const cmp = compareVersions(v, parseVersion(match[2]!));
      switch (match[1] ?? "=") {
        case ">=":
          return cmp >= 0;
        case "<=":
          return cmp <= 0;
        case ">":
          return cmp > 0;
        case "<":
          return cmp < 0;
        default:
          return cmp === 0;
      }
    });
}
