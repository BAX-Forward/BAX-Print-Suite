/**
 * Binds a `PrinterDriverV1` implementation to a `PluginServer`: validates params, serializes
 * `band/data` delivery per server and answers each band with `band/release`.
 */
import { RpcError } from '../stub.js';
import { readFileDocument } from './band-io.js';
import { formatSchemaErrors, validateSchema, type JsonSchema } from './json-schema.js';
import { ErrorCodes, isPlainObject } from './jsonrpc.js';
import {
  DocumentErrorCodes,
  MAX_DOCUMENT_BYTES,
  PRINTER_DOCUMENT_FORMATS,
  PrinterDriverMethods,
  type PrinterCapabilities,
  type PrinterDriverV1,
  type SubmitDocumentParams,
  type SubmitDocumentResult,
  type SubmitParams,
} from './interfaces.js';
import { BandMethods, type BandDataParams, type BandReleaseParams } from './protocol.js';
import { BAND_DATA_PARAMS_SCHEMA } from './schemas.js';
import type { PluginServer } from './server.js';

const nonEmptyString: JsonSchema = { type: 'string', minLength: 1 };

export const SUBMIT_PARAMS_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['deviceId', 'jobId', 'submissionId', 'pageCount', 'totalBands', 'resolutionDpi'],
  properties: {
    deviceId: nonEmptyString,
    jobId: nonEmptyString,
    submissionId: nonEmptyString,
    pageCount: { type: 'integer', minimum: 1 },
    totalBands: { type: 'integer', minimum: 1 },
    resolutionDpi: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 1 } },
  },
};

/** `printer/submitDocument` params (spec 034a0). The document is a `file` handle, like a band. */
export const SUBMIT_DOCUMENT_PARAMS_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['deviceId', 'jobId', 'submissionId', 'format', 'byteLength', 'sha256', 'document'],
  properties: {
    deviceId: nonEmptyString,
    jobId: nonEmptyString,
    submissionId: nonEmptyString,
    format: { type: 'string', enum: PRINTER_DOCUMENT_FORMATS },
    byteLength: { type: 'integer', minimum: 1 },
    sha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
    document: {
      type: 'object',
      required: ['transport', 'path', 'sizeBytes'],
      properties: {
        transport: { const: 'file' },
        path: nonEmptyString,
        sizeBytes: { type: 'integer', minimum: 1 },
      },
    },
    copies: { type: 'integer', minimum: 1, maximum: 999 },
    mediaName: nonEmptyString,
  },
};

/** Feature detection (spec 034a0): a device takes documents when `documentFormats` is non-empty. */
export function acceptsDocuments(capabilities: PrinterCapabilities): boolean {
  return Array.isArray(capabilities.documentFormats) && capabilities.documentFormats.length > 0;
}

/** The effective document size limit: `maxDocumentBytes` when valid, never above `MAX_DOCUMENT_BYTES`. */
export function documentByteLimit(capabilities: PrinterCapabilities): number {
  const advertised = capabilities.maxDocumentBytes;
  if (typeof advertised !== 'number' || !Number.isFinite(advertised) || advertised < 1) return MAX_DOCUMENT_BYTES;
  return Math.min(MAX_DOCUMENT_BYTES, Math.floor(advertised));
}

type DocumentPrinterDriver = PrinterDriverV1 & Required<Pick<PrinterDriverV1, 'submitDocument'>>;

function implementsSubmitDocument(driver: PrinterDriverV1): driver is DocumentPrinterDriver {
  return typeof driver.submitDocument === 'function';
}

function refuseDocument(code: string, message: string, data: Record<string, unknown> = {}): RpcError {
  return new RpcError(ErrorCodes.InvalidParams, message, { code, ...data });
}

function validated<T>(schema: JsonSchema, params: unknown, method: string): T {
  const errors = validateSchema(schema, params);
  if (errors.length > 0) {
    throw new RpcError(ErrorCodes.InvalidParams, `Invalid params for ${method}`, {
      errors: formatSchemaErrors(errors),
    });
  }
  return params as T;
}

