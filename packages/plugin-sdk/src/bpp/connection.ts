import type { Readable, Writable } from 'node:stream';
import { RpcError } from '../stub.js';
import { encodeFrame, FrameDecoder } from './framing.js';
import {
  ConnectionClosedError,
  ErrorCodes,
  isPlainObject,
  RequestCancelledError,
  RequestTimeoutError,
  rpcErrorToObject,
  toErrorObject,
  type JsonRpcEnvelope,
  type JsonRpcErrorObject,
  type JsonRpcId,
} from './jsonrpc.js';

export const CANCEL_METHOD = '$/cancel';
export const PROGRESS_METHOD = '$/progress';

export interface ProgressValue {
  percent?: number;
  message?: string;
}

export interface RequestContext {
  id: JsonRpcId;
  /** Aborted when the peer sends `$/cancel` for this request or the connection closes. */
  signal: AbortSignal;
  /** Sends a `$/progress` notification tied to this request. */
  progress(value: ProgressValue): void;
}

/** Named apart from the stub's `RequestHandler`, which has no request context. */
export type ConnectionRequestHandler<P = unknown, R = unknown> = (
  params: P,
  context: RequestContext,
) => R | Promise<R>;

export type NotificationHandler<P = unknown> = (params: P) => void | Promise<void>;

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Returns an error to reject a request before its handler runs, or undefined to allow it. */
export type RequestGuard = (method: string) => RpcError | undefined;

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface ConnectionOptions {
  /** Called for protocol-level problems that cannot be reported to the peer. */
  onError?: (error: Error) => void;
}

function rpcErrorFromObject(error: JsonRpcErrorObject): RpcError {
  return new RpcError(error.code, error.message, error.data);
}

/**
 * A bidirectional JSON-RPC 2.0 endpoint over a pair of byte streams with Content-Length framing.
 * Used by both the host (child stdout/stdin) and plugins (process stdin/stdout).
 */
