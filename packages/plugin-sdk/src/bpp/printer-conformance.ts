/**
 * PrinterDriver/1 conformance suite. Runs a driver in-process against the contract in
 * `interfaces.ts`: discovery, status, media, a full band submission, refusal of duplicates,
 * incomplete and cancelled submissions, and accounting. Band buffers are written to `spoolDir`.
 * Devices that advertise `documentFormats` also get the optional document checks (spec 034a0).
 */
import { writeFileBand } from './band-io.js';
import type { DiscoveredPrinter, PrinterDriverV1, PrinterState, SubmitParams } from './interfaces.js';
import { acceptsDocuments } from './printer.js';
import { runDocumentConformance } from './printer-document-conformance.js';
import type { BandMessage } from './protocol.js';

export interface PrinterConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface PrinterConformanceReport {
  passed: boolean;
  checks: PrinterConformanceCheck[];
}

export interface PrinterConformanceOptions {
  /** Directory the driver treats as its spool; band files are written below it. */
  spoolDir: string;
  /** Distinguishes submission ids between runs against the same driver. */
  runId?: string;
}

const PRINTER_STATES: readonly PrinterState[] = ['idle', 'receiving', 'printing', 'error', 'offline'];
const BAND_WIDTH = 16;
const BAND_HEIGHT = 4;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function expectRejection(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
  } catch {
    return undefined;
  }
  return 'resolved, expected a rejection';
}

function deviceProblems(device: DiscoveredPrinter): string | undefined {
  const problems: string[] = [];
  const caps = device.capabilities;
  if (typeof device.deviceId !== 'string' || device.deviceId === '') problems.push('deviceId must be a non-empty string');
  if (typeof device.name !== 'string' || device.name === '') problems.push('name must be a non-empty string');
  if (!caps || (caps.input !== 'bands' && caps.input !== 'document')) problems.push('capabilities.input must be "bands" or "document"');
  // Raster fields describe band input; a document-input device may leave them empty.
  if (caps?.input === 'document') return problems.length === 0 ? undefined : problems.join('; ');
  if (!Array.isArray(caps?.colorants) || caps.colorants.length === 0) problems.push('capabilities.colorants must be non-empty');
  if (!Array.isArray(caps?.bitsPerSample) || caps.bitsPerSample.length === 0) problems.push('capabilities.bitsPerSample must be non-empty');
  if (!Array.isArray(caps?.resolutionsDpi) || caps.resolutionsDpi.length === 0) problems.push('capabilities.resolutionsDpi must be non-empty');
  return problems.length === 0 ? undefined : problems.join('; ');
}

