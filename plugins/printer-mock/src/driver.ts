import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ErrorCodes,
  PrinterDriverNotifications,
  RpcError,
  readFileBand,
  type AccountingRecord,
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
  type SubmissionState,
  type SubmissionStatusNotification,
  type SubmitParams,
  type SubmitResult,
} from '@bax-print/plugin-sdk';

export const MOCK_DEVICE_ID = 'mock-printer-1';

export const MOCK_CAPABILITIES: PrinterCapabilities = Object.freeze({
  input: 'bands',
  colorants: ['C', 'M', 'Y', 'K'],
  bitsPerSample: [8],
  resolutionsDpi: [
    [18, 18],
    [72, 72],
    [300, 300],
  ],
  maxPrintWidthMm: 1600,
  mediaHandling: ['roll', 'sheet'],
}) as PrinterCapabilities;

/** Settings accepted through `configure`. */
export interface MockDriverSettings {
  /** Artificial delay per band, so tests can interrupt a submission mid-stream. */
  bandDelayMs: number;
  /** Folder (inside the spool) that receives submission summaries. */
  summaryDir: string;
}

export const DEFAULT_MOCK_SETTINGS: Readonly<MockDriverSettings> = Object.freeze({
  bandDelayMs: 0,
  summaryDir: 'printer-mock',
});

/** The plugin-side services the driver needs (a PluginServer satisfies this). */
export interface DriverHost {
  readonly spoolDir: string;
  readonly log: SdkLogger;
  notify(method: string, params?: unknown): boolean;
}

interface BandRecord {
  bandId: string;
  page: number;
  y0: number;
  height: number;
  width: number;
  colorants: string[];
  sizeBytes: number;
  /** Count of non-zero bytes: a cheap "ink coverage" figure for the summary. */
  inkedBytes: number;
}

interface Submission {
  params: SubmitParams;
  state: SubmissionState;
  bands: BandRecord[];
  bytesReceived: number;
  receivedLast: boolean;
  startedAt: string;
}

/** Media area per band at the submission resolution, in square metres. */
function bandAreaM2(band: BandRecord, dpi: [number, number]): number {
  const metresPerInch = 0.0254;
  return ((band.width / dpi[0]) * metresPerInch) * ((band.height / dpi[1]) * metresPerInch);
}

function countInked(data: Buffer): number {
  let inked = 0;
  for (const byte of data) {
    if (byte !== 0) inked++;
  }
  return inked;
}

function settingNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function settingString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/**
 * Mock PrinterDriver/1. It prints nothing: it reads every band from its `file` handle, keeps
 * per-submission totals, writes a summary JSON into the spool on `complete`, and reports status
 * and accounting like a real driver would.
 */
export class MockPrinterDriver implements PrinterDriverV1 {
  private readonly submissions = new Map<string, Submission>();
  private readonly records: AccountingRecord[] = [];
  private settings: MockDriverSettings = { ...DEFAULT_MOCK_SETTINGS };

  constructor(private readonly host: DriverHost) {}

  configure(settings: Record<string, unknown>): void {
    this.settings = {
      bandDelayMs: settingNumber(settings.bandDelayMs, DEFAULT_MOCK_SETTINGS.bandDelayMs),
      summaryDir: settingString(settings.summaryDir, DEFAULT_MOCK_SETTINGS.summaryDir),
    };
  }

  async discover(): Promise<DiscoverResult> {
    return {
      devices: [{ deviceId: MOCK_DEVICE_ID, name: 'Mock printer', capabilities: { ...MOCK_CAPABILITIES } }],
    };
  }

  async getStatus(params: DeviceParams): Promise<PrinterStatus> {
    this.requireDevice(params.deviceId);
    const active = [...this.submissions.entries()].find(
      ([, submission]) => submission.state === 'receiving' || submission.state === 'printing',
    );
    if (!active) {
      return { deviceId: params.deviceId, state: 'idle' };
    }
    const [submissionId, submission] = active;
    return {
      deviceId: params.deviceId,
      state: submission.state === 'receiving' ? 'receiving' : 'printing',
      activeSubmissionId: submissionId,
    };
  }

  async listMedia(params: DeviceParams): Promise<ListMediaResult> {
    this.requireDevice(params.deviceId);
    return {
      media: [
        { id: 'mock-roll-1600', name: 'Mock roll 1600 mm', type: 'paper', widthMm: 1600, form: 'roll' },
        { id: 'mock-sheet-a3', name: 'Mock sheet A3', type: 'paper', widthMm: 297, form: 'sheet' },
      ],
    };
  }

  async submit(params: SubmitParams): Promise<SubmitResult> {
    this.requireDevice(params.deviceId);
    if (this.submissions.has(params.submissionId)) {
      return { accepted: false, reason: `submission ${params.submissionId} already exists` };
    }
    if (!Number.isInteger(params.totalBands) || params.totalBands < 1) {
      return { accepted: false, reason: 'totalBands must be a positive integer' };
    }
    this.submissions.set(params.submissionId, {
      params: { ...params, resolutionDpi: params.resolutionDpi ?? [72, 72] },
      state: 'receiving',
      bands: [],
      bytesReceived: 0,
      receivedLast: false,
      startedAt: new Date().toISOString(),
    });
    this.emitStatus(params.submissionId, 'receiving');
    return { accepted: true };
  }

