import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Job } from '@bax-print/core';
import { EventBus, EventTypes, jobStatusChangedEvent, MemoryOutbox } from '@bax-print/events';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import {
  autoRouteSubmissionId,
  parsePrintAutoRouteFlag,
  PRINT_AUTO_ROUTE_STAGE,
  startPrintAutoRoute,
  type PrintAutoRoute,
  type PrintAutoRouteLog,
} from '../src/print-auto-route.js';
import {
  PrintOutputError,
  PrintSubmissionLedger,
  type PrintFormat,
  type PrintOptions,
  type PrintOutput,
  type PrintOutputStatus,
  type PrintSubmission,
} from '../src/print-output.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

/** The CloudEvents source hot folder intake publishes its status changes under. */
const HOTFOLDER_SOURCE = '/bps/hotfolder';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Submitted {
  readonly jobId: string;
  readonly bytes: Uint8Array;
  readonly format: PrintFormat;
  readonly submissionId: string | undefined;
}

/** A `PrintOutput` that spawns nothing: it records submissions and fails with `error` when set. */
class FakePrintOutput implements PrintOutput {
  readonly submitted: Submitted[] = [];
  error: PrintOutputError | undefined;
  closed = false;

  async submit(job: Job, bytes: Uint8Array, format: PrintFormat, options: PrintOptions = {}): Promise<PrintSubmission> {
    if (this.error) throw this.error;
    this.submitted.push({ jobId: job.id, bytes, format, submissionId: options.submissionId });
    return { outputJobId: options.submissionId ?? `out-${this.submitted.length}` };
  }

  async status(outputJobId: string): Promise<PrintOutputStatus> {
    return { outputJobId, state: 'queued' };
  }

  async cancel(outputJobId: string): Promise<PrintOutputStatus> {
    return { outputJobId, state: 'cancelled' };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string;
}

function recordingLog(entries: LogEntry[]): PrintAutoRouteLog {
  return {
    info: (fields, message) => {
      entries.push({ level: 'info', fields, message });
    },
    warn: (fields, message) => {
      entries.push({ level: 'warn', fields, message });
    },
    error: (fields, message) => {
      entries.push({ level: 'error', fields, message });
    },
  };
}

async function sourcePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 100]);
  return pdf.save();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Harness {
  readonly bus: EventBus;
  readonly outbox: MemoryOutbox;
  readonly repository: MemoryJobRepository;
  readonly jobs: JobService;
  readonly output: FakePrintOutput;
  readonly ledger: PrintSubmissionLedger;
  readonly log: LogEntry[];
  readonly blobPath: (storageKey: string) => string;
  /** Set once `start` ran; `undefined` while routing is off. */
  route: PrintAutoRoute | undefined;
}