export class Connection {
  private readonly decoder = new FrameDecoder();
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly requestHandlers = new Map<string, ConnectionRequestHandler>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly inbound = new Map<JsonRpcId, AbortController>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private closedError: Error | undefined;
  private guard: RequestGuard | undefined;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: ConnectionOptions = {},
  ) {
    input.on('data', this.onData);
    input.on('end', this.onEnd);
    input.on('error', this.onStreamError);
    output.on('error', this.onStreamError);
  }

  get isClosed(): boolean {
    return this.closedError !== undefined;
  }

  setRequestGuard(guard: RequestGuard | undefined): void {
    this.guard = guard;
  }

  onRequest<P = unknown, R = unknown>(method: string, handler: ConnectionRequestHandler<P, R>): () => void {
    const stored = handler as unknown as ConnectionRequestHandler;
    this.requestHandlers.set(method, stored);
    return () => {
      if (this.requestHandlers.get(method) === stored) {
        this.requestHandlers.delete(method);
      }
    };
  }

  onNotification<P = unknown>(method: string, handler: NotificationHandler<P>): () => void {
    const stored = handler as unknown as NotificationHandler;
    const handlers = this.notificationHandlers.get(method) ?? new Set<NotificationHandler>();
    this.notificationHandlers.set(method, handlers);
    handlers.add(stored);
    return () => {
      handlers.delete(stored);
    };
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  request<R = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<R> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    if (options.signal?.aborted) {
      return Promise.reject(new RequestCancelledError(method));
    }
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const onAbort = (): void => {
        cleanup();
        this.notify(CANCEL_METHOD, { id });
        reject(new RequestCancelledError(method));
      };
      this.pending.set(id, {
        method,
        resolve: (value) => {
          cleanup();
          resolve(value as R);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        const timeoutMs = options.timeoutMs;
        timer = setTimeout(() => {
          cleanup();
          this.notify(CANCEL_METHOD, { id });
          reject(new RequestTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Sends a notification. Returns false when the connection is closed. */
  notify(method: string, params?: unknown): boolean {
    if (this.closedError) {
      return false;
    }
    this.send({ jsonrpc: '2.0', method, params });
    return true;
  }

  /** Closes the connection, rejecting pending requests and aborting in-flight handlers. */
  close(error: Error = new ConnectionClosedError('closed by owner')): void {
    if (this.closedError) {
      return;
    }
    this.closedError = error;
    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);
    for (const pending of [...this.pending.values()]) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const controller of this.inbound.values()) {
      controller.abort(error);
    }
    this.inbound.clear();
    for (const listener of this.closeListeners) {
      listener(error);
    }
    this.closeListeners.clear();
  }

  private readonly onData = (chunk: Buffer | string): void => {
    let bodies: string[];
    try {
      bodies = this.decoder.push(chunk);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.options.onError?.(err);
      this.close(err);
      return;
    }
    for (const body of bodies) {
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        this.send({
          jsonrpc: '2.0',
          id: null,
          error: { code: ErrorCodes.ParseError, message: 'Parse error' },
        });
        continue;
      }
      this.dispatch(message);
    }
  };

  private readonly onEnd = (): void => {
    this.close(new ConnectionClosedError('input ended'));
  };

  private readonly onStreamError = (error: Error): void => {
    this.close(new ConnectionClosedError(error.message));
  };

  private dispatch(message: unknown): void {
    if (!isPlainObject(message) || message.jsonrpc !== '2.0') {
      this.send({
        jsonrpc: '2.0',
        id: null,
        error: { code: ErrorCodes.InvalidRequest, message: 'Invalid Request' },
      });
      return;
    }
    if (typeof message.method === 'string') {
      const id = message.id;
      if (id === undefined || id === null) {
        this.handleNotification(message.method, message.params);
      } else if (typeof id === 'number' || typeof id === 'string') {
        void this.handleRequest(id, message.method, message.params);
      } else {
        this.send({
          jsonrpc: '2.0',
          id: null,
          error: { code: ErrorCodes.InvalidRequest, message: 'Invalid request id' },
        });
      }
      return;
    }
    const id = message.id;
    if (typeof id !== 'number' && typeof id !== 'string') {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    if (isPlainObject(message.error)) {
      pending.reject(rpcErrorFromObject(message.error as unknown as JsonRpcErrorObject));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === CANCEL_METHOD) {
      const id = isPlainObject(params) ? params.id : undefined;
      if (typeof id === 'number' || typeof id === 'string') {
        this.inbound.get(id)?.abort(new RequestCancelledError(method));
      }
      return;
    }
    const handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      return;
    }
    for (const handler of [...handlers]) {
      // Start the handler synchronously, like request handlers, so it sees messages in arrival
      // order: a request that follows a notification in the same chunk must not overtake it.
      new Promise<void>((resolve) => resolve(handler(params)))
        .catch((error: unknown) => {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
    }
  }

  private async handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const guardError = this.guard?.(method);
    if (guardError) {
      this.send({ jsonrpc: '2.0', id, error: rpcErrorToObject(guardError) });
      return;
    }
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: ErrorCodes.MethodNotFound, message: `Method not found: ${method}` },
      });
      return;
    }
    const controller = new AbortController();
    this.inbound.set(id, controller);
    try {
      const result = await handler(params, {
        id,
        signal: controller.signal,
        progress: (value) => {
          this.notify(PROGRESS_METHOD, { token: id, value });
        },
      });
      if (controller.signal.aborted) {
        throw new RequestCancelledError(method);
      }
      this.send({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
    } catch (error) {
      this.send({ jsonrpc: '2.0', id, error: toErrorObject(error) });
    } finally {
      this.inbound.delete(id);
    }
  }

  private send(message: JsonRpcEnvelope): void {
    if (this.closedError || this.output.destroyed || !this.output.writable) {
      return;
    }
    try {
      this.output.write(encodeFrame(message));
    } catch (error) {
      this.close(new ConnectionClosedError(error instanceof Error ? error.message : String(error)));
    }
  }
}