  async onBand(params: BandDataParams): Promise<void> {
    const submission = this.submissions.get(params.streamId);
    if (!submission) {
      throw new RpcError(ErrorCodes.InvalidParams, `unknown submission ${params.streamId}`);
    }
    if (submission.state !== 'receiving') {
      throw new RpcError(ErrorCodes.InvalidRequest, `submission ${params.streamId} is ${submission.state}`);
    }
    const data = await readFileBand(params.band.handle, this.host.spoolDir);
    if (this.settings.bandDelayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, this.settings.bandDelayMs));
    }
    submission.bands.push({
      bandId: params.band.bandId,
      page: params.page,
      y0: params.band.y0,
      height: params.band.height,
      width: params.band.width,
      colorants: params.band.planes.map((plane) => plane.colorant),
      sizeBytes: data.byteLength,
      inkedBytes: countInked(data),
    });
    submission.bytesReceived += data.byteLength;
    submission.receivedLast ||= params.last;
  }

  async complete(params: SubmissionParams): Promise<CompleteResult> {
    const submission = this.requireSubmission(params.submissionId);
    if (submission.state !== 'receiving') {
      throw new RpcError(ErrorCodes.InvalidRequest, `submission ${params.submissionId} is ${submission.state}`);
    }
    const expected = submission.params.totalBands;
    if (submission.bands.length !== expected) {
      submission.state = 'failed';
      this.emitStatus(params.submissionId, 'failed', `expected ${expected} bands, received ${submission.bands.length}`);
      throw new RpcError(
        ErrorCodes.RequestFailed,
        `expected ${expected} bands, received ${submission.bands.length}`,
      );
    }
    submission.state = 'printing';
    this.emitStatus(params.submissionId, 'printing');
    const outputPath = await this.writeSummary(params.submissionId, submission);
    submission.state = 'printed';
    this.emitStatus(params.submissionId, 'printed');
    this.recordAccounting(params.submissionId, submission);
    return {
      submissionId: params.submissionId,
      state: 'printed',
      bandsReceived: submission.bands.length,
      bytesReceived: submission.bytesReceived,
      outputPath,
    };
  }

  async cancel(params: SubmissionParams): Promise<void> {
    const submission = this.requireSubmission(params.submissionId);
    if (submission.state === 'receiving' || submission.state === 'printing') {
      submission.state = 'cancelled';
      this.emitStatus(params.submissionId, 'cancelled');
    }
  }

  async accounting(params: DeviceParams): Promise<AccountingResult> {
    this.requireDevice(params.deviceId);
    return { records: this.records.filter((record) => record.deviceId === params.deviceId) };
  }

  private requireDevice(deviceId: string): void {
    if (deviceId !== MOCK_DEVICE_ID) {
      throw new RpcError(ErrorCodes.InvalidParams, `unknown device ${deviceId}`);
    }
  }

  private requireSubmission(submissionId: string): Submission {
    const submission = this.submissions.get(submissionId);
    if (!submission) {
      throw new RpcError(ErrorCodes.InvalidParams, `unknown submission ${submissionId}`);
    }
    return submission;
  }

  private emitStatus(submissionId: string, state: SubmissionState, message?: string): void {
    const submission = this.submissions.get(submissionId);
    if (!submission) return;
    const notification: SubmissionStatusNotification = {
      deviceId: submission.params.deviceId,
      jobId: submission.params.jobId,
      submissionId,
      state,
      ...(message !== undefined ? { message } : {}),
    };
    this.host.notify(PrinterDriverNotifications.submissionStatus, notification);
  }

  private recordAccounting(submissionId: string, submission: Submission): void {
    const dpi = submission.params.resolutionDpi;
    const mediaAreaM2 = submission.bands.reduce((sum, band) => sum + bandAreaM2(band, dpi), 0);
    const record: AccountingRecord = {
      deviceId: submission.params.deviceId,
      jobId: submission.params.jobId,
      submissionId,
      mediaAreaM2: Math.round(mediaAreaM2 * 1e6) / 1e6,
      inkMl: {},
    };
    this.records.push(record);
    this.host.notify(PrinterDriverNotifications.accountingRecord, record);
  }

  private async writeSummary(submissionId: string, submission: Submission): Promise<string> {
    const dir = join(this.host.spoolDir, this.settings.summaryDir);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${submissionId}.json`);
    const pages = [...new Set(submission.bands.map((band) => band.page))].sort((a, b) => a - b);
    const summary = {
      submissionId,
      jobId: submission.params.jobId,
      deviceId: submission.params.deviceId,
      pageCount: submission.params.pageCount,
      pagesReceived: pages,
      resolutionDpi: submission.params.resolutionDpi,
      bandsReceived: submission.bands.length,
      bytesReceived: submission.bytesReceived,
      receivedLast: submission.receivedLast,
      startedAt: submission.startedAt,
      completedAt: new Date().toISOString(),
      bands: submission.bands,
    };
    await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    this.host.log.info('submission summary written', { submissionId, path });
    return path;
  }
}