describe('print auto-route (Spec 034b)', () => {
  let dataDir: string | undefined;
  let h: Harness | undefined;

  afterEach(async () => {
    h?.route?.stop();
    await h?.route?.idle();
    h = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  async function createHarness(): Promise<Harness> {
    dataDir = await mkdtemp(join(tmpdir(), 'bps-034b-'));
    const blobsDir = join(dataDir, 'blobs');
    const time = fakeClock('2026-03-01T08:00:00.000Z');
    const outbox = new MemoryOutbox();
    const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
    const repository = new MemoryJobRepository();
    const blobs = new LocalDirStorage(blobsDir);
    const jobs = new JobService({ jobs: repository, blobs, bus, clock: time.clock, newId: sequentialIds('job') });
    return {
      bus,
      outbox,
      repository,
      jobs,
      output: new FakePrintOutput(),
      ledger: new PrintSubmissionLedger(),
      log: [],
      blobPath: (storageKey) => resolve(blobsDir, ...storageKey.split('/')),
      route: undefined,
    };
  }

  /** Starts routing the way `registerPrintOutputRoutes` does with `autoRoute` set. */
  function start(harness: Harness): PrintAutoRoute {
    harness.route = startPrintAutoRoute({
      bus: harness.bus,
      jobs: harness.repository,
      output: harness.output,
      blobPath: harness.blobPath,
      ledger: harness.ledger,
      log: recordingLog(harness.log),
      history: harness.jobs,
    });
    return harness.route;
  }

  async function readyJob(harness: Harness, bytes: Uint8Array, hotFolderId?: string): Promise<string> {
    const job = await harness.jobs.create({
      name: 'Poster',
      sources: [{ name: 'poster.pdf', bytes }],
      ticket: TICKET,
      ...(hotFolderId === undefined ? {} : { hotFolderId }),
    });
    await harness.jobs.setStatus(job.id, 'inspecting');
    await harness.jobs.setStatus(job.id, 'ready');
    return job.id;
  }

  function failedSteps(harness: Harness): readonly unknown[] {
    return harness.outbox
      .list()
      .map((record) => record.event)
      .filter((event) => event.type === EventTypes.stepFailed)
      .map((event) => event.data);
  }

  describe('BPS_PRINT_AUTO_ROUTE', () => {
    it('is off when unset, whatever BPS_PRINT_OUTPUT says', () => {
      expect(parsePrintAutoRouteFlag({})).toBe(false);
      expect(parsePrintAutoRouteFlag({ BPS_PRINT_OUTPUT: '1' })).toBe(false);
    });

    it('is on for 1 with BPS_PRINT_OUTPUT=1', () => {
      expect(parsePrintAutoRouteFlag({ BPS_PRINT_AUTO_ROUTE: '1', BPS_PRINT_OUTPUT: '1' })).toBe(true);
    });

    it.each(['0', 'true', 'yes', '', ' 1'])('stops startup for %j', (value) => {
      expect(() => parsePrintAutoRouteFlag({ BPS_PRINT_AUTO_ROUTE: value, BPS_PRINT_OUTPUT: '1' })).toThrow(
        /BPS_PRINT_AUTO_ROUTE must be 1 or unset/,
      );
    });

    it.each([{}, { BPS_PRINT_OUTPUT: '0' }])('stops startup for 1 without BPS_PRINT_OUTPUT=1 (%j)', (env) => {
      expect(() => parsePrintAutoRouteFlag({ BPS_PRINT_AUTO_ROUTE: '1', ...env })).toThrow(/BPS_PRINT_OUTPUT/);
    });
  });

  it('submits nothing on a ready event when the flag is absent', async () => {
    const harness = await createHarness();
    h = harness;
    // main.ts wiring: no autoRoute without the flag, so nothing subscribes.
    const archive = new ArchiveService({
      jobs: harness.repository,
      index: new MemoryArchiveIndex(),
      blobs: new LocalDirStorage(join(dataDir ?? tmpdir(), 'blobs')),
      archive: new MemoryStorage(),
      bus: harness.bus,
      outbox: harness.outbox,
      colorSetups: new StaticColorSetupResolver(),
      newId: sequentialIds('pkg'),
    });
    const isOn = parsePrintAutoRouteFlag({ BPS_PRINT_OUTPUT: '1' });
    const app = buildServer({
      archive,
      jobs: harness.repository,
      printOutput: {
        output: harness.output,
        blobPath: harness.blobPath,
        ...(isOn ? { autoRoute: { bus: harness.bus, history: harness.jobs } } : {}),
      },
    });
    await app.ready();

    await readyJob(harness, await sourcePdf());
    await app.close();

    expect(harness.output.submitted).toEqual([]);
  });

  it('submits a job that becomes ready once, with the deterministic submission id', async () => {
    const harness = await createHarness();
    h = harness;
    const route = start(harness);
    const pdf = await sourcePdf();

    const jobId = await readyJob(harness, pdf);
    await route.idle();

    const expectedId = autoRouteSubmissionId(jobId, sha256Hex(pdf));
    expect(expectedId).toMatch(UUID);
    expect(harness.output.submitted).toHaveLength(1);
    const [sent] = harness.output.submitted;
    expect(sent?.jobId).toBe(jobId);
    expect(sent?.format).toBe('pdf');
    expect(sent?.submissionId).toBe(expectedId);
    expect(sent !== undefined && Buffer.from(pdf).equals(sent.bytes)).toBe(true);
    expect(harness.ledger.belongsTo(expectedId, jobId)).toBe(true);
    expect(harness.ledger.belongsTo(expectedId, 'other-job')).toBe(false);
  });

  it('derives the same submission id for the same job and document only', () => {
    const doc = sha256Hex(new TextEncoder().encode('document'));
    const other = sha256Hex(new TextEncoder().encode('other document'));

    expect(autoRouteSubmissionId('job-1', doc)).toBe(autoRouteSubmissionId('job-1', doc));
    expect(autoRouteSubmissionId('job-1', doc)).not.toBe(autoRouteSubmissionId('job-2', doc));
    expect(autoRouteSubmissionId('job-1', doc)).not.toBe(autoRouteSubmissionId('job-1', other));
  });

  it('submits once when the same ready event arrives twice, or a second one for the same job and document', async () => {
    const harness = await createHarness();
    h = harness;
    const route = start(harness);
    const jobId = await readyJob(harness, await sourcePdf());
    // The job's last status change is the one to ready.
    const event = harness.outbox
      .list()
      .map((record) => record.event)
      .findLast((candidate) => candidate.type === EventTypes.jobStatusChanged && candidate.subject === jobId);

    // The same event redelivered, plus a fresh ready event for the job, published concurrently.
    harness.bus.publish(jobStatusChangedEvent('/bps/jobs', jobId, 'inspecting', 'ready'));
    harness.bus.publish(jobStatusChangedEvent('/bps/jobs', jobId, 'inspecting', 'ready'));
    await route.idle();
    expect(event?.data).toMatchObject({ to: 'ready' });
    if (event) harness.bus.publish(event);
    await route.idle();

    expect(harness.output.submitted).toHaveLength(1);
  });

  it('routes nothing for status changes other than to ready', async () => {
    const harness = await createHarness();
    h = harness;
    const route = start(harness);
    const job = await harness.jobs.create({ name: 'Poster', sources: [{ name: 'poster.pdf', bytes: await sourcePdf() }], ticket: TICKET });

    await harness.jobs.setStatus(job.id, 'inspecting');
    await route.idle();

    expect(harness.output.submitted).toEqual([]);
  });

  it('skips a job the driver takes no such document for with one log line, and does not retry', async () => {
    const harness = await createHarness();
    h = harness;
    const route = start(harness);
    harness.output.error = new PrintOutputError('DOCUMENT_INPUT_UNSUPPORTED', 'the device takes bands only');

    const jobId = await readyJob(harness, await sourcePdf());
    await route.idle();
    harness.output.error = undefined;
    harness.bus.publish(jobStatusChangedEvent('/bps/jobs', jobId, 'inspecting', 'ready'));
    await route.idle();

    expect(harness.output.submitted).toEqual([]);
    expect(harness.log).toEqual([
      { level: 'info', fields: { jobId, code: 'DOCUMENT_INPUT_UNSUPPORTED' }, message: expect.stringContaining('skipped') },
    ]);
    expect(failedSteps(harness)).toEqual([]);
  });

  it('logs and records a failed submission without retrying it, and logs no document bytes', async () => {
    const harness = await createHarness();
    h = harness;
    const route = start(harness);
    harness.output.error = new PrintOutputError('OUTPUT_EXISTS', 'output /secret/dir/job.pdf already exists');
    const pdf = await sourcePdf();

    const jobId = await readyJob(harness, pdf);
    await route.idle();
    harness.output.error = undefined;
    harness.bus.publish(jobStatusChangedEvent('/bps/jobs', jobId, 'inspecting', 'ready'));
    await route.idle();

    const submissionId = autoRouteSubmissionId(jobId, sha256Hex(pdf));
    expect(harness.output.submitted).toEqual([]);
    expect(harness.log).toEqual([
      { level: 'error', fields: { jobId, submissionId, code: 'OUTPUT_EXISTS' }, message: expect.stringContaining('not retried') },
    ]);
    expect(JSON.stringify(harness.log)).not.toContain('/secret/dir');
    expect(failedSteps(harness)).toEqual([
      { jobId, stage: PRINT_AUTO_ROUTE_STAGE, details: { jobId, submissionId, code: 'OUTPUT_EXISTS' } },
    ]);
  });

  it('routes a hot-folder job that becomes ready the same way', async () => {
    const harness = await createHarness();
    h = harness;
    const route = start(harness);
    const pdf = await sourcePdf();
    const job = await harness.jobs.create({ name: 'Drop', sources: [{ name: 'drop.pdf', bytes: pdf }], ticket: TICKET, hotFolderId: 'hf-1' });

    // Hot folder intake publishes its own status changes under its source.
    harness.bus.publish(jobStatusChangedEvent(HOTFOLDER_SOURCE, job.id, 'received', 'inspecting'));
    harness.bus.publish(jobStatusChangedEvent(HOTFOLDER_SOURCE, job.id, 'inspecting', 'ready'));
    await route.idle();

    expect(harness.output.submitted).toEqual([
      expect.objectContaining({ jobId: job.id, format: 'pdf', submissionId: autoRouteSubmissionId(job.id, sha256Hex(pdf)) }),
    ]);
  });

  it('stops routing once stopped', async () => {
    const harness = await createHarness();
    h = harness;
    const route = start(harness);
    route.stop();

    await readyJob(harness, await sourcePdf());
    await route.idle();

    expect(harness.output.submitted).toEqual([]);
  });
});
