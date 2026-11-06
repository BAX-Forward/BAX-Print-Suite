import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor, Job } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import {
  Connection,
  ErrorCodes,
  LifecycleMethods,
  PluginServer,
  PRINTER_DRIVER_INTERFACE,
  PrinterDriverMethods,
  registerPrinterDriver,
  RpcError,
  silentLogger,
  type PrinterCapabilities,
  type PrinterDriverV1,
  type SubmissionParams,
  type SubmitDocumentParams,
} from '@bax-print/plugin-sdk';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import {
  BppPrintOutput,
  configurePrintOutput,
  parsePrintOutputConfig,
  PrintOutputError,
  type LaunchedPrinterPlugin,
  type PrintFormat,
  type PrintOutput,
  type PrintOutputStatus,
  type PrintSubmission,
} from '../src/print-output.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

interface Submitted {
  readonly jobId: string;
  readonly bytes: Uint8Array;
  readonly format: PrintFormat;
}

/** A `PrintOutput` that spawns nothing: it records submissions and fails with `error` when set. */
class FakePrintOutput implements PrintOutput {
  readonly submitted: Submitted[] = [];
  readonly cancelled: string[] = [];
  error: PrintOutputError | undefined;
  closed = false;

  async submit(job: Job, bytes: Uint8Array, format: PrintFormat): Promise<PrintSubmission> {
    this.fail();
    this.submitted.push({ jobId: job.id, bytes, format });
    return { outputJobId: `out-${this.submitted.length}` };
  }

  async status(outputJobId: string): Promise<PrintOutputStatus> {
    this.fail();
    return { outputJobId, state: 'queued', message: 'waiting' };
  }

  async cancel(outputJobId: string): Promise<PrintOutputStatus> {
    this.fail();
    this.cancelled.push(outputJobId);
    return { outputJobId, state: 'cancelled' };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private fail(): void {
    if (this.error) throw this.error;
  }
}

async function sourcePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 100]);
  return pdf.save();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface FakeDriverOptions {
  /** Leaves `submitDocument` out, like a band-only driver. */
  readonly implement?: boolean;
  /** `printer/submitDocument` fails with this `data.code`. */
  readonly refuse?: string;
}

/** What a fake driver saw: documents, band deliveries, band submissions and cancels. */
interface DriverRecord {
  readonly documents: { readonly params: SubmitDocumentParams; readonly bytes: Uint8Array }[];
  readonly bands: string[];
  readonly bandSubmissions: string[];
  readonly cancelled: SubmissionParams[];
}

const DEVICE_ID = 'device-1';

/** A PrinterDriver/1 with one device of `capabilities`, recording everything it receives. */
function fakeDriver(
  capabilities: Partial<PrinterCapabilities>,
  record: DriverRecord,
  options: FakeDriverOptions = {},
): PrinterDriverV1 {
  const caps: PrinterCapabilities = { input: 'bands', colorants: [], bitsPerSample: [], resolutionsDpi: [], ...capabilities };
  const driver: PrinterDriverV1 = {
    discover: async () => ({ devices: [{ deviceId: DEVICE_ID, name: 'Test device', capabilities: caps }] }),
    getStatus: async ({ deviceId }) => ({ deviceId, state: 'printing', message: 'busy' }),
    listMedia: async () => ({ media: [] }),
    submit: async (params) => {
      record.bandSubmissions.push(params.submissionId);
      return { accepted: true };
    },
    onBand: async (params) => {
      record.bands.push(params.streamId);
    },
    complete: async ({ submissionId }) => ({ submissionId, state: 'printed', bandsReceived: 0, bytesReceived: 0 }),
    cancel: async (params) => {
      record.cancelled.push(params);
    },
    accounting: async () => ({ records: [] }),
  };
  if (options.implement === false) return driver;
  return {
    ...driver,
    submitDocument: async (params, bytes) => {
      if (options.refuse !== undefined) {
        throw new RpcError(ErrorCodes.InvalidParams, 'refused by the test driver', { code: options.refuse });
      }
      record.documents.push({ params, bytes });
      return { submissionId: params.submissionId };
    },
  };
}

interface FakePlugin {
  readonly launch: (manifestPath: string) => Promise<LaunchedPrinterPlugin>;
  readonly launches: string[];
  /** Every BPP request the host sent, in order. */
  readonly methods: string[];
  readonly record: DriverRecord;
}

