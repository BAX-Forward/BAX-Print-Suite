import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Job } from '@bax-print/core';
import {
  acceptsDocuments,
  BPP_PROTOCOL,
  BppClient,
  documentByteLimit,
  ErrorCodes,
  LifecycleMethods,
  PRINTER_DOCUMENT_FORMATS,
  PRINTER_DRIVER_INTERFACE,
  PrinterDriverMethods,
  readManifest,
  RpcError,
  writeFileBand,
  type FileBandHandle,
  type PrinterCapabilities,
  type PrinterDocumentFormat,
} from '@bax-print/plugin-sdk';

/** Spec 034a: the formats a job's source may be sent to the printer plugin in. */
export type PrintFormat = 'pdf';

export interface PrintSubmission {
  readonly outputJobId: string;
}

/** An output job as the printer plugin reports it; `state` is the plugin's word for it. */
export interface PrintOutputStatus {
  readonly outputJobId: string;
  readonly state: string;
  readonly message?: string;
}

/**
 * Spec 034a: where a job's finished document is sent. The server holds at most one; tests inject
 * a fake. Every failure the plugin reports is a `PrintOutputError` carrying the plugin's code.
 */
export interface PrintOutput {
  submit(job: Job, bytes: Uint8Array, format: PrintFormat, options?: PrintOptions): Promise<PrintSubmission>;
  status(outputJobId: string): Promise<PrintOutputStatus>;
  cancel(outputJobId: string): Promise<PrintOutputStatus>;
  /** Stops the plugin, if it was started. */
  close(): Promise<void>;
}

/** A printer plugin failure; `code` is uppercase, e.g. the plugin's own `OUTPUT_EXISTS`. */
export class PrintOutputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PrintOutputError';
    this.code = code;
  }
}

export const PRINT_OUTPUT_ENV = 'BPS_PRINT_OUTPUT';
export const PRINTER_PLUGIN_ENV = 'BPS_PRINTER_PLUGIN';
export const PRINTER_SETTINGS_ENV = 'BPS_PRINTER_SETTINGS';

export interface PrintOutputConfig {
  /** Absolute path of the plugin's `bps-plugin.json`. */
  readonly manifestPath: string;
  /** The plugin settings from `BPS_PRINTER_SETTINGS`; never logged. */
  readonly settings: Readonly<Record<string, unknown>>;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function parseSettings(raw: string | undefined): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's message quotes the input, which may hold secrets.
    throw new Error(`${PRINTER_SETTINGS_ENV} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${PRINTER_SETTINGS_ENV} must be a JSON object`);
  }
  return Object.freeze({ ...parsed });
}

