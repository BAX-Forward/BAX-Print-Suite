/**
 * Plugin-side BPP endpoint: owns the stdio `Connection`, answers the lifecycle methods
 * (`initialize`, `configure`, `shutdown`, `$/ping`) and rejects interface calls made before
 * `initialize` with `NotInitialized`.
 */
import type { Readable, Writable } from 'node:stream';
import { BPP_PROTOCOL, RpcError } from '../stub.js';
import {
  Connection,
  type ConnectionRequestHandler,
  type NotificationHandler,
} from './connection.js';
import { formatSchemaErrors, validateSchema } from './json-schema.js';
import { ConnectionClosedError, ErrorCodes, isPlainObject } from './jsonrpc.js';
import { createStderrLogger, type SdkLogger } from './logger.js';
import { negotiateInterfaces } from './negotiation.js';
import {
  LifecycleMethods,
  type BppPluginInfo,
  type InitializeParams,
  type InitializeResult,
  type InterfaceOffer,
  type PingResult,
  type PluginCapabilities,
} from './protocol.js';
import { INITIALIZE_PARAMS_SCHEMA } from './schemas.js';

export interface PluginServerOptions {
  plugin: BppPluginInfo;
  /** Concrete interface versions this plugin implements. */
  offers: readonly InterfaceOffer[];
  capabilities?: PluginCapabilities;
  /** Defaults to `process.stdin`. */
  input?: Readable;
  /** Defaults to `process.stdout`. */
  output?: Writable;
  log?: SdkLogger;
  /** Receives `configure` settings. Settings may hold secrets: never log them. */
  onConfigure?: (settings: Record<string, unknown>) => void | Promise<void>;
  onShutdown?: () => void | Promise<void>;
  /** Called once the connection closes: 0 after a clean `shutdown`, 1 otherwise. */
  onExit?: (code: number) => void;
}

type ServerState = 'awaiting-initialize' | 'ready' | 'shut-down';

export class PluginServer {
  readonly connection: Connection;
  readonly log: SdkLogger;
  private state: ServerState = 'awaiting-initialize';
  private spool: string | undefined;

  constructor(private readonly options: PluginServerOptions) {
    this.log = options.log ?? createStderrLogger(options.plugin.id);
    this.connection = new Connection(options.input ?? process.stdin, options.output ?? process.stdout, {
      onError: (error) => this.log.error('protocol error', { error: error.message }),
    });
    this.connection.setRequestGuard((method) => this.guard(method));
    this.connection.onRequest(LifecycleMethods.initialize, (params) => this.initialize(params));
    this.connection.onRequest(LifecycleMethods.configure, (params) => this.configure(params));
    this.connection.onRequest(LifecycleMethods.shutdown, () => this.shutdown());
    this.connection.onRequest(LifecycleMethods.ping, (): PingResult => ({ time: Date.now() }));
    this.connection.onClose(() => options.onExit?.(this.state === 'shut-down' ? 0 : 1));
  }

  get isInitialized(): boolean {
    return this.state === 'ready';
  }

  /** The host-owned spool directory from `initialize`. */
  get spoolDir(): string {
    if (this.spool === undefined) {
      throw new RpcError(ErrorCodes.NotInitialized, 'Spool directory is unknown before initialize');
    }
    return this.spool;
  }

  onRequest<P = unknown, R = unknown>(method: string, handler: ConnectionRequestHandler<P, R>): () => void {
    return this.connection.onRequest(method, handler);
  }

  onNotification<P = unknown>(method: string, handler: NotificationHandler<P>): () => void {
    return this.connection.onNotification(method, handler);
  }

  notify(method: string, params?: unknown): boolean {
    return this.connection.notify(method, params);
  }

  private guard(method: string): RpcError | undefined {
    if (method === LifecycleMethods.ping) {
      return undefined;
    }
    switch (this.state) {
      case 'awaiting-initialize':
        return method === LifecycleMethods.initialize
          ? undefined
          : new RpcError(ErrorCodes.NotInitialized, `Not initialized: ${method}`);
      case 'ready':
        return method === LifecycleMethods.initialize
          ? new RpcError(ErrorCodes.InvalidRequest, 'Already initialized')
          : undefined;
      case 'shut-down':
        return new RpcError(ErrorCodes.InvalidRequest, `Shut down: ${method}`);
    }
  }

  private initialize(params: unknown): InitializeResult {
    if (isPlainObject(params) && params.protocol !== BPP_PROTOCOL) {
      throw new RpcError(ErrorCodes.UnsupportedVersion, `Unsupported protocol: ${String(params.protocol)}`, {
        supported: [BPP_PROTOCOL],
      });
    }
    const errors = validateSchema(INITIALIZE_PARAMS_SCHEMA, params);
    if (errors.length > 0) {
      throw new RpcError(ErrorCodes.InvalidParams, 'Invalid initialize params', {
        errors: formatSchemaErrors(errors),
      });
    }
    const request = params as InitializeParams;
    const { selected, missing } = negotiateInterfaces(request.interfaces, this.options.offers);
    if (missing.length > 0) {
      throw new RpcError(
        ErrorCodes.UnsupportedVersion,
        `Unsupported interfaces: ${missing.map((m) => `${m.interface} ${m.versions}`).join(', ')}`,
        { missing, offered: this.options.offers },
      );
    }
    this.spool = request.spoolDir;
    this.state = 'ready';
    return {
      protocol: BPP_PROTOCOL,
      plugin: { ...this.options.plugin },
      interfaces: request.interfaces.length === 0 ? this.options.offers.map((offer) => ({ ...offer })) : selected,
      capabilities: { ...(this.options.capabilities ?? {}) },
    };
  }

  private async configure(params: unknown): Promise<null> {
    if (!isPlainObject(params) || !isPlainObject(params.settings)) {
      throw new RpcError(ErrorCodes.InvalidParams, 'configure requires a settings object');
    }
    await this.options.onConfigure?.(params.settings);
    return null;
  }

  private async shutdown(): Promise<null> {
    await this.options.onShutdown?.();
    this.state = 'shut-down';
    // Close after the response has been written.
    setImmediate(() => this.connection.close(new ConnectionClosedError('shutdown')));
    return null;
  }
}