/** Serves a fake driver over an in-memory BPP connection instead of spawning a process. */
function fakePlugin(capabilities: Partial<PrinterCapabilities>, options: FakeDriverOptions = {}): FakePlugin {
  const launches: string[] = [];
  const methods: string[] = [];
  const record: DriverRecord = { documents: [], bands: [], bandSubmissions: [], cancelled: [] };
  const launch = async (manifestPath: string): Promise<LaunchedPrinterPlugin> => {
    launches.push(manifestPath);
    const hostToPlugin = new PassThrough();
    const pluginToHost = new PassThrough();
    const server = new PluginServer({
      plugin: { id: 'org.example.print-output-test', name: 'Print output test', version: '0.0.1' },
      offers: [{ interface: PRINTER_DRIVER_INTERFACE, version: '1.0.0' }],
      input: hostToPlugin,
      output: pluginToHost,
      log: silentLogger,
    });
    registerPrinterDriver(server, fakeDriver(capabilities, record, options));
    const connection = new Connection(pluginToHost, hostToPlugin);
    return {
      manifest: { provides: [{ interface: PRINTER_DRIVER_INTERFACE }] },
      client: {
        request: (method, params) => {
          methods.push(method);
          return connection.request(method, params);
        },
        close: async () => {
          connection.close();
          server.connection.close();
        },
      },
    };
  };
  return { launch, launches, methods, record };
}

const MANIFEST_PATH = '/plugins/printer/bps-plugin.json';

function bppOutput(plugin: FakePlugin): (spoolDir: string) => PrintOutput {
  return (spoolDir) => new BppPrintOutput({ manifestPath: MANIFEST_PATH, settings: {}, spoolDir, launch: plugin.launch });
}

/** `false` mounts no print output, `true` or absent the recording fake; a function builds one over the spool. */
type PrintOutputOption = boolean | PrintOutput | ((spoolDir: string) => PrintOutput | undefined);

function chooseOutput(option: PrintOutputOption | undefined, fake: FakePrintOutput, spoolDir: string): PrintOutput | undefined {
  if (option === false) return undefined;
  if (option === undefined || option === true) return fake;
  if (typeof option === 'function') return option(spoolDir);
  return option;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
  readonly output: FakePrintOutput;
  /** The spool directory a `BppPrintOutput` built by the harness writes to. */
  readonly spoolDir: string;
}

