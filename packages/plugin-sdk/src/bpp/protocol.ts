import type { JsonRpcId } from './jsonrpc.js';

/**
 * BPS Plugin Protocol v1 message types (ARCHITECTURE.md §3.2). The protocol id (`BPP_PROTOCOL`,
 * "bpp/1") is exported by `../stub.ts`, which shares this wire format.
 */
export const BPP_PROTOCOL_VERSION = '1.0.0';

/** Default time the host waits for a plugin to answer `initialize`. */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;

export const LifecycleMethods = Object.freeze({
  initialize: 'initialize',
  configure: 'configure',
  shutdown: 'shutdown',
  ping: '$/ping',
  cancel: '$/cancel',
  progress: '$/progress',
});

export const BandMethods = Object.freeze({
  /** Notification, producer → consumer: a band is ready behind a handle. */
  data: 'band/data',
  /** Notification, consumer → producer: the band was consumed and its buffer may be reused. */
  release: 'band/release',
});

export const INTERFACE_NAMES = [
  'RenderEngine',
  'ColorEngine',
  'Screener',
  'PrinterDriver',
  'CutterDriver',
  'Inspector',
  'Storage',
] as const;

export type InterfaceName = (typeof INTERFACE_NAMES)[number];

/** Current version of each interface defined by this SDK. CutterDriver/2 is defined in `../cutter.ts`. */
export const INTERFACE_VERSIONS: Readonly<Record<InterfaceName, string>> = Object.freeze({
  RenderEngine: '1.0.0',
  ColorEngine: '1.0.0',
  Screener: '1.0.0',
  PrinterDriver: '1.0.0',
  CutterDriver: '2.0.0',
  Inspector: '1.0.0',
  Storage: '1.0.0',
});

export interface PeerInfo {
  name: string;
  version: string;
}

/** Plugin identity in `initialize` results. (The stub's `PluginInfo` is its serve-side config.) */
export interface BppPluginInfo extends PeerInfo {
  id: string;
}

/** Host side: "I can talk to this interface within this range". */
export interface InterfaceRequirement {
  interface: InterfaceName;
  versions: string;
}

/** Plugin side: "I implement this concrete interface version". */
export interface InterfaceOffer {
  interface: InterfaceName;
  version: string;
}

export type BandTransport = 'file' | 'shm';

export interface HostCapabilities {
  transports: BandTransport[];
  maxInFlightBands?: number;
}

export interface InitializeParams {
  protocol: string;
  host: PeerInfo;
  interfaces: InterfaceRequirement[];
  /** Host-owned spool directory the plugin may use (also its working directory). */
  spoolDir: string;
  capabilities: HostCapabilities;
}

export interface PluginCapabilities {
  transports?: BandTransport[];
  [key: string]: unknown;
}

export interface InitializeResult {
  protocol: string;
  plugin: BppPluginInfo;
  interfaces: InterfaceOffer[];
  /** Dynamic capabilities (ARCHITECTURE.md §3.5), merged over the manifest's static ones. */
  capabilities: PluginCapabilities;
}

export interface ConfigureParams {
  /** Plugin settings, including secrets resolved from the host secret store. Never logged. */
  settings: Record<string, unknown>;
}

export interface PingResult {
  time: number;
}

export interface CancelParams {
  id: JsonRpcId;
}

export interface ProgressParams {
  token: JsonRpcId;
  value: { percent?: number; message?: string };
}

export interface BandPlane {
  colorant: string;
  bitsPerSample: number;
  /** Bytes per row of this plane. */
  stride: number;
  /** Byte offset of this plane's first row within the band buffer. */
  offset: number;
}

export interface FileBandHandle {
  transport: 'file';
  /** Absolute path inside the host-owned spool directory. */
  path: string;
  sizeBytes: number;
}

/** Only the `file` transport exists in BPP v1.0; `shm` is negotiated by capability later. */
export type BandHandle = FileBandHandle;

/** A horizontal strip of planar raster (ARCHITECTURE.md §3.2, §7). */
export interface BandMessage {
  bandId: string;
  y0: number;
  height: number;
  width: number;
  planes: BandPlane[];
  handle: BandHandle;
}

export interface BandDataParams {
  /** Identifies the stream, e.g. a printer submission id. */
  streamId: string;
  /** Zero-based page index the band belongs to. */
  page: number;
  band: BandMessage;
  /** True for the final band of the stream. */
  last: boolean;
}

export interface BandReleaseParams {
  streamId: string;
  bandId: string;
  /** Set when the consumer could not use the band. */
  error?: string;
}
