/**
 * Binds a `PrinterDriverV1` implementation to a `PluginServer`: validates params, serializes
 * `band/data` delivery per server and answers each band with `band/release`.
 */
import { RpcError } from '../stub.js';
import { formatSchemaErrors, validateSchema, type JsonSchema } from './json-schema.js';
import { ErrorCodes, isPlainObject } from './jsonrpc.js';
import { PrinterDriverMethods, type PrinterDriverV1, type SubmitParams } from './interfaces.js';
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

  server.onNotification(BandMethods.data, (params: unknown) => {
    bandQueue = bandQueue.then(() => deliverBand(server, driver, params));
    return bandQueue;
  });
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