describe('/jobs/:id/print (Spec 034a)', () => {
  let h: Harness | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await h?.app.close();
    h = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  async function createHarness(options: { printOutput?: PrintOutputOption; actor?: Actor } = {}): Promise<Harness> {
    dataDir = await mkdtemp(join(tmpdir(), 'bps-034a-'));
    const blobsDir = join(dataDir, 'blobs');
    const spoolDir = join(dataDir, 'spool', 'print-output');
    const blobPath = (storageKey: string): string => resolve(blobsDir, ...storageKey.split('/'));
    const time = fakeClock('2026-03-01T08:00:00.000Z');
    const outbox = new MemoryOutbox();
    const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
    const repository = new MemoryJobRepository();
    const blobs = new LocalDirStorage(blobsDir);
    const jobs = new JobService({ jobs: repository, blobs, bus, clock: time.clock, newId: sequentialIds('job') });
    const archive = new ArchiveService({
      jobs: repository,
      index: new MemoryArchiveIndex(),
      blobs,
      archive: new MemoryStorage(),
      bus,
      outbox,
      colorSetups: new StaticColorSetupResolver(),
      clock: time.clock,
      newId: sequentialIds('pkg'),
    });
    const output = new FakePrintOutput();
    const chosen = chooseOutput(options.printOutput, output, spoolDir);
    const app = buildServer({
      archive,
      jobs: repository,
      ...(chosen ? { printOutput: { output: chosen, blobPath } } : {}),
      ...(options.actor ? { authenticate: () => options.actor ?? VIEWER } : {}),
    });
    return { app, jobs, output, spoolDir };
  }

  async function createJob(harness: Harness, bytes: Uint8Array, name = 'poster.pdf'): Promise<string> {
    const job = await harness.jobs.create({ name: 'Poster', sources: [{ name, bytes }], ticket: TICKET });
    return job.id;
  }

  it('mounts no print route without a print output', async () => {
    h = await createHarness({ printOutput: false });
    const jobId = await createJob(h, await sourcePdf());

    const post = await h.app.inject({ method: 'POST', url: `/jobs/${jobId}/print` });
    const get = await h.app.inject({ method: 'GET', url: `/jobs/${jobId}/print/out-1` });
    const del = await h.app.inject({ method: 'DELETE', url: `/jobs/${jobId}/print/out-1` });

    expect([post.statusCode, get.statusCode, del.statusCode]).toEqual([404, 404, 404]);
    expect(h.output.submitted).toEqual([]);
  });

  it('sends the stored source PDF and reports and cancels the output job', async () => {
    h = await createHarness();
    const pdf = await sourcePdf();
    const jobId = await createJob(h, pdf);

    const post = await h.app.inject({ method: 'POST', url: `/jobs/${jobId}/print` });
    const get = await h.app.inject({ method: 'GET', url: `/jobs/${jobId}/print/out-1` });
    const del = await h.app.inject({ method: 'DELETE', url: `/jobs/${jobId}/print/out-1` });

    expect(post.statusCode).toBe(202);
    expect(post.json()).toEqual({ outputJobId: 'out-1' });
    const [sent] = h.output.submitted;
    expect(h.output.submitted).toHaveLength(1);
    expect(sent?.jobId).toBe(jobId);
    expect(sent?.format).toBe('pdf');
    expect(sent !== undefined && Buffer.from(pdf).equals(sent.bytes)).toBe(true);
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ outputJobId: 'out-1', state: 'queued', message: 'waiting' });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ outputJobId: 'out-1', state: 'cancelled' });
    expect(h.output.cancelled).toEqual(['out-1']);
  });

  it('records nothing new on the job', async () => {
    h = await createHarness();
    const jobId = await createJob(h, await sourcePdf());
    const before = await h.jobs.get(jobId);

    await h.app.inject({ method: 'POST', url: `/jobs/${jobId}/print` });

    expect(await h.jobs.get(jobId)).toEqual(before);
  });

  it('answers 409 unsupported_format for a non-PDF source and sends nothing', async () => {
    h = await createHarness();
    const jobId = await createJob(h, PNG_SIGNATURE, 'poster.png');

    const response = await h.app.inject({ method: 'POST', url: `/jobs/${jobId}/print` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'unsupported_format' } });
    expect(h.output.submitted).toEqual([]);
  });

  it.each([
    ['POST', '/print'],
    ['GET', '/print/out-1'],
    ['DELETE', '/print/out-1'],
  ] as const)('answers %s with 502 printer_error and the plugin code', async (method, path) => {
    h = await createHarness();
    const jobId = await createJob(h, await sourcePdf());
    h.output.error = new PrintOutputError('OUTPUT_EXISTS', 'output /secret/dir/job.pdf already exists');

    const response = await h.app.inject({ method, url: `/jobs/${jobId}${path}` });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: { code: 'printer_error', message: 'The printer plugin failed with OUTPUT_EXISTS', details: { code: 'OUTPUT_EXISTS' } },
    });
  });

  it.each([
    ['POST', '/print'],
    ['GET', '/print/out-1'],
    ['DELETE', '/print/out-1'],
  ] as const)('answers %s for an unknown job with 404 not_found', async (method, path) => {
    h = await createHarness();

    const response = await h.app.inject({ method, url: `/jobs/no-such-job${path}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Job no-such-job not found' } });
    expect(h.output.submitted).toEqual([]);
    expect(h.output.cancelled).toEqual([]);
  });

  it('denies a viewer the print with 403 jobs:write and lets them read the status', async () => {
    h = await createHarness({ actor: VIEWER });
    const jobId = await createJob(h, await sourcePdf());

    const post = await h.app.inject({ method: 'POST', url: `/jobs/${jobId}/print` });
    const del = await h.app.inject({ method: 'DELETE', url: `/jobs/${jobId}/print/out-1` });
    const get = await h.app.inject({ method: 'GET', url: `/jobs/${jobId}/print/out-1` });

    expect(post.statusCode).toBe(403);
    expect(post.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:write' } } });
    expect(del.statusCode).toBe(403);
    expect(get.statusCode).toBe(200);
    expect(h.output.submitted).toEqual([]);
  });

  it('lets the local admin print without a resolver, whatever the headers say', async () => {
    h = await createHarness();
    const jobId = await createJob(h, await sourcePdf());

    const response = await h.app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/print`,
      headers: { 'x-bps-role': 'viewer', 'x-bps-actor': 'someone-else' },
    });

    expect(response.statusCode).toBe(202);
  });

  it('closes the print output with the server', async () => {
    h = await createHarness();
    const { output } = h;

    await h.app.close();
    h = undefined;

    expect(output.closed).toBe(true);
  });

  it('mounts no print route and launches no plugin without BPS_PRINT_OUTPUT, whatever BPS_PRINTER_PLUGIN says', async () => {
    const plugin = fakePlugin({ documentFormats: ['pdf'] });
    h = await createHarness({
      printOutput: (spoolDir) =>
        configurePrintOutput({ BPS_PRINTER_PLUGIN: '/no/such/bps-plugin.json' }, { spoolDir, launch: plugin.launch })?.output,
    });
    const jobId = await createJob(h, await sourcePdf());

    const post = await h.app.inject({ method: 'POST', url: `/jobs/${jobId}/print` });
    const get = await h.app.inject({ method: 'GET', url: `/jobs/${jobId}/print/out-1` });

    expect([post.statusCode, get.statusCode]).toEqual([404, 404]);
    expect(plugin.launches).toEqual([]);
  });

  describe('over a PrinterDriver/1 plugin', () => {
    async function printedJob(harness: Harness, pdf: Uint8Array): Promise<{ jobId: string; status: number; body: unknown }> {
      const jobId = await createJob(harness, pdf);
      const response = await harness.app.inject({ method: 'POST', url: `/jobs/${jobId}/print` });
      return { jobId, status: response.statusCode, body: response.json() };
    }

    const SETUP = [LifecycleMethods.initialize, LifecycleMethods.configure, PrinterDriverMethods.discover];

    it.each<[string, Partial<PrinterCapabilities>, boolean]>([
      ['a band-only driver', {}, false],
      ['an empty documentFormats', { input: 'document', documentFormats: [] }, true],
      ['a device without the PDF format', { input: 'document', documentFormats: ['tiff'] }, true],
    ])('answers 409 document_input_unsupported for %s and sends no document or band', async (_label, capabilities, implement) => {
      const plugin = fakePlugin(capabilities, { implement });
      h = await createHarness({ printOutput: bppOutput(plugin) });

      const { status, body } = await printedJob(h, await sourcePdf());

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: { code: 'document_input_unsupported', details: { code: 'DOCUMENT_INPUT_UNSUPPORTED' } } });
      expect(plugin.launches).toEqual([MANIFEST_PATH]);
      expect(plugin.methods).toEqual(SETUP);
      expect(plugin.record).toEqual({ documents: [], bands: [], bandSubmissions: [], cancelled: [] });
      expect(await readdir(h.spoolDir)).toEqual([]);
    });

    it('answers 413 document_too_large above maxDocumentBytes before writing anything', async () => {
      const plugin = fakePlugin({ input: 'document', documentFormats: ['pdf'], maxDocumentBytes: 16 });
      h = await createHarness({ printOutput: bppOutput(plugin) });

      const { status, body } = await printedJob(h, await sourcePdf());

      expect(status).toBe(413);
      expect(body).toMatchObject({ error: { code: 'document_too_large', details: { code: 'DOCUMENT_TOO_LARGE' } } });
      expect(plugin.methods).toEqual(SETUP);
      expect(plugin.record.documents).toEqual([]);
      expect(await readdir(h.spoolDir)).toEqual([]);
    });

    it('sends the document through printer/submitDocument with its size and sha256 and removes the spool file', async () => {
      const plugin = fakePlugin({ input: 'document', documentFormats: ['pdf'] });
      h = await createHarness({ printOutput: bppOutput(plugin) });
      const pdf = await sourcePdf();

      const { jobId, status, body } = await printedJob(h, pdf);

      expect(status).toBe(202);
      expect(plugin.methods).toEqual([...SETUP, PrinterDriverMethods.submitDocument]);
      const [sent] = plugin.record.documents;
      expect(plugin.record.documents).toHaveLength(1);
      expect(sent?.params).toMatchObject({
        deviceId: DEVICE_ID,
        jobId,
        format: 'pdf',
        byteLength: pdf.byteLength,
        sha256: sha256Hex(pdf),
        document: { transport: 'file', sizeBytes: pdf.byteLength },
      });
      expect(sent?.params.submissionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(sent?.params.document.path.startsWith(h.spoolDir)).toBe(true);
      expect(sent === undefined ? false : Buffer.from(pdf).equals(sent.bytes)).toBe(true);
      expect(body).toEqual({ outputJobId: sent?.params.submissionId });
      expect(plugin.record.bands).toEqual([]);
      expect(plugin.record.bandSubmissions).toEqual([]);
      expect(await readdir(h.spoolDir)).toEqual([]);
    });

    it('reports and cancels the output job through printer/getStatus and printer/cancel', async () => {
      const plugin = fakePlugin({ input: 'document', documentFormats: ['pdf'] });
      h = await createHarness({ printOutput: bppOutput(plugin) });
      const { jobId, body } = await printedJob(h, await sourcePdf());
      const submissionId = typeof body === 'object' && body !== null && 'outputJobId' in body ? String(body.outputJobId) : '';

      const get = await h.app.inject({ method: 'GET', url: `/jobs/${jobId}/print/${submissionId}` });
      const del = await h.app.inject({ method: 'DELETE', url: `/jobs/${jobId}/print/${submissionId}` });

      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ outputJobId: submissionId, state: 'printing', message: 'busy' });
      expect(del.statusCode).toBe(200);
      expect(plugin.record.cancelled).toEqual([{ submissionId }]);
      expect(plugin.methods.slice(SETUP.length + 1)).toEqual([
        PrinterDriverMethods.getStatus,
        PrinterDriverMethods.cancel,
        PrinterDriverMethods.getStatus,
      ]);
    });

    it.each([
      ['DOCUMENT_MISMATCH', 502, 'printer_error'],
      ['FORMAT_NOT_ACCEPTED', 409, 'document_input_unsupported'],
      ['DOCUMENT_TOO_LARGE', 413, 'document_too_large'],
    ] as const)('maps the plugin refusal %s to %i %s and removes the spool file', async (code, statusCode, apiCode) => {
      const plugin = fakePlugin({ input: 'document', documentFormats: ['pdf'] }, { refuse: code });
      h = await createHarness({ printOutput: bppOutput(plugin) });

      const { status, body } = await printedJob(h, await sourcePdf());

      expect(status).toBe(statusCode);
      expect(body).toMatchObject({ error: { code: apiCode, details: { code } } });
      expect(await readdir(h.spoolDir)).toEqual([]);
    });
  });
});