/** Spec 034a: `true` only for `BPS_PRINT_OUTPUT=1`; unset is off and any other value stops startup. */
export function parsePrintOutputFlag(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[PRINT_OUTPUT_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${PRINT_OUTPUT_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

/**
 * Spec 034a: print output is opt-in. Without `BPS_PRINT_OUTPUT=1` it is off and neither
 * `BPS_PRINTER_PLUGIN` nor `BPS_PRINTER_SETTINGS` is read. With it, `BPS_PRINTER_PLUGIN` must be
 * the absolute path of an existing `bps-plugin.json`; a missing or relative path, a missing file
 * or a `BPS_PRINTER_SETTINGS` that is not a JSON object stops startup.
 */
export function parsePrintOutputConfig(env: NodeJS.ProcessEnv): PrintOutputConfig | undefined {
  if (!parsePrintOutputFlag(env)) return undefined;
  const manifestPath = env[PRINTER_PLUGIN_ENV];
  if (manifestPath === undefined || manifestPath === '') {
    throw new Error(`${PRINT_OUTPUT_ENV}=1 needs ${PRINTER_PLUGIN_ENV}, the absolute path to a bps-plugin.json`);
  }
  if (!isAbsolute(manifestPath)) throw new Error(`${PRINTER_PLUGIN_ENV} must be an absolute path to a bps-plugin.json`);
  if (!isFile(manifestPath)) throw new Error(`${PRINTER_PLUGIN_ENV} ${manifestPath} is not a file`);
  return { manifestPath, settings: parseSettings(env[PRINTER_SETTINGS_ENV]) };
}

const UPPERCASE_CODE = /^[A-Z][A-Z0-9_]*$/;

/** The plugin's uppercase code from a BPP error's `data.code`, else `fallback`. */
function pluginErrorCode(error: unknown, fallback: string): string {
  if (error instanceof RpcError && typeof error.data === 'object' && error.data !== null && 'code' in error.data) {
    const { code } = error.data;
    if (typeof code === 'string' && UPPERCASE_CODE.test(code)) return code;
  }
  return fallback;
}

/** The BPP requests `BppPrintOutput` makes; the SDK's `BppClient` satisfies it. */
export interface PrinterPluginClient {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** A spawned plugin that has not been sent `initialize` yet. */
export interface LaunchedPrinterPlugin {
  readonly client: PrinterPluginClient;
  readonly manifest: { readonly provides: readonly { readonly interface: string }[] };
}

export interface BppPrintOutputOptions extends PrintOutputConfig {
  /** Host-owned spool directory the documents are written to; created on first use. */
  readonly spoolDir: string;
  /** Spawns the plugin without initializing it; defaults to `spawnPrinterPlugin`. */
  readonly launch?: (manifestPath: string) => Promise<LaunchedPrinterPlugin>;
  /** The plugin's stderr lines, e.g. to the server log. */
  readonly onStderrLine?: (line: string) => void;
}

/**
 * Spawns the plugin of a `bps-plugin.json` (cwd = its directory) with the SDK's `BppClient`. The
 * SDK's `launchPlugin` sends a bare `initialize` without a spool directory, so `BppPrintOutput`
 * sends the full one itself.
 */
export async function spawnPrinterPlugin(
  manifestPath: string,
  onStderrLine?: (line: string) => void,
): Promise<LaunchedPrinterPlugin> {
  const absolute = resolve(manifestPath);
  const manifest = await readManifest(absolute);
  if (manifest.protocol !== BPP_PROTOCOL) throw new Error(`unsupported protocol ${manifest.protocol}`);
  const client = BppClient.spawn(manifest.exec.command, manifest.exec.args ?? [], {
    cwd: dirname(absolute),
    ...(onStderrLine ? { onStderrLine } : {}),
  });
  return { client, manifest };
}

/** The device documents are sent to: the first one `printer/discover` reports. */
interface PrinterDevice {
  readonly deviceId: string;
  readonly capabilities: PrinterCapabilities;
}

interface StartedPlugin {
  readonly client: PrinterPluginClient;
  readonly device: PrinterDevice;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function documentFormat(value: unknown): PrinterDocumentFormat | undefined {
  return PRINTER_DOCUMENT_FORMATS.find((format) => format === value);
}

/** The capabilities the document checks read; unknown document formats are dropped. */
function documentCapabilities(raw: Record<string, unknown>): PrinterCapabilities {
  const { documentFormats, maxDocumentBytes } = raw;
  return {
    input: raw.input === 'document' ? 'document' : 'bands',
    colorants: [],
    bitsPerSample: [],
    resolutionsDpi: [],
    ...(Array.isArray(documentFormats)
      ? { documentFormats: documentFormats.flatMap((value: unknown) => documentFormat(value) ?? []) }
      : {}),
    ...(typeof maxDocumentBytes === 'number' ? { maxDocumentBytes } : {}),
  };
}

function firstDevice(result: unknown): PrinterDevice | undefined {
  if (!isRecord(result) || !Array.isArray(result.devices)) return undefined;
  const [device]: unknown[] = result.devices;
  if (!isRecord(device) || typeof device.deviceId !== 'string' || device.deviceId === '') return undefined;
  if (!isRecord(device.capabilities)) return undefined;
  return { deviceId: device.deviceId, capabilities: documentCapabilities(device.capabilities) };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Optional `printer/submitDocument` fields; the driver's defaults apply when absent. */
export interface PrintOptions {
  readonly copies?: number;
  readonly mediaName?: string;
}

/**
 * Spec 034a: a `PrintOutput` over one PrinterDriver plugin, started on first `submit` and stopped
 * by `close`. Starting sends `initialize` with the spool directory, `configure` with the settings
 * and `printer/discover`, whose first device receives the documents.
 *
 * `submit` checks the device's capabilities with the SDK's `acceptsDocuments` and
 * `documentByteLimit` before it writes anything: a band-only device or one without the job's
 * format fails with `DOCUMENT_INPUT_UNSUPPORTED`, a document above the limit with
 * `DOCUMENT_TOO_LARGE`. Otherwise the document is written to a spool file, sent through
 * `printer/submitDocument` and the file is removed once the request settles. No bands are sent.
 * The submission id is the output job id; `status` and `cancel` go through `printer/getStatus` and
 * `printer/cancel`.
 */
export class BppPrintOutput implements PrintOutput {
  private launched: Promise<StartedPlugin> | undefined;
  private closed = false;
  /** Submission id -> device id of every document this server submitted. */
  private readonly submissions = new Map<string, string>();

  constructor(private readonly options: BppPrintOutputOptions) {}

  async submit(job: Job, bytes: Uint8Array, format: PrintFormat, print: PrintOptions = {}): Promise<PrintSubmission> {
    const { client, device } = await this.plugin();
    checkDocument(device.capabilities, bytes, format);
    const submissionId = randomUUID();
    const document = await this.spool(`${submissionId}.${format}`, bytes);
    try {
      const result = await client
        .request(PrinterDriverMethods.submitDocument, {
          deviceId: device.deviceId,
          jobId: job.id,
          submissionId,
          format,
          byteLength: bytes.byteLength,
          sha256: sha256Hex(bytes),
          document,
          ...(print.copies !== undefined ? { copies: print.copies } : {}),
          ...(print.mediaName !== undefined ? { mediaName: print.mediaName } : {}),
        })
        .catch((error: unknown) => {
          throw new PrintOutputError(submitErrorCode(error), 'the printer plugin refused the document');
        });
      if (!isRecord(result) || result.submissionId !== submissionId) {
        throw new PrintOutputError('INVALID_PLUGIN_RESPONSE', 'the printer plugin answered with another submission');
      }
    } finally {
      await rm(document.path, { force: true });
    }
    this.submissions.set(submissionId, device.deviceId);
    return { outputJobId: submissionId };
  }

  async status(outputJobId: string): Promise<PrintOutputStatus> {
    const deviceId = this.submissions.get(outputJobId);
    if (deviceId === undefined) throw unknownOutputJob(outputJobId);
    return this.deviceStatus(outputJobId, deviceId);
  }

  async cancel(outputJobId: string): Promise<PrintOutputStatus> {
    const deviceId = this.submissions.get(outputJobId);
    if (deviceId === undefined) throw unknownOutputJob(outputJobId);
    const { client } = await this.plugin();
    await viaRequest(() => client.request(PrinterDriverMethods.cancel, { submissionId: outputJobId }), 'CANCEL_FAILED');
    return this.deviceStatus(outputJobId, deviceId);
  }

  async close(): Promise<void> {
    this.closed = true;
    const launched = this.launched;
    this.launched = undefined;
    if (launched === undefined) return;
    try {
      await (await launched).client.close();
    } catch {
      // It never started, so there is nothing to stop.
    }
  }

  private async deviceStatus(outputJobId: string, deviceId: string): Promise<PrintOutputStatus> {
    const { client } = await this.plugin();
    const status = await viaRequest(
      () => client.request(PrinterDriverMethods.getStatus, { deviceId, submissionId: outputJobId }),
      'STATUS_FAILED',
    );
    if (!isRecord(status) || typeof status.state !== 'string') {
      throw new PrintOutputError('INVALID_PLUGIN_RESPONSE', 'the printer plugin answered without a state');
    }
    return {
      outputJobId,
      state: status.state,
      ...(typeof status.message === 'string' ? { message: status.message } : {}),
    };
  }

  /** Writes the document into the spool the SDK way, as a `file` handle. */
  private async spool(name: string, bytes: Uint8Array): Promise<FileBandHandle> {
    try {
      return await writeFileBand(this.options.spoolDir, name, bytes);
    } catch {
      throw new PrintOutputError('SPOOL_UNAVAILABLE', 'the document could not be written to the spool');
    }
  }

  private plugin(): Promise<StartedPlugin> {
    if (this.closed) return Promise.reject(new PrintOutputError('PLUGIN_CLOSED', 'the printer plugin was stopped'));
    if (this.launched === undefined) {
      const launched = this.start();
      this.launched = launched;
      // A failed start is retried on the next call.
      void launched.catch(() => {
        if (this.launched === launched) this.launched = undefined;
      });
    }
    return this.launched;
  }

  private async start(): Promise<StartedPlugin> {
    const { manifestPath, onStderrLine } = this.options;
    const launch = this.options.launch ?? ((path: string) => spawnPrinterPlugin(path, onStderrLine));
    let launched: LaunchedPrinterPlugin;
    try {
      launched = await launch(manifestPath);
    } catch (error) {
      throw new PrintOutputError(pluginErrorCode(error, 'PLUGIN_UNAVAILABLE'), 'the printer plugin could not be started');
    }
    const { client } = launched;
    try {
      if (!launched.manifest.provides.some((entry) => entry.interface === PRINTER_DRIVER_INTERFACE)) {
        throw new PrintOutputError('NOT_A_PRINTER_DRIVER', `the plugin does not provide ${PRINTER_DRIVER_INTERFACE}`);
      }
      return { client, device: await this.initialize(client) };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  /** `initialize`, `configure` (the settings are never logged) and `printer/discover`. */
  private async initialize(client: PrinterPluginClient): Promise<PrinterDevice> {
    const { spoolDir, settings } = this.options;
    try {
      await mkdir(spoolDir, { recursive: true });
    } catch {
      throw new PrintOutputError('SPOOL_UNAVAILABLE', 'the spool directory could not be created');
    }
    await viaRequest(
      () =>
        client.request(LifecycleMethods.initialize, {
          protocol: BPP_PROTOCOL,
          host: { name: 'bps-server', version: '0.1.0' },
          interfaces: [{ interface: PRINTER_DRIVER_INTERFACE, versions: PRINTER_DRIVER_VERSIONS }],
          spoolDir,
          capabilities: { transports: ['file'] },
        }),
      'PLUGIN_UNAVAILABLE',
    );
    await viaRequest(() => client.request(LifecycleMethods.configure, { settings }), 'PLUGIN_CONFIG_INVALID');
    const discovered = await viaRequest(() => client.request(PrinterDriverMethods.discover), 'DISCOVER_FAILED');
    const device = firstDevice(discovered);
    if (device === undefined) throw new PrintOutputError('NO_PRINTER_DEVICE', 'the printer plugin reports no device');
    return device;
  }
}

/** The PrinterDriver/1 versions this server speaks. */
const PRINTER_DRIVER_VERSIONS = '>=1.0 <2';

/** Fails before anything is written when the device takes no such document or not this size. */
function checkDocument(capabilities: PrinterCapabilities, bytes: Uint8Array, format: PrintFormat): void {
  if (!acceptsDocuments(capabilities) || !(capabilities.documentFormats ?? []).includes(format)) {
    throw new PrintOutputError('DOCUMENT_INPUT_UNSUPPORTED', `the printer device takes no ${format} documents`);
  }
  const limit = documentByteLimit(capabilities);
  if (bytes.byteLength > limit) {
    throw new PrintOutputError('DOCUMENT_TOO_LARGE', `the document of ${bytes.byteLength} bytes exceeds ${limit}`);
  }
}

/** A driver that advertises documents but does not answer `printer/submitDocument` takes none. */
function submitErrorCode(error: unknown): string {
  if (error instanceof RpcError && error.code === ErrorCodes.MethodNotFound) return 'DOCUMENT_INPUT_UNSUPPORTED';
  return pluginErrorCode(error, 'SUBMIT_FAILED');
}

/** Runs a plugin request, turning its failure into a `PrintOutputError` with the plugin's code. */
async function viaRequest(call: () => Promise<unknown>, fallback: string): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof PrintOutputError) throw error;
    throw new PrintOutputError(pluginErrorCode(error, fallback), 'the printer plugin request failed');
  }
}

export interface PrintOutputSetup {
  readonly config: PrintOutputConfig;
  readonly output: BppPrintOutput;
}

/**
 * Spec 034a: the print output of `env`, or `undefined` when `BPS_PRINT_OUTPUT` is unset; then the
 * printer variables are not read. Nothing is spawned here: the plugin starts on the first submit.
 */
export function configurePrintOutput(
  env: NodeJS.ProcessEnv,
  options: Pick<BppPrintOutputOptions, 'spoolDir' | 'launch' | 'onStderrLine'>,
): PrintOutputSetup | undefined {
  const config = parsePrintOutputConfig(env);
  if (config === undefined) return undefined;
  return { config, output: new BppPrintOutput({ ...config, ...options }) };
}

function unknownOutputJob(outputJobId: string): PrintOutputError {
  return new PrintOutputError('UNKNOWN_OUTPUT_JOB', `output job ${outputJobId} was not submitted by this server`);
}
