/**
 * Optional PrinterDriver/1 document checks (spec 034a0). They run only for devices that advertise
 * `documentFormats`, and go over a real in-process BPP connection so the SDK's size, sha256 and
 * limit checks in `registerPrinterDriver` are exercised exactly as a host would meet them.
 */
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { BPP_PROTOCOL } from '../stub.js';
import { writeFileBand } from './band-io.js';
import { Connection } from './connection.js';
import {
  DocumentErrorCodes,
  PRINTER_DOCUMENT_FORMATS,
  PrinterDriverMethods,
  type PrinterCapabilities,
  type PrinterDocumentFormat,
  type PrinterDriverV1,
  type SubmitDocumentParams,
  type SubmitDocumentResult,
} from './interfaces.js';
import { isPlainObject } from './jsonrpc.js';
import { silentLogger } from './logger.js';
import { documentByteLimit, registerPrinterDriver } from './printer.js';
import { INTERFACE_VERSIONS, type FileBandHandle } from './protocol.js';
import { PluginServer } from './server.js';

/** Adds a named check; the body returns a problem or `undefined` when the check passed. */
export type ConformanceRunner = (name: string, body: () => Promise<string | undefined>) => Promise<void>;

export interface DocumentConformanceContext {
  deviceId: string;
  capabilities: PrinterCapabilities;
  spoolDir: string;
  runId: string;
}

const TINY_DOCUMENTS: Readonly<Record<PrinterDocumentFormat, Uint8Array>> = Object.freeze({
  pdf: new TextEncoder().encode('%PDF-1.4\n% conformance\n%%EOF\n'),
  tiff: Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
});

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function errorDataCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined;
  const data: unknown = error.data;
  return isPlainObject(data) ? data.code : undefined;
}

async function expectRefusal(action: () => Promise<unknown>, code: string): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    const actual = errorDataCode(error);
    return actual === code ? undefined : `rejected with data.code ${String(actual)}, expected ${code}`;
  }
  return `resolved, expected a ${code} rejection`;
}

/** A host connection to `driver` served in-process; the caller must call `close`. */
async function connect(driver: PrinterDriverV1, spoolDir: string): Promise<{ host: Connection; close: () => void }> {
  const hostToPlugin = new PassThrough();
  const pluginToHost = new PassThrough();
  const server = new PluginServer({
    plugin: { id: 'org.bax-print.conformance.printer', name: 'Conformance', version: '0.0.0' },
    offers: [{ interface: 'PrinterDriver', version: INTERFACE_VERSIONS.PrinterDriver }],
    input: hostToPlugin,
    output: pluginToHost,
    log: silentLogger,
  });
  registerPrinterDriver(server, driver);
  const host = new Connection(pluginToHost, hostToPlugin);
  const close = (): void => {
    host.close();
    server.connection.close();
  };
  try {
    await host.request('initialize', {
      protocol: BPP_PROTOCOL,
      host: { name: 'printer-conformance', version: '0.0.0' },
      interfaces: [{ interface: 'PrinterDriver', versions: '>=1.0 <2' }],
      spoolDir,
      capabilities: { transports: ['file'] },
    });
  } catch (error) {
    close();
    throw error;
  }
  return { host, close };
}

export async function runDocumentConformance(
  driver: PrinterDriverV1,
  context: DocumentConformanceContext,
  run: ConformanceRunner,
): Promise<void> {
  const { deviceId, capabilities, spoolDir, runId } = context;
  const formats = capabilities.documentFormats ?? [];
  const format: PrinterDocumentFormat = formats.includes('pdf') ? 'pdf' : (formats[0] ?? 'pdf');
  const data = TINY_DOCUMENTS[format];
  const handle: FileBandHandle = await writeFileBand(spoolDir, `printer-conformance/${runId}/document.${format}`, data);
  const params = (suffix: string, overrides: Partial<SubmitDocumentParams> = {}): SubmitDocumentParams => ({
    deviceId,
    jobId: `job-${runId}-${suffix}`,
    submissionId: `${runId}-${suffix}`,
    format,
    byteLength: data.byteLength,
    sha256: sha256Hex(data),
    document: handle,
    ...overrides,
  });

  const { host, close } = await connect(driver, spoolDir);
  const submit = (request: SubmitDocumentParams): Promise<SubmitDocumentResult> =>
    host.request<SubmitDocumentResult>(PrinterDriverMethods.submitDocument, request);
  try {
    await run('submitDocument accepts a small document from the spool', async () => {
      const request = params('document');
      const result = await submit(request);
      return result.submissionId === request.submissionId
        ? undefined
        : `submissionId ${result.submissionId} !== ${request.submissionId}`;
    });
    await run('submitDocument rejects a document whose size differs', () => {
      const byteLength = data.byteLength + 1;
      const request = params('size', { byteLength, document: { ...handle, sizeBytes: byteLength } });
      return expectRefusal(() => submit(request), DocumentErrorCodes.mismatch);
    });
    await run('submitDocument rejects a document whose sha256 differs', () =>
      expectRefusal(() => submit(params('sha', { sha256: sha256Hex(Uint8Array.of(0)) })), DocumentErrorCodes.mismatch),
    );
    await run('submitDocument rejects a document above the size limit', () => {
      const byteLength = documentByteLimit(capabilities) + 1;
      const request = params('large', { byteLength, document: { ...handle, sizeBytes: byteLength } });
      return expectRefusal(() => submit(request), DocumentErrorCodes.tooLarge);
    });
    const refused = PRINTER_DOCUMENT_FORMATS.find((candidate) => !formats.includes(candidate));
    if (refused !== undefined) {
      await run('submitDocument rejects a format the device does not advertise', () =>
        expectRefusal(() => submit(params('format', { format: refused })), DocumentErrorCodes.formatNotAccepted),
      );
    }
  } finally {
    close();
  }
}