describe('parsePrintOutputConfig (Spec 034a)', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function manifestFile(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'bps-034a-env-'));
    const path = join(dir, 'bps-plugin.json');
    await writeFile(path, '{}');
    return path;
  }

  const ON = { BPS_PRINT_OUTPUT: '1' } as const;

  it('is off without BPS_PRINT_OUTPUT and reads no printer variable', () => {
    expect(parsePrintOutputConfig({})).toBeUndefined();
    expect(parsePrintOutputConfig({ BPS_PRINTER_PLUGIN: '', BPS_PRINTER_SETTINGS: 'not json' })).toBeUndefined();
    expect(parsePrintOutputConfig({ BPS_PRINTER_PLUGIN: 'relative/bps-plugin.json' })).toBeUndefined();
  });

  it.each(['0', 'yes', 'true', ''])('stops startup for BPS_PRINT_OUTPUT=%j', (value) => {
    expect(() => parsePrintOutputConfig({ BPS_PRINT_OUTPUT: value })).toThrow(/BPS_PRINT_OUTPUT must be 1 or unset/);
  });

  it('stops startup for BPS_PRINT_OUTPUT=1 without BPS_PRINTER_PLUGIN', () => {
    expect(() => parsePrintOutputConfig(ON)).toThrow(/needs BPS_PRINTER_PLUGIN/);
    expect(() => parsePrintOutputConfig({ ...ON, BPS_PRINTER_PLUGIN: '' })).toThrow(/needs BPS_PRINTER_PLUGIN/);
  });

  it('takes an absolute manifest path and the settings object', async () => {
    const path = await manifestFile();

    expect(parsePrintOutputConfig({ ...ON, BPS_PRINTER_PLUGIN: path, BPS_PRINTER_SETTINGS: '{"outputDir":"/srv/out"}' })).toEqual({
      manifestPath: path,
      settings: { outputDir: '/srv/out' },
    });
    expect(parsePrintOutputConfig({ ...ON, BPS_PRINTER_PLUGIN: path })).toEqual({ manifestPath: path, settings: {} });
  });

  it('rejects a relative path', () => {
    expect(() => parsePrintOutputConfig({ ...ON, BPS_PRINTER_PLUGIN: 'plugins/printer/bps-plugin.json' })).toThrow(/absolute path/);
  });

  it('rejects a missing file', async () => {
    const path = await manifestFile();

    expect(() => parsePrintOutputConfig({ ...ON, BPS_PRINTER_PLUGIN: join(path, '..', 'missing.json') })).toThrow(/is not a file/);
  });

  it('configures nothing and launches nothing while the flag is off', () => {
    const launches: string[] = [];
    const launch = (path: string): Promise<LaunchedPrinterPlugin> => {
      launches.push(path);
      return Promise.reject(new Error('not expected'));
    };

    expect(configurePrintOutput({ BPS_PRINTER_PLUGIN: '/no/such/bps-plugin.json' }, { spoolDir: '/unused', launch })).toBeUndefined();
    expect(launches).toEqual([]);
  });

  it('configures the plugin with the flag but does not launch it before the first submit', async () => {
    const path = await manifestFile();
    const plugin = fakePlugin({ documentFormats: ['pdf'] });

    const setup = configurePrintOutput({ ...ON, BPS_PRINTER_PLUGIN: path }, { spoolDir: '/unused', launch: plugin.launch });

    expect(setup?.config).toEqual({ manifestPath: path, settings: {} });
    expect(plugin.launches).toEqual([]);
    await setup?.output.close();
  });

  it.each(['{"token": "s3cret-value"', '["s3cret-value"]', 'null'])('rejects the settings %j without echoing them', async (settings) => {
    const path = await manifestFile();

    let message = '';
    try {
      parsePrintOutputConfig({ ...ON, BPS_PRINTER_PLUGIN: path, BPS_PRINTER_SETTINGS: settings });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/BPS_PRINTER_SETTINGS/);
    expect(message).not.toContain('s3cret-value');
  });
});

