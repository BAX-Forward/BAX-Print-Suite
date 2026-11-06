/**
 * Plugin interface contracts (ARCHITECTURE.md §3.3). Each interface is versioned independently and
 * maps to JSON-RPC methods under its own prefix. PrinterDriver/1 and Inspector/1 are used in M1;
 * RenderEngine, ColorEngine, Screener and Storage are type definitions only until their
 * milestones. CutterDriver/2 lives in `../cutter.ts` (spec 004).
 */
import type { BandDataParams, FileBandHandle } from './protocol.js';

// ---------------------------------------------------------------------------------------------
// PrinterDriver/1
// ---------------------------------------------------------------------------------------------

export const PrinterDriverMethods = Object.freeze({
  discover: 'printer/discover',
  getStatus: 'printer/getStatus',
  listMedia: 'printer/listMedia',
  submit: 'printer/submit',
  complete: 'printer/complete',
  cancel: 'printer/cancel',
  accounting: 'printer/accounting',
  /** Optional (spec 034a0): only drivers that advertise `documentFormats` answer it. */
  submitDocument: 'printer/submitDocument',
});

/** Notifications a PrinterDriver sends to the host. */
export const PrinterDriverNotifications = Object.freeze({
  submissionStatus: 'printer/submissionStatus',
  accountingRecord: 'printer/accountingRecord',
});

export interface PrinterCapabilities {
  input: 'bands' | 'document';
  colorants: string[];
  bitsPerSample: number[];
  resolutionsDpi: Array<[number, number]>;
  maxPrintWidthMm?: number;
  mediaHandling?: Array<'roll' | 'sheet'>;
  /**
   * Optional (spec 034a0). A non-empty array means the device accepts finished documents through
   * `printer/submitDocument`; absent or empty means band input only.
   */
  documentFormats?: PrinterDocumentFormat[];
  /** Optional per-device document size limit in bytes; the SDK caps it at `MAX_DOCUMENT_BYTES`. */
  maxDocumentBytes?: number;
  [key: string]: unknown;
}

/** Finished-document formats a driver may advertise in `documentFormats`. */
export const PRINTER_DOCUMENT_FORMATS = ['pdf', 'tiff'] as const;
export type PrinterDocumentFormat = (typeof PRINTER_DOCUMENT_FORMATS)[number];

/** Upper bound on a document handed to `printer/submitDocument` (1 GiB). */
export const MAX_DOCUMENT_BYTES = 1024 * 1024 * 1024;

/** Values of `error.data.code` when `printer/submitDocument` is refused with InvalidParams. */
export const DocumentErrorCodes = Object.freeze({
  tooLarge: 'DOCUMENT_TOO_LARGE',
  mismatch: 'DOCUMENT_MISMATCH',
  formatNotAccepted: 'FORMAT_NOT_ACCEPTED',
});

export interface DiscoveredPrinter {
  deviceId: string;
  name: string;
  capabilities: PrinterCapabilities;
}

export interface DiscoverResult {
  devices: DiscoveredPrinter[];
}

export type PrinterState = 'idle' | 'receiving' | 'printing' | 'error' | 'offline';

export interface PrinterStatus {
  deviceId: string;
  state: PrinterState;
  message?: string;
  activeSubmissionId?: string;
}

export interface DeviceParams {
  deviceId: string;
}

export interface MediaInfo {
  id: string;
  name: string;
  type?: string;
  widthMm?: number;
  form?: 'roll' | 'sheet';
}

export interface ListMediaResult {
  media: MediaInfo[];
}

export interface SubmitParams {
  deviceId: string;
  jobId: string;
  /** Unique per attempt; also the band stream id. */
  submissionId: string;
  pageCount: number;
  totalBands: number;
  resolutionDpi: [number, number];
}

export interface SubmitResult {
  accepted: boolean;
  reason?: string;
}

/**
 * `printer/submitDocument` params (spec 034a0). The document travels like a band: a `file` handle
 * into the host spool, never bytes in JSON. `byteLength` and `sha256` must match the file.
 */
export interface SubmitDocumentParams {
  deviceId: string;
  jobId: string;
  submissionId: string;
  format: PrinterDocumentFormat;
  byteLength: number;
  /** Lowercase or uppercase hex SHA-256 of the file. */
  sha256: string;
  document: FileBandHandle;
  /** 1-999; the driver's default when absent. */
  copies?: number;
  mediaName?: string;
}

export interface SubmitDocumentResult {
  submissionId: string;
}

export interface SubmissionParams {
  submissionId: string;
}

export type SubmissionState = 'receiving' | 'printing' | 'printed' | 'failed' | 'cancelled';

export interface CompleteResult {
  submissionId: string;
  state: SubmissionState;
  bandsReceived: number;
  bytesReceived: number;
  /** Optional plugin-written artifact (e.g. a job summary) inside the spool. */
  outputPath?: string;
}

export interface SubmissionStatusNotification {
  deviceId: string;
  jobId: string;
  submissionId: string;
  state: SubmissionState;
  message?: string;
}

export interface AccountingRecord {
  deviceId: string;
  jobId?: string;
  submissionId?: string;
  mediaAreaM2?: number;
  /** Ink use per colorant, as reported by the driver. */
  inkMl?: Record<string, number>;
  [key: string]: unknown;
}