function stringField(key: string): JsonSchema {
  return { type: 'object', required: [key], properties: { [key]: nonEmptyString } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerPrinterDriver(server: PluginServer, driver: PrinterDriverV1): void {
  const m = PrinterDriverMethods;
  const device = stringField('deviceId');
  const submission = stringField('submissionId');
  // Bands are applied in arrival order; `complete` waits for every band received before it.
  let bandQueue: Promise<void> = Promise.resolve();

  server.onRequest(m.discover, () => driver.discover());
  server.onRequest(m.getStatus, (params) => driver.getStatus(validated(device, params, m.getStatus)));
  server.onRequest(m.listMedia, (params) => driver.listMedia(validated(device, params, m.listMedia)));
  server.onRequest(m.submit, (params) =>
    driver.submit(validated<SubmitParams>(SUBMIT_PARAMS_SCHEMA, params, m.submit)),
  );
  server.onRequest(m.complete, async (params) => {
    const checked = validated<{ submissionId: string }>(submission, params, m.complete);
    await bandQueue;
    return driver.complete(checked);
  });
  server.onRequest(m.cancel, async (params) => {
    await driver.cancel(validated(submission, params, m.cancel));
    return null;
  });
  server.onRequest(m.accounting, (params) => driver.accounting(validated(device, params, m.accounting)));
  // Optional (spec 034a0): band-only drivers keep answering MethodNotFound, as before.
  if (implementsSubmitDocument(driver)) {
    server.onRequest(m.submitDocument, (params) => submitDocument(server, driver, params));
  }

  server.onNotification(BandMethods.data, (params: unknown) => {
    bandQueue = bandQueue.then(() => deliverBand(server, driver, params));
    return bandQueue;
  });
}

/** Checks format and size against the device before reading the file, then size and sha256. */
async function submitDocument(
  server: PluginServer,
  driver: DocumentPrinterDriver,
  params: unknown,
): Promise<SubmitDocumentResult> {
  const method = PrinterDriverMethods.submitDocument;
  const checked = validated<SubmitDocumentParams>(SUBMIT_DOCUMENT_PARAMS_SCHEMA, params, method);
  const { devices } = await driver.discover();
  const target = devices.find((candidate) => candidate.deviceId === checked.deviceId);
  if (target === undefined) {
    throw new RpcError(ErrorCodes.InvalidParams, `unknown device ${checked.deviceId}`);
  }
  const formats = target.capabilities.documentFormats ?? [];
  if (!formats.includes(checked.format)) {
    throw refuseDocument(DocumentErrorCodes.formatNotAccepted, `Format ${checked.format} is not accepted`, {
      accepted: [...formats],
    });
  }
  const limit = documentByteLimit(target.capabilities);
  if (checked.byteLength > limit) {
    throw refuseDocument(DocumentErrorCodes.tooLarge, `Document of ${checked.byteLength} bytes exceeds ${limit}`, {
      limit,
    });
  }
  const bytes = await readFileDocument(checked.document, server.spoolDir, checked);
  return driver.submitDocument(checked, bytes);
}

async function deliverBand(server: PluginServer, driver: PrinterDriverV1, params: unknown): Promise<void> {
  const streamId = isPlainObject(params) && typeof params.streamId === 'string' ? params.streamId : '';
  const band: Record<string, unknown> = isPlainObject(params) && isPlainObject(params.band) ? params.band : {};
  const bandId = typeof band.bandId === 'string' ? band.bandId : '';
  let error: string | undefined;
  if (!server.isInitialized) {
    error = 'Not initialized';
  } else {
    const errors = validateSchema(BAND_DATA_PARAMS_SCHEMA, params);
    if (errors.length > 0) {
      error = `Invalid band/data: ${formatSchemaErrors(errors).join('; ')}`;
    } else {
      try {
        await driver.onBand(params as BandDataParams);
      } catch (caught) {
        error = errorMessage(caught);
      }
    }
  }
  if (error !== undefined) {
    server.log.warn('band rejected', { streamId, bandId, error });
  }
  const release: BandReleaseParams = { streamId, bandId, ...(error !== undefined ? { error } : {}) };
  server.notify(BandMethods.release, release);
}