describe('BppPrintOutput (Spec 034a)', () => {
  const config = { manifestPath: MANIFEST_PATH, settings: { token: 's3cret-value' }, spoolDir: '/unused/spool' };

  async function sampleJob(): Promise<{ job: Job; pdf: Uint8Array }> {
    const pdf = await sourcePdf();
    const jobs = new JobService({ jobs: new MemoryJobRepository(), blobs: new MemoryStorage(), bus: new EventBus(new MemoryOutbox()) });
    return { job: await jobs.create({ name: 'Poster', sources: [{ name: 'poster.pdf', bytes: pdf }], ticket: TICKET }), pdf };
  }

  it('starts the plugin only on submit and maps a failed start to PLUGIN_UNAVAILABLE', async () => {
    const { job, pdf } = await sampleJob();
    const launches: string[] = [];
    const output = new BppPrintOutput({
      ...config,
      launch: (path) => {
        launches.push(path);
        return Promise.reject(new Error('spawn ENOENT'));
      },
    });

    await expect(output.status('out-1')).rejects.toMatchObject({ code: 'UNKNOWN_OUTPUT_JOB' });
    await expect(output.cancel('out-1')).rejects.toMatchObject({ code: 'UNKNOWN_OUTPUT_JOB' });
    expect(launches).toEqual([]);

    await expect(output.submit(job, pdf, 'pdf')).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
    expect(launches).toEqual([config.manifestPath]);
  });

  it('closes without starting the plugin and refuses work afterwards', async () => {
    const { job, pdf } = await sampleJob();
    const launches: string[] = [];
    const output = new BppPrintOutput({
      ...config,
      launch: (path) => {
        launches.push(path);
        return Promise.reject(new Error('not expected'));
      },
    });

    await output.close();

    await expect(output.submit(job, pdf, 'pdf')).rejects.toMatchObject({ code: 'PLUGIN_CLOSED' });
    expect(launches).toEqual([]);
  });

  it('passes copies and mediaName to printer/submitDocument when given', async () => {
    const { job, pdf } = await sampleJob();
    const spoolDir = await mkdtemp(join(tmpdir(), 'bps-034a-spool-'));
    const plugin = fakePlugin({ input: 'document', documentFormats: ['pdf'] });
    const output = bppOutput(plugin)(spoolDir);
    try {
      const submission = await output.submit(job, pdf, 'pdf', { copies: 2, mediaName: 'Matte' });

      expect(plugin.record.documents.map((document) => document.params)).toEqual([
        expect.objectContaining({ submissionId: submission.outputJobId, copies: 2, mediaName: 'Matte' }),
      ]);
      expect(await readdir(spoolDir)).toEqual([]);
    } finally {
      await output.close();
      await rm(spoolDir, { recursive: true, force: true });
    }
  });

  it('refuses status and cancel for an output job it did not submit, without asking the plugin', async () => {
    const plugin = fakePlugin({ input: 'document', documentFormats: ['pdf'] });
    const output = bppOutput(plugin)('/unused/spool');

    await expect(output.status('out-1')).rejects.toBeInstanceOf(PrintOutputError);
    expect(plugin.launches).toEqual([]);
  });
});