export interface AccountingResult {
  records: AccountingRecord[];
}

/** Implementation shape of a PrinterDriver/1 plugin. Bands arrive as `band/data` notifications. */
export interface PrinterDriverV1 {
  discover(): Promise<DiscoverResult>;
  getStatus(params: DeviceParams): Promise<PrinterStatus>;
  listMedia(params: DeviceParams): Promise<ListMediaResult>;
  submit(params: SubmitParams): Promise<SubmitResult>;
  onBand(params: BandDataParams): Promise<void>;
  complete(params: SubmissionParams): Promise<CompleteResult>;
  cancel(params: SubmissionParams): Promise<void>;
  accounting(params: DeviceParams): Promise<AccountingResult>;
  /**
   * Optional (spec 034a0). Receives a finished document already read from the spool and checked
   * against `byteLength` and `sha256`. Status and cancel go through `getStatus` and `cancel`.
   */
  submitDocument?(params: SubmitDocumentParams, bytes: Uint8Array): Promise<SubmitDocumentResult>;
}

// ---------------------------------------------------------------------------------------------
// Inspector/1
// ---------------------------------------------------------------------------------------------

export const InspectorMethods = Object.freeze({
  inspect: 'inspector/inspect',
  fixup: 'inspector/fixup',
});

export interface DocumentRef {
  path: string;
  mediaType?: string;
}

export interface InspectParams {
  document: DocumentRef;
}

export interface PreflightPage {
  index: number;
  widthPt: number;
  heightPt: number;
  trimBox?: { x: number; y: number; width: number; height: number };
}

export interface PreflightIssue {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  page?: number;
}

export interface PreflightReport {
  pageCount: number;
  pages: PreflightPage[];
  pdfVersion?: string;
  issues: PreflightIssue[];
}

export interface InspectorV1 {
  inspect(params: InspectParams): Promise<PreflightReport>;
  fixup?(params: InspectParams & { fixups: string[] }): Promise<DocumentRef>;
}

// ---------------------------------------------------------------------------------------------
// Storage/1
// ---------------------------------------------------------------------------------------------

export const StorageMethods = Object.freeze({
  put: 'storage/put',
  get: 'storage/get',
  stat: 'storage/stat',
  delete: 'storage/delete',
  list: 'storage/list',
});

export interface StoredBlobInfo {
  key: string;
  sizeBytes: number;
  modifiedAt: string;
  path?: string;
}

export interface StorageV1 {
  put(params: { key: string; sourcePath: string }): Promise<StoredBlobInfo>;
  get(params: { key: string }): Promise<{ path: string }>;
  stat(params: { key: string }): Promise<StoredBlobInfo | null>;
  delete(params: { key: string }): Promise<void>;
  list(params: { prefix: string }): Promise<{ keys: string[] }>;
}

// ---------------------------------------------------------------------------------------------
// RenderEngine/1 (types only in M1)
// ---------------------------------------------------------------------------------------------

export const RenderEngineMethods = Object.freeze({
  probe: 'render/probe',
  render: 'render/render',
});

export interface RenderOptions {
  dpi: [number, number];
  region?: { x: number; y: number; width: number; height: number };
  colorants: string[];
  outputProfile?: string;
  bitsPerSample: number;
  overprintSimulation: boolean;
  /** Stream id for the resulting `band/data` notifications. */
  streamId: string;
}

export interface ProbeResult {
  pageCount: number;
  engine: { name: string; version: string };
}

export interface RenderEngineV1 {
  probe(params: { document: DocumentRef }): Promise<ProbeResult>;
  render(params: { document: DocumentRef; page: number; options: RenderOptions }): Promise<{
    bands: number;
  }>;
}

// ---------------------------------------------------------------------------------------------
// ColorEngine/1 (types only in M1)
// ---------------------------------------------------------------------------------------------

export const ColorEngineMethods = Object.freeze({
  createTransform: 'color/createTransform',
  apply: 'color/apply',
  inkLimit: 'color/inkLimit',
  linearize: 'color/linearize',
});

export type RenderingIntent = 'perceptual' | 'relative' | 'saturation' | 'absolute';

export interface ColorEngineV1 {
  createTransform(params: {
    source: string;
    destination: string;
    intent: RenderingIntent;
    blackPointCompensation?: boolean;
  }): Promise<{ transformId: string }>;
  apply(params: { transformId: string; inputStreamId: string; outputStreamId: string }): Promise<void>;
  inkLimit(params: { streamId: string; totalPercent: number }): Promise<void>;
  linearize(params: { streamId: string; curves: Record<string, number[]> }): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Screener/1 (types only in M1)
// ---------------------------------------------------------------------------------------------

export const ScreenerMethods = Object.freeze({
  listMethods: 'screen/listMethods',
  screen: 'screen/screen',
});

export interface ScreeningMethod {
  id: string;
  name: string;
  levels: number[];
}

export interface ScreenerV1 {
  listMethods(): Promise<{ methods: ScreeningMethod[] }>;
  screen(params: {
    inputStreamId: string;
    outputStreamId: string;
    method: string;
    levels: number;
    seed?: number;
  }): Promise<void>;
}
