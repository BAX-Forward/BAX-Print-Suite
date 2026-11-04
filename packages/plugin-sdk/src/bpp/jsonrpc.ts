/** JSON-RPC 2.0 message types and errors (https://www.jsonrpc.org/specification). */

import { RpcError } from '../stub.js';

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export type JsonRpcEnvelope = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const ErrorCodes = Object.freeze({
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Application error raised by a plugin (same code as the stub's `RpcErrorCode.PluginError`). */
  PluginError: -32001,
  /** Request received before `initialize` completed. */
  NotInitialized: -32002,
  /** The plugin does not support a requested interface or protocol version. */
  UnsupportedVersion: -32010,
  RequestCancelled: -32800,
  RequestFailed: -32803,
  /** Host-side only: no response within the timeout. */
  RequestTimeout: -32804,
});

export function rpcErrorToObject(error: RpcError): JsonRpcErrorObject {
  return error.data === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, data: error.data };
}

export class RequestCancelledError extends RpcError {
  constructor(method: string) {
    super(ErrorCodes.RequestCancelled, `Request cancelled: ${method}`);
    this.name = 'RequestCancelledError';
  }
}

export class RequestTimeoutError extends RpcError {
  constructor(method: string, timeoutMs: number) {
    super(ErrorCodes.RequestTimeout, `Request timed out after ${timeoutMs} ms: ${method}`);
    this.name = 'RequestTimeoutError';
  }
}

export class ConnectionClosedError extends Error {
  constructor(reason: string) {
    super(`Connection closed: ${reason}`);
    this.name = 'ConnectionClosedError';
  }
}

export function toErrorObject(error: unknown): JsonRpcErrorObject {
  if (error instanceof RpcError) {
    return rpcErrorToObject(error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: ErrorCodes.InternalError, message };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
