import {
  ErrorCodes,
  MAX_DOCUMENT_BYTES,
  RpcError,
  type AccountingResult,
  type BandDataParams,
  type CompleteResult,
  type DeviceParams,
  type DiscoverResult,
  type ListMediaResult,
  type PrinterCapabilities,
  type PrinterDriverV1,
  type PrinterStatus,
  type SdkLogger,
  type SubmissionParams,
  type SubmitDocumentParams,
  type SubmitDocumentResult,
  type SubmitParams,
  type SubmitResult,
} from '@bax-print/plugin-sdk';
import { directoryProblems, parseFolderConfig, type DocumentFormat } from './config.js';
import { FolderOutputError } from './errors.js';
import {
  FolderOutput,
  type DocumentSubmission,
  type FolderJobStatus,
  type FolderSubmitResult,
} from './folder-output.js';

export { DEFAULT_DEVICE_NAME, DOCUMENT_FORMATS, parseFolderConfig } from './config.js';
export type { DocumentFormat, FolderOutputConfig } from './config.js';
export { FolderOutputError } from './errors.js';
export type { FolderErrorCode } from './errors.js';
export { PART_SUFFIX, TICKET_SUFFIX, TICKET_VERSION, checkJobId } from './folder-output.js';
export type {
  BpsTicket,
  DocumentSubmission,
  FolderJobState,
  FolderJobStatus,
  FolderSubmitResult,
  TicketMediaInput,
} from './folder-output.js';

export const FOLDER_DEVICE_ID = 'folder-output';

/** Largest document accepted over `printer/submitDocument`: the SDK limit, nothing tighter. */
export const FOLDER_MAX_DOCUMENT_BYTES = MAX_DOCUMENT_BYTES;

/** Why PrinterDriver/1 band submissions are declined. */
export const BAND_INPUT_UNSUPPORTED =
  'folder output accepts finished documents only; raster band submissions are not supported';

/** The plugin-side services the driver needs (a PluginServer satisfies this). */
export interface DriverHost {
  readonly log: SdkLogger;
}

export interface FolderDriverOptions {
  /** Clock for ticket timestamps; tests pin it. */
  now?: () => Date;
}

export interface FolderDescription {
  deviceId: string;
  name: string;
  transport: 'file-drop';
  outputDir: string;
  acceptedFormats: DocumentFormat[];
  writesTicket: boolean;
  capabilities: PrinterCapabilities;
}

/**
 * Deliberately minimal: finished documents in, no colorants, resolutions or media handling of its
 * own. Whatever consumes the folder decides how the output is printed.
 */
function folderCapabilities(formats: readonly DocumentFormat[]): PrinterCapabilities {
  return {
    input: 'document',
    colorants: [],
    bitsPerSample: [],
    resolutionsDpi: [],
    documentFormats: [...formats],
    maxDocumentBytes: FOLDER_MAX_DOCUMENT_BYTES,
  };
}

/**
 * Generic file-drop PrinterDriver/1. It speaks no device protocol: it writes each finished
 * document (and an optional BPS ticket) atomically into a configured folder and reports a job as
 * done once something outside BPS has taken the file away.
 */
export class FolderPrinterDriver implements PrinterDriverV1 {
  private output: FolderOutput | undefined;
  private readonly now: () => Date;
  /** `printer/submitDocument` submission id -> folder job id, for `printer/cancel`. */
  private readonly documentJobs = new Map<string, string>();

