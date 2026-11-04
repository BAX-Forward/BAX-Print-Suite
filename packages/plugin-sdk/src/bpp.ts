import type { Readable, Writable } from "node:stream";
import { RpcError, encodeMessage } from "./stub.js";

/**
 * Bidirectional BPP v1 connection (ARCHITECTURE §3.2, ADR-0003) with `$/cancel` support.
 * Same wire format as `stub.ts` (JSON-RPC 2.0, LSP-style `Content-Length` framing); used by
 * `Inspector/1`, whose requests can be long-running and cancellable.
 */

/** Control messages are small; large data travels by handle. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** BPP: the request was cancelled through `$/cancel`. */
  requestCancelled: -32800,
} as const;

export type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type WireMessage = JsonRpcRequest | JsonRpcResponse;

export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

const HEADER_END = Buffer.from("\r\n\r\n", "ascii");
const MAX_HEADER_BYTES = 8 * 1024;

/**
 * Incremental decoder: feed chunks, get whole messages. Throws `FramingError` on a broken
 * stream; a frame whose body is not JSON yields `PARSE_ERROR` so the peer can be told.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      const end = this.buffer.indexOf(HEADER_END);
      if (end < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) throw new FramingError("header too long");
        return messages;
      }
      const length = contentLength(this.buffer.subarray(0, end).toString("ascii"));
      const start = end + HEADER_END.length;
      if (this.buffer.length < start + length) return messages;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        messages.push(JSON.parse(body));
      } catch {
        messages.push(PARSE_ERROR);
      }
    }
  }
}

/** Marker for a frame whose body is not JSON. */
export const PARSE_ERROR = Symbol("bpp.parseError");

function contentLength(header: string): number {
  for (const line of header.split("\r\n")) {
    const match = /^content-length:\s*(\d+)\s*$/i.exec(line);
    if (!match) continue;
    const length = Number(match[1]);
    if (length > MAX_MESSAGE_BYTES) throw new FramingError(`message of ${length} bytes exceeds ${MAX_MESSAGE_BYTES}`);
    return length;
  }
  throw new FramingError("missing Content-Length header");
}

export type RpcRequestHandler = (params: unknown, signal: AbortSignal) => Promise<unknown> | unknown;
export type RpcNotificationHandler = (params: unknown) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One end of a JSON-RPC connection. Requests may be cancelled with an `AbortSignal`, which
 * sends `$/cancel`; incoming `$/cancel` aborts the signal passed to the handler.
 */
export class RpcConnection {
  private readonly output: Writable;
  private readonly reader = new FrameDecoder();
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly inFlight = new Map<JsonRpcId, AbortController>();
  private readonly requestHandlers = new Map<string, RpcRequestHandler>();
  private readonly notificationHandlers = new Map<string, RpcNotificationHandler>();
  private nextId = 1;
  private closedError: Error | undefined;
  private readonly closeListeners: ((error: Error) => void)[] = [];

  constructor(input: Readable, output: Writable) {
    this.output = output;
    input.on("data", (chunk: Buffer | string) => this.receive(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    input.on("end", () => this.close(new Error("connection closed")));
    input.on("error", (error: Error) => this.close(error));
    output.on("error", (error: Error) => this.close(error));
  }

  onRequest(method: string, handler: RpcRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: RpcNotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onClose(listener: (error: Error) => void): void {
    if (this.closedError) listener(this.closedError);
    else this.closeListeners.push(listener);
  }

  get closed(): boolean {
    return this.closedError !== undefined;
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new RpcError(RPC_ERRORS.requestCancelled, "cancelled"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => this.notify("$/cancel", { id });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedError) return;
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  close(error: Error = new Error("connection closed")): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const controller of this.inFlight.values()) controller.abort(error);
    this.inFlight.clear();
    this.closeListeners.splice(0).forEach((listener) => listener(error));
  }

  private send(message: WireMessage): void {
    this.output.write(encodeMessage(message));
  }

  private receive(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.reader.push(chunk);
    } catch (error) {
      this.close(error as Error);
      return;
    }
    for (const message of messages) this.dispatch(message);
  }

  private dispatch(message: unknown): void {
    if (message === PARSE_ERROR) {
      this.send({ jsonrpc: "2.0", id: null, error: { code: RPC_ERRORS.parseError, message: "parse error" } });
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      this.send({ jsonrpc: "2.0", id: null, error: { code: RPC_ERRORS.invalidRequest, message: "invalid request" } });
      return;
    }
    if (typeof message.method === "string") {
      const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
      if (id === undefined) this.handleNotification(message.method, message.params);
      else void this.handleRequest(id, message.method, message.params);
      return;
    }
    const id = message.id;
    if (typeof id !== "number" && typeof id !== "string") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (isRecord(message.error)) {
      const { code, message: text, data } = message.error;
      pending.reject(new RpcError(typeof code === "number" ? code : RPC_ERRORS.internalError, String(text ?? "error"), data));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "$/cancel") {
      const id = isRecord(params) ? params.id : undefined;
      if (typeof id === "number" || typeof id === "string") this.inFlight.get(id)?.abort(new RpcError(RPC_ERRORS.requestCancelled, "cancelled"));
      return;
    }
    this.notificationHandlers.get(method)?.(params);
  }

  private async handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.send({ jsonrpc: "2.0", id, error: { code: RPC_ERRORS.methodNotFound, message: `method not found: ${method}` } });
      return;
    }
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    try {
      const result = await handler(params, controller.signal);
      if (!this.closedError) this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      if (this.closedError) return;
      const rpc = error instanceof RpcError ? error : undefined;
      const code = rpc?.code ?? (controller.signal.aborted ? RPC_ERRORS.requestCancelled : RPC_ERRORS.internalError);
      this.send({ jsonrpc: "2.0", id, error: { code, message: (error as Error).message, ...(rpc?.data !== undefined ? { data: rpc.data } : {}) } });
    } finally {
      this.inFlight.delete(id);
    }
  }
}