export async function runPrinterDriverConformance(
  driver: PrinterDriverV1,
  options: PrinterConformanceOptions,
): Promise<PrinterConformanceReport> {
  const checks: PrinterConformanceCheck[] = [];
  const run = async (name: string, body: () => Promise<string | undefined>): Promise<void> => {
    try {
      const problem = await body();
      checks.push(problem === undefined ? { name, ok: true } : { name, ok: false, detail: problem });
    } catch (error) {
      checks.push({ name, ok: false, detail: errorMessage(error) });
    }
  };
  const report = (): PrinterConformanceReport => ({ passed: checks.every((c) => c.ok), checks });
  const runId = options.runId ?? `c${Date.now().toString(36)}`;

  let device: DiscoveredPrinter | undefined;
  await run('discover lists a well-formed device', async () => {
    const first = (await driver.discover())?.devices?.[0];
    if (!first) return 'no devices discovered';
    const problem = deviceProblems(first);
    if (problem === undefined) device = first;
    return problem;
  });
  if (!device) return report();
  const deviceId = device.deviceId;
  const caps = device.capabilities;

  await run('getStatus reports the discovered device', async () => {
    const status = await driver.getStatus({ deviceId });
    if (status.deviceId !== deviceId) return `deviceId ${status.deviceId} !== ${deviceId}`;
    return PRINTER_STATES.includes(status.state) ? undefined : `unknown state ${String(status.state)}`;
  });
  await run('getStatus rejects an unknown device', () =>
    expectRejection(() => driver.getStatus({ deviceId: `${deviceId}-unknown-${runId}` })),
  );
  await run('listMedia returns well-formed media', async () => {
    const { media } = await driver.listMedia({ deviceId });
    if (!Array.isArray(media)) return 'media must be an array';
    const bad = media.find((item) => typeof item.id !== 'string' || typeof item.name !== 'string');
    return bad ? `media entry without id/name: ${JSON.stringify(bad)}` : undefined;
  });

  // Optional (spec 034a0): only devices that advertise documentFormats get the document checks.
  if (acceptsDocuments(caps)) {
    await run('document checks set up a spool file and a BPP connection', async () => {
      await runDocumentConformance(driver, { deviceId, capabilities: caps, spoolDir: options.spoolDir, runId }, run);
      return undefined;
    });
  }

  if (caps.input !== 'bands') {
    checks.push({ name: 'band submission checks', ok: true, detail: 'skipped: device takes document input' });
    return report();
  }

  const bitsPerSample = caps.bitsPerSample.includes(8) ? 8 : (caps.bitsPerSample[0] ?? 8);
  const resolutionDpi: [number, number] = caps.resolutionsDpi[0] ?? [72, 72];
  const stride = Math.ceil((BAND_WIDTH * bitsPerSample) / 8);
  const planeBytes = stride * BAND_HEIGHT;
  let bandCounter = 0;

  const makeBand = async (submissionId: string, index: number): Promise<BandMessage> => {
    const size = planeBytes * caps.colorants.length;
    const seed = bandCounter++;
    const data = Uint8Array.from({ length: size }, (_, j) => (j * 7 + seed) % 256);
    const handle = await writeFileBand(
      options.spoolDir,
      `printer-conformance/${runId}/${submissionId}/band-${index}.bin`,
      data,
    );
    return {
      bandId: `${submissionId}-b${index}`,
      y0: index * BAND_HEIGHT,
      height: BAND_HEIGHT,
      width: BAND_WIDTH,
      planes: caps.colorants.map((colorant, plane) => ({
        colorant,
        bitsPerSample,
        stride,
        offset: plane * planeBytes,
      })),
      handle,
    };
  };
  const sendBands = async (submissionId: string, count: number, total: number): Promise<number> => {
    let bytes = 0;
    for (let index = 0; index < count; index++) {
      const band = await makeBand(submissionId, index);
      await driver.onBand({ streamId: submissionId, page: 0, band, last: index === total - 1 });
      bytes += band.handle.sizeBytes;
    }
    return bytes;
  };
  const submitParams = (submissionId: string, totalBands: number): SubmitParams => ({
    deviceId,
    jobId: `job-${runId}`,
    submissionId,
    pageCount: 1,
    totalBands,
    resolutionDpi,
  });

  const printedId = `${runId}-printed`;
  await run('a complete submission is printed with matching totals', async () => {
    const submitted = await driver.submit(submitParams(printedId, 2));
    if (!submitted.accepted) return `submit refused: ${submitted.reason ?? 'no reason'}`;
    const bytes = await sendBands(printedId, 2, 2);
    const result = await driver.complete({ submissionId: printedId });
    const problems: string[] = [];
    if (result.submissionId !== printedId) problems.push(`submissionId ${result.submissionId}`);
    if (result.state !== 'printed') problems.push(`state ${result.state}`);
    if (result.bandsReceived !== 2) problems.push(`bandsReceived ${result.bandsReceived}`);
    if (result.bytesReceived !== bytes) problems.push(`bytesReceived ${result.bytesReceived} !== ${bytes}`);
    return problems.length === 0 ? undefined : problems.join('; ');
  });
  await run('a duplicate submissionId is refused', async () => {
    try {
      const again = await driver.submit(submitParams(printedId, 1));
      return again.accepted ? 'duplicate submission was accepted' : undefined;
    } catch {
      return undefined;
    }
  });
  await run('complete fails when bands are missing', async () => {
    const id = `${runId}-short`;
    const submitted = await driver.submit(submitParams(id, 2));
    if (!submitted.accepted) return `submit refused: ${submitted.reason ?? 'no reason'}`;
    await sendBands(id, 1, 2);
    try {
      const result = await driver.complete({ submissionId: id });
      return result.state === 'printed' ? 'printed with a missing band' : undefined;
    } catch {
      return undefined;
    }
  });
  await run('a cancelled submission cannot be completed', async () => {
    const id = `${runId}-cancelled`;
    const submitted = await driver.submit(submitParams(id, 1));
    if (!submitted.accepted) return `submit refused: ${submitted.reason ?? 'no reason'}`;
    await driver.cancel({ submissionId: id });
    try {
      const result = await driver.complete({ submissionId: id });
      return result.state === 'printed' ? 'printed after cancel' : undefined;
    } catch {
      return undefined;
    }
  });
  await run('bands for an unknown submission are rejected', async () => {
    const id = `${runId}-unknown`;
    const band = await makeBand(id, 0);
    return expectRejection(() => driver.onBand({ streamId: id, page: 0, band, last: true }));
  });
  await run('accounting returns records for the device', async () => {
    const { records } = await driver.accounting({ deviceId });
    if (!Array.isArray(records)) return 'records must be an array';
    const foreign = records.find((record) => record.deviceId !== deviceId);
    return foreign ? `record for another device: ${foreign.deviceId}` : undefined;
  });
  await run('the device is idle once submissions have finished', async () => {
    const status = await driver.getStatus({ deviceId });
    return status.state === 'idle' ? undefined : `state ${status.state}`;
  });
  return report();
}