  constructor(
    private readonly host: DriverHost,
    options: FolderDriverOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  /** Validates and applies settings; throws CONFIG_INVALID listing every problem. */
  configure(settings: Record<string, unknown>): void {
    const config = parseFolderConfig(settings);
    this.output = new FolderOutput(config, this.now);
    this.host.log.info('folder output configured', { outputDir: config.outputDir });
  }

  describe(): FolderDescription {
    const { config } = this.requireOutput();
    return {
      deviceId: FOLDER_DEVICE_ID,
      name: config.deviceName,
      transport: 'file-drop',
      outputDir: config.outputDir,
      acceptedFormats: [...config.acceptedFormats],
      writesTicket: config.writeTicket,
      capabilities: folderCapabilities(config.acceptedFormats),
    };
  }

  /** Writes a finished document into the folder. */
  submitDocument(submission: DocumentSubmission): Promise<FolderSubmitResult>;
  /**
   * PrinterDriver/1 `printer/submitDocument` (spec 034a0). The SDK has already read the document
   * from the spool and checked its size and sha256; the folder job id is the BPP `jobId`.
   */
  submitDocument(params: SubmitDocumentParams, bytes: Uint8Array): Promise<SubmitDocumentResult>;
  async submitDocument(
    request: DocumentSubmission | SubmitDocumentParams,
    bytes?: Uint8Array,
  ): Promise<FolderSubmitResult | SubmitDocumentResult> {
    if ('data' in request) return this.writeDocument(request);
    this.requireDevice(request.deviceId);
    if (bytes === undefined) {
      throw new RpcError(ErrorCodes.InvalidParams, 'document bytes are required');
    }
    if (this.documentJobs.has(request.submissionId)) {
      throw new RpcError(ErrorCodes.InvalidParams, `duplicate submission ${request.submissionId}`);
    }
    await this.writeDocument({
      jobId: request.jobId,
      format: request.format,
      data: bytes,
      ...(request.copies !== undefined ? { copies: request.copies } : {}),
      ...(request.mediaName !== undefined ? { media: { name: request.mediaName } } : {}),
    });
    this.documentJobs.set(request.submissionId, request.jobId);
    return { submissionId: request.submissionId };
  }

  async getJobStatus(jobId: string): Promise<FolderJobStatus> {
    return this.requireOutput().status(jobId);
  }

  async cancelJob(jobId: string): Promise<FolderJobStatus> {
    return this.requireOutput().cancel(jobId);
  }

  // PrinterDriver/1 -----------------------------------------------------------------------------

  async discover(): Promise<DiscoverResult> {
    if (this.output === undefined) return { devices: [] };
    const { deviceId, name, capabilities } = this.describe();
    return { devices: [{ deviceId, name, capabilities }] };
  }

  async getStatus(params: DeviceParams): Promise<PrinterStatus> {
    this.requireDevice(params.deviceId);
    if (this.output === undefined) {
      return { deviceId: params.deviceId, state: 'offline', message: 'not configured' };
    }
    const problems = directoryProblems(this.output.config.outputDir);
    if (problems.length > 0) {
      return { deviceId: params.deviceId, state: 'offline', message: problems.join('; ') };
    }
    const queued = await this.output.queuedJobIds();
    return queued.length > 0
      ? { deviceId: params.deviceId, state: 'idle', message: `${queued.length} file(s) waiting in the output folder` }
      : { deviceId: params.deviceId, state: 'idle' };
  }

  /** No media of its own: the folder consumer owns media, so the list is empty. */
  async listMedia(params: DeviceParams): Promise<ListMediaResult> {
    this.requireDevice(params.deviceId);
    return { media: [] };
  }

  async submit(params: SubmitParams): Promise<SubmitResult> {
    this.requireDevice(params.deviceId);
    return { accepted: false, reason: BAND_INPUT_UNSUPPORTED };
  }

  async onBand(params: BandDataParams): Promise<void> {
    throw new RpcError(ErrorCodes.InvalidRequest, `${BAND_INPUT_UNSUPPORTED} (stream ${params.streamId})`);
  }

  async complete(params: SubmissionParams): Promise<CompleteResult> {
    throw new RpcError(ErrorCodes.InvalidParams, `unknown submission ${params.submissionId}`);
  }

  /** Cancels a document submitted over `printer/submitDocument`; there are no band submissions. */
  async cancel(params: SubmissionParams): Promise<void> {
    const jobId = this.documentJobs.get(params.submissionId);
    if (jobId === undefined) {
      throw new RpcError(ErrorCodes.InvalidParams, `unknown submission ${params.submissionId}`);
    }
    await this.cancelJob(jobId);
  }

  /** Nothing is measured here, so there is nothing to account. */
  async accounting(params: DeviceParams): Promise<AccountingResult> {
    this.requireDevice(params.deviceId);
    return { records: [] };
  }

  private async writeDocument(submission: DocumentSubmission): Promise<FolderSubmitResult> {
    const result = await this.requireOutput().submit(submission);
    this.host.log.info('output written', { jobId: result.jobId, path: result.outputPath });
    return result;
  }

  private requireOutput(): FolderOutput {
    if (this.output === undefined) {
      throw new FolderOutputError('NOT_CONFIGURED', 'folder output is not configured; set outputDir first');
    }
    return this.output;
  }

  private requireDevice(deviceId: string): void {
    if (deviceId === FOLDER_DEVICE_ID) return;
    throw new RpcError(ErrorCodes.InvalidParams, `unknown device ${deviceId}`);
  }
}
