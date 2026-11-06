import {
  isJobStatus,
  isPrinterDriver,
  type AuditEntry,
  type Device,
  type HotFolder,
  type Job,
  type JobError,
  type JobPage,
  type JobRecord,
  type JobStatus,
  type JobStep,
  type Page,
  type Plugin,
  type Problem,
  type Transitions,
} from '../src/api/types';
import type { components } from '../src/api/schema';
import { createEventBus } from './events';
import {
  DEFAULT_INGEST_PAGE,
  fakeSha256,
  indexPages,
  PLUGIN_IDS,
  seedDevices,
  seedHotFolders,
  seedJobs,
  seedPlugins,
} from './fixtures';
import { buildFixturePdf } from './pdf';
import { allowedTransitions, canTransition } from './transitions';

/**
 * In-memory implementation of the control-plane API used by the MSW handlers. It follows the
 * documented behavior (validation, state machine, cursor paging, events) closely enough to drive
 * the dashboard, but is not the server: no files are read or written.
 */

type FieldError = NonNullable<Problem['errors']>[number];
type HotFolderSettings = HotFolder['settings'];

export class MockProblem extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly errors: FieldError[];

  constructor(status: number, title: string, detail: string, errors: FieldError[] = []) {
    super(detail);
    this.name = 'MockProblem';
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.errors = errors;
  }

  toProblem(): Problem {
    return {
      type: 'about:blank',
      title: this.title,
      status: this.status,
      detail: this.detail,
      ...(this.errors.length ? { errors: this.errors } : {}),
    };
  }
}

/**
 * The server's Error schema with the object form of `details` kept open: openapi-typescript renders
 * a bare `type: object` as Record<string, never>, which no real details value fits.
 */
interface ErrorEnvelope {
  error: Omit<components['schemas']['Error']['error'], 'details'> & { details?: Record<string, unknown> };
}

/** A failure the job intake endpoints report as `{error: {code, message, details?}}` (Spec 052a). */
export class MockJobError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MockJobError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): ErrorEnvelope {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

const PDF_MAGIC = '%PDF-';

function isPdf(bytes: Uint8Array): boolean {
  return [...PDF_MAGIC].every((ch, i) => bytes[i] === ch.charCodeAt(0));
}

const notFound = (what: string) => new MockProblem(404, 'Not Found', `${what} was not found.`);
const invalid = (detail: string, errors: FieldError[] = []) => new MockProblem(400, 'Bad Request', detail, errors);
const conflict = (detail: string) => new MockProblem(409, 'Conflict', detail);

export interface MockDbOptions {
  /** Delay before a job sent to a device is delivered. */
  outputDelayMs?: number;
  /** Delay between the received → inspecting → ready steps of a newly ingested job. */
  pipelineDelayMs?: number;
  now?: () => Date;
  /** Start with the fixture data (default true). */
  seed?: boolean;
  /** Largest body POST /jobs accepts before answering 413 (Spec 052a). */
  uploadMaxBytes?: number;
}

export interface UploadInput {
  bytes: Uint8Array;
  /** The x-bps-job-name header; the mock picks a name when absent or blank. */
  name?: string | null;
}

/** What differs between a hot-folder job and an uploaded one when it is first received. */
interface ReceivedFields {
  name: string;
  sourcePath: string | null;
  sizeBytes: number;
  priority: number;
  hotFolderId: string | null;
  deviceId: string | null;
  createdMessage: string;
}

export interface IngestInput {
  hotFolderId: string;
  name?: string;
  pages?: Omit<Page, 'index'>[];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_FILE_NAME_PATTERN = '{jobName}_{jobId}.pdf';
const MAX_FILE_NAME_LENGTH = 150;
const INGEST_BYTES_PER_PAGE = 2_400_000;
const DEFAULT_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
const SENDABLE: readonly JobStatus[] = ['ready', 'held', 'queued'];
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
const FORBIDDEN_FILE_NAME_CHARS = '<>:"/\\|?*';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const DEFAULT_SETTINGS: HotFolderSettings = {
  moveProcessedTo: null,
  defaultPriority: 50,
  filePatterns: ['*.pdf'],
  dedupe: true,
  ticketTemplate: null,
  defaultDeviceId: null,
};

export function newUlid(timeMs: number): string {
  let time = '';
  let rest = timeMs;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  let random = '';
  for (let i = 0; i < 16; i += 1) random += CROCKFORD[Math.floor(Math.random() * 32)];
  return time + random;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPriority(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

export function isAbsolutePath(path: string): boolean {
  return ABSOLUTE_PATH.test(path);
}

function normalizePath(path: string): string {
  return path.trim().replace(/[\\/]+$/, '');
}

function baseName(path: string): string {
  const parts = normalizePath(path).split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function joinPath(dir: string, name: string): string {
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${normalizePath(dir)}${separator}${name}`;
}

/** Same rules as the handoff plugin (Spec 002 Part C): strip reserved and control characters. */
export function sanitizeFileName(name: string): string {
  const kept = [...name].filter((ch) => ch.charCodeAt(0) >= 32 && !FORBIDDEN_FILE_NAME_CHARS.includes(ch));
  return kept.join('').replace(/[. ]+$/, '').slice(0, MAX_FILE_NAME_LENGTH);
}

const encodeCursor = (offset: number) => btoa(`offset:${offset}`);

function decodeCursor(cursor: string): number {
  try {
    const match = /^offset:(\d+)$/.exec(atob(cursor));
    if (match) return Number(match[1]);
  } catch {
    // Not base64: fall through to the validation error.
  }
  throw new MockJobError(400, 'invalid_request', '`cursor` is not one this route issued');
}

/** The 052a list order: newest first, ties by id descending. */
function newestFirst(a: JobRecord, b: JobRecord): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/** Name of the stored source file, as the server derives `intakeFile` (never the client's path). */
function sourceFileName(record: JobRecord): string {
  return record.sourcePath ? baseName(record.sourcePath) : `upload-${record.id.slice(-6).toLowerCase()}.pdf`;
}

/**
 * Projects the mock's internal record onto the job GET /jobs and GET /jobs/:id answer (Spec 052a),
 * in the shape of tests/fixtures/server-052a-responses.json.
 */
export function toJob(record: JobRecord, displayName?: string): Job {
  const fileName = sourceFileName(record);
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    sourceFormat: 'pdf',
    priority: record.priority,
    sourceFiles: [
      { name: fileName, sha256: record.sha256, sizeBytes: record.sizeBytes, storageKey: `jobs/${record.id}/source/0-${fileName}` },
    ],
    artifacts: [],
    ticket: {},
    tags: [],
    metadata: { intakeFile: fileName, ...(displayName === undefined ? {} : { displayName }) },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lifecycle: 'active',
    legalHold: false,
  };
}

interface SchemaProperty {
  type?: string;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  default?: unknown;
}

interface ObjectSchema {
  properties?: Record<string, SchemaProperty>;
  required?: readonly string[];
}

function asObjectSchema(value: unknown): ObjectSchema {
  return isRecord(value) ? (value as ObjectSchema) : {};
}

/** Minimal JSON Schema check for device config; errors use `config.<key>` field paths. */
function validateConfig(schemaValue: unknown, config: Record<string, unknown>): FieldError[] {
  const schema = asObjectSchema(schemaValue);
  const errors: FieldError[] = [];
  const field = (key: string) => `config.${key}`;
  for (const key of schema.required ?? []) {
    const value = config[key];
    if (value === undefined || value === null || value === '') errors.push({ field: field(key), message: 'This field is required.' });
  }
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const value = config[key];
    if (value === undefined || value === null || value === '') continue;
    if (property.enum && !property.enum.includes(value)) {
      errors.push({ field: field(key), message: 'Choose one of the listed options.' });
    } else if (property.type === 'string') {
      if (typeof value !== 'string') errors.push({ field: field(key), message: 'Enter text.' });
      else if (property.pattern && !new RegExp(property.pattern).test(value)) {
        errors.push({ field: field(key), message: 'Enter an absolute path on the server.' });
      }
    } else if (property.type === 'boolean' && typeof value !== 'boolean') {
      errors.push({ field: field(key), message: 'Must be true or false.' });
    } else if (property.type === 'number' || property.type === 'integer') {
      const isNumber = typeof value === 'number' && (property.type === 'number' || Number.isInteger(value));
      if (!isNumber) errors.push({ field: field(key), message: 'Enter a number.' });
      else if (property.minimum !== undefined && value < property.minimum) errors.push({ field: field(key), message: `Must be at least ${property.minimum}.` });
      else if (property.maximum !== undefined && value > property.maximum) errors.push({ field: field(key), message: `Must be at most ${property.maximum}.` });
    }
  }
  return errors;
}

function configWithDefaults(schemaValue: unknown, config: Record<string, unknown>): Record<string, unknown> {
  const defaults = Object.entries(asObjectSchema(schemaValue).properties ?? {})
    .filter(([, property]) => property.default !== undefined)
    .map(([key, property]) => [key, property.default] as const);
  return { ...Object.fromEntries(defaults), ...config };
}

export function createMockDb(options: MockDbOptions = {}) {
  const outputDelayMs = options.outputDelayMs ?? 1_500;
  const pipelineDelayMs = options.pipelineDelayMs ?? 1_000;
  const now = options.now ?? (() => new Date());
  const seed = options.seed ?? true;
  const uploadMaxBytes = options.uploadMaxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;

  const events = createEventBus();
  const jobs = new Map<string, JobRecord>(seed ? seedJobs().map((job) => [job.id, job]) : []);
  /** The sanitized x-bps-job-name of an upload that sent one (Spec 052a `metadata.displayName`). */
  const displayNames = new Map<string, string>();
  const hotFolders = new Map<string, HotFolder>(seed ? seedHotFolders().map((f) => [f.id, f]) : []);
  const devices = new Map<string, Device>(seed ? seedDevices().map((d) => [d.id, d]) : []);
  const plugins: Plugin[] = seedPlugins();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let auditSequence = 0;

  const iso = () => now().toISOString();

  function schedule(task: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        task();
      } catch (error) {
        // The job changed meanwhile (e.g. cancelled); the pipeline step simply stops.
        if (!(error instanceof MockProblem)) throw error;
      }
    }, delayMs);
    timers.add(timer);
  }

  function auditEntry(jobId: string, time: string, type: string, message: string, data: Record<string, unknown> | null = null): AuditEntry {
    auditSequence += 1;
    return { id: `${jobId}-m${auditSequence}`, time, type, message, data };
  }

  function save(job: JobRecord): JobRecord {
    jobs.set(job.id, job);
    return job;
  }

  function requireJob(id: string): JobRecord {
    const job = jobs.get(id);
    if (!job) throw notFound(`Job ${id}`);
    return job;
  }

  function view(record: JobRecord): Job {
    return toJob(record, displayNames.get(record.id));
  }

  function withStep(job: JobRecord, stepId: string, patch: Partial<JobStep>): JobRecord {
    return { ...job, steps: job.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) };
  }

  function addStep(job: JobRecord, stage: string, pluginId: string | null): { job: JobRecord; step: JobStep } {
    const step: JobStep = {
      id: `${job.id}-${stage}-${job.steps.filter((s) => s.stage === stage).length + 1}`,
      stage,
      status: 'running',
      pluginId,
      startedAt: iso(),
      finishedAt: null,
      error: null,
      result: null,
    };
    return { job: { ...job, steps: [...job.steps, step] }, step };
  }

  /** Moves a job along the state machine, records it in the audit and emits the event. */
  function transition(job: JobRecord, to: JobStatus, extra: Partial<JobRecord> = {}): JobRecord {
    if (!canTransition(job.status, to)) throw conflict(`A ${job.status} job cannot move to ${to}.`);
    const time = iso();
    const entry = auditEntry(job.id, time, 'status.changed', `Status changed from ${job.status} to ${to}.`, { from: job.status, to });
    const next = save({ ...job, ...extra, status: to, updatedAt: time, audit: [...(job.audit ?? []), entry] });
    events.publish('job.status.changed', job.id, { jobId: job.id, from: job.status, to, job: next }, time);
    return next;
  }

  function startOutput(job: JobRecord, device: Device): JobRecord {
    const { job: withOutput, step } = addStep(job, 'output', device.pluginId);
    const next = transition(withOutput, 'processing');
    events.publish('step.started', job.id, { jobId: job.id, stepId: step.id, stage: 'output' }, next.updatedAt);
    schedule(() => finishOutput(job.id, step.id, device.id), outputDelayMs);
    return next;
  }

  function finishOutput(jobId: string, stepId: string, deviceId: string): void {
    const job = jobs.get(jobId);
    if (!job || job.status !== 'processing') return;
    const device = devices.get(deviceId);
    const time = iso();
    const targetDir = typeof device?.config.targetDir === 'string' ? device.config.targetDir : '';

    if (!device || device.status.state === 'offline' || !targetDir) {
      const error: JobError = {
        code: 'DELIVERY_FAILED',
        message: 'The target folder is not writable.',
        detail: device?.status.reason ?? null,
      };
      const failed = withStep(job, stepId, { status: 'failed', finishedAt: time, error });
      events.publish('step.failed', jobId, { jobId, stepId, stage: 'output', error }, time);
      transition(failed, 'failed', { error });
      return;
    }

    const pattern = typeof device.config.fileNamePattern === 'string' && device.config.fileNamePattern
      ? device.config.fileNamePattern
      : DEFAULT_FILE_NAME_PATTERN;
    const fileName = sanitizeFileName(pattern.replaceAll('{jobName}', job.name).replaceAll('{jobId}', job.id));
    const deliveredPath = joinPath(targetDir, fileName);
    const result = { deliveredPath, bytes: job.sizeBytes, sha256: job.sha256, time };
    const delivered = withStep(job, stepId, { status: 'completed', finishedAt: time, result });
    const record = auditEntry(jobId, time, 'delivery', `Delivered to ${deliveredPath}.`, { deviceId, ...result });
    events.publish('step.completed', jobId, { jobId, stepId, stage: 'output', result }, time);
    transition({ ...delivered, audit: [...(delivered.audit ?? []), record] }, 'sent_to_device');
  }

  function advanceToInspecting(jobId: string, pages: Page[]): void {
    const job = jobs.get(jobId);
    if (!job || job.status !== 'received') return;
    const { job: withInspect, step } = addStep(job, 'inspect', PLUGIN_IDS.inspector);
    transition(withInspect, 'inspecting');
    events.publish('step.started', jobId, { jobId, stepId: step.id, stage: 'inspect' }, iso());
    schedule(() => finishInspect(jobId, step.id, pages), pipelineDelayMs);
  }

  function finishInspect(jobId: string, stepId: string, pages: Page[]): void {
    const job = jobs.get(jobId);
    if (!job || job.status !== 'inspecting') return;
    const time = iso();
    const inspected = withStep(job, stepId, { status: 'completed', finishedAt: time });
    events.publish('step.completed', jobId, { jobId, stepId, stage: 'inspect' }, time);
    const ready = transition(inspected, 'ready', { pages, pageCount: pages.length });
    // Hot-folder → device routing with auto-dispatch (Spec 002 "Auto-dispatch").
    const device = ready.deviceId ? devices.get(ready.deviceId) : undefined;
    if (device?.autoDispatch) startOutput(transition(ready, 'queued'), device);
  }

  /** Stores a new `received` job, emits job.created and starts the simulated pipeline. */
  function receive(pages: Page[], fields: (id: string) => ReceivedFields): JobRecord {
    const time = iso();
    const id = newUlid(now().getTime());
    const { createdMessage, ...rest } = fields(id);
    const job: JobRecord = {
      id,
      ...rest,
      storedPath: `spool/${id}.pdf`,
      sha256: fakeSha256(id),
      pageCount: 0,
      pages: [],
      status: 'received',
      ticketId: null,
      steps: [
        { id: `${id}-intake-1`, stage: 'intake', status: 'completed', pluginId: null, startedAt: time, finishedAt: time, error: null, result: null },
      ],
      audit: [auditEntry(id, time, 'job.created', createdMessage)],
      createdAt: time,
      updatedAt: time,
      error: null,
    };
    save(job);
    events.publish('job.created', id, { jobId: id, job }, time);
    schedule(() => advanceToInspecting(id, pages), pipelineDelayMs);
    return job;
  }

  function validateSettings(input: unknown, errors: FieldError[]): Partial<HotFolderSettings> {
    if (input === undefined) return {};
    if (!isRecord(input)) {
      errors.push({ field: 'settings', message: 'Settings must be an object.' });
      return {};
    }
    const out: Partial<HotFolderSettings> = {};
    if (input.defaultPriority !== undefined) {
      if (isPriority(input.defaultPriority)) out.defaultPriority = input.defaultPriority;
      else errors.push({ field: 'settings.defaultPriority', message: 'Enter a whole number from 0 to 100.' });
    }
    if (input.filePatterns !== undefined) {
      const patterns = input.filePatterns;
      const valid = Array.isArray(patterns) && patterns.length > 0 && patterns.every((p) => typeof p === 'string' && p.trim() !== '');
      if (valid) out.filePatterns = patterns.map((p: string) => p.trim());
      else errors.push({ field: 'settings.filePatterns', message: 'Enter at least one file pattern, for example *.pdf.' });
    }
    if (input.dedupe !== undefined) {
      if (typeof input.dedupe === 'boolean') out.dedupe = input.dedupe;
      else errors.push({ field: 'settings.dedupe', message: 'Must be true or false.' });
    }
    if (input.moveProcessedTo !== undefined) {
      const target = input.moveProcessedTo;
      if (target === null || target === '') out.moveProcessedTo = null;
      else if (typeof target === 'string' && isAbsolutePath(target)) out.moveProcessedTo = target;
      else errors.push({ field: 'settings.moveProcessedTo', message: 'Enter an absolute path, or leave it empty.' });
    }
    if (input.defaultDeviceId !== undefined) {
      const deviceId = input.defaultDeviceId;
      if (deviceId === null || deviceId === '') out.defaultDeviceId = null;
      else if (typeof deviceId === 'string' && devices.has(deviceId)) out.defaultDeviceId = deviceId;
      else errors.push({ field: 'settings.defaultDeviceId', message: 'This device does not exist.' });
    }
    return out;
  }

  function validateFolderPath(path: unknown, errors: FieldError[]): string {
    const message = (() => {
      if (typeof path !== 'string' || path.trim() === '') return 'Enter the folder path.';
      if (!isAbsolutePath(path.trim())) return 'The path must be absolute on the server.';
      if (path.split(/[\\/]/).includes('..')) return 'The path must not contain "..".';
      const normalized = normalizePath(path);
      if ([...hotFolders.values()].some((f) => normalizePath(f.path) === normalized)) return 'This folder is already watched.';
      return null;
    })();
    if (message) errors.push({ field: 'path', message });
    return typeof path === 'string' ? normalizePath(path) : '';
  }

  function probeDevice(plugin: Plugin | undefined, config: Record<string, unknown>): Device['status'] {
    const checkedAt = iso();
    const accepts = plugin?.capabilities?.accepts;
    if (!Array.isArray(accepts) || !accepts.includes('document')) return { state: 'ready', reason: null, checkedAt };
    const targetDir = typeof config.targetDir === 'string' ? config.targetDir : '';
    if (!targetDir) return { state: 'offline', reason: 'No target folder is configured.', checkedAt };
    // Lets the mock demonstrate the offline state: any path segment named "readonly".
    if (/(^|[\\/])readonly([\\/]|$)/i.test(targetDir)) return { state: 'offline', reason: 'The target folder is not writable.', checkedAt };
    return { state: 'ready', reason: null, checkedAt };
  }

  function validateDeviceFields(body: Record<string, unknown>, errors: FieldError[], plugin: Plugin | undefined): void {
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
      errors.push({ field: 'name', message: 'Enter a device name.' });
    }
    if (body.config !== undefined && !isRecord(body.config)) errors.push({ field: 'config', message: 'Config must be an object.' });
    if (body.autoDispatch !== undefined && typeof body.autoDispatch !== 'boolean') {
      errors.push({ field: 'autoDispatch', message: 'Must be true or false.' });
    }
    if (body.maxConcurrency !== undefined && !(Number.isInteger(body.maxConcurrency) && (body.maxConcurrency as number) >= 1)) {
      errors.push({ field: 'maxConcurrency', message: 'Enter a whole number of at least 1.' });
    }
    if (plugin && isRecord(body.config)) errors.push(...validateConfig(plugin.configSchema, body.config));
  }

  return {
    events,

    health: () => ({ status: 'ok' as const, version: '0.2.0-mock' }),

    /**
     * GET /jobs (Spec 052a): only `limit` and `cursor`, newest first. Other query parameters are
     * ignored, a limit above 200 is capped, and nextCursor is null on the last page.
     */
    listJobs(query: URLSearchParams): JobPage {
      const limitParam = query.get('limit');
      const requested = limitParam === null ? DEFAULT_LIMIT : Number(limitParam);
      if (!Number.isInteger(requested) || requested < 1) {
        throw new MockJobError(400, 'invalid_request', '`limit` must be a positive integer');
      }
      const limit = Math.min(requested, MAX_LIMIT);
      const cursor = query.get('cursor');
      const offset = cursor ? decodeCursor(cursor) : 0;
      const matches = [...jobs.values()].sort(newestFirst);
      const end = offset + limit;
      return {
        items: matches.slice(offset, end).map(view),
        nextCursor: end < matches.length ? encodeCursor(end) : null,
      };
    },

    /** The internal record (mock routes, events and tests). */
    getJob: requireJob,

    /** GET /jobs/:id (Spec 052a): the job as the server answers it, or 404 `not_found`. */
    readJob(id: string): Job {
      const record = jobs.get(id);
      if (!record) throw new MockJobError(404, 'not_found', `Job ${id} not found`);
      return view(record);
    },

    getTransitions(id: string): Transitions {
      const job = requireJob(id);
      return { status: job.status, allowed: allowedTransitions(job.status) };
    },

    patchJob(id: string, body: unknown): JobRecord {
      const job = requireJob(id);
      if (!isRecord(body)) throw invalid('The request body must be a JSON object.');
      const keys = Object.keys(body);
      const unknownKeys = keys.filter((key) => key !== 'status' && key !== 'priority');
      const errors: FieldError[] = unknownKeys.map((key) => ({ field: key, message: 'Unknown field.' }));
      if (!keys.length) errors.push({ field: 'status', message: 'Send a status and/or a priority.' });
      if (body.priority !== undefined && !isPriority(body.priority)) {
        errors.push({ field: 'priority', message: 'Priority must be a whole number from 0 to 100.' });
      }
      if (body.status !== undefined && !isJobStatus(body.status)) errors.push({ field: 'status', message: 'Unknown status.' });
      if (errors.length) throw invalid('Validation failed.', errors);

      const status = body.status as JobStatus | undefined;
      const priority = body.priority as number | undefined;
      if (status !== undefined && status !== job.status && !canTransition(job.status, status)) {
        throw conflict(`A ${job.status} job cannot move to ${status}.`);
      }
      let next = job;
      if (priority !== undefined && priority !== job.priority) {
        const time = iso();
        const entry = auditEntry(job.id, time, 'priority.changed', `Priority changed from ${job.priority} to ${priority}.`, { from: job.priority, to: priority });
        next = save({ ...next, priority, updatedAt: time, audit: [...(next.audit ?? []), entry] });
      }
      if (status !== undefined && status !== job.status) next = transition(next, status);
      return next;
    },

    printJob(id: string, body: unknown): JobRecord {
      const job = requireJob(id);
      const deviceId = isRecord(body) ? body.deviceId : undefined;
      if (typeof deviceId !== 'string' || deviceId === '') {
        throw invalid('A device is required.', [{ field: 'deviceId', message: 'Choose a device.' }]);
      }
      const device = devices.get(deviceId);
      if (!device) throw invalid('Unknown device.', [{ field: 'deviceId', message: 'This device does not exist.' }]);
      if (!SENDABLE.includes(job.status)) throw conflict(`A ${job.status} job cannot be sent to a device.`);
      const queued = job.status === 'queued' ? save({ ...job, deviceId }) : transition(job, 'queued', { deviceId });
      return startOutput(queued, device);
    },

    jobFile(id: string): Uint8Array {
      return buildFixturePdf(requireJob(id).pages);
    },

    listHotFolders: (): HotFolder[] => [...hotFolders.values()],

    createHotFolder(body: unknown): HotFolder {
      if (!isRecord(body)) throw invalid('The request body must be a JSON object.');
      const errors: FieldError[] = [];
      const path = validateFolderPath(body.path, errors);
      if (body.name !== undefined && typeof body.name !== 'string') errors.push({ field: 'name', message: 'Enter text.' });
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') errors.push({ field: 'enabled', message: 'Must be true or false.' });
      const settings = validateSettings(body.settings, errors);
      if (errors.length) throw invalid('The hot folder could not be added.', errors);
      const time = iso();
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : baseName(path);
      const folder: HotFolder = {
        id: `hf-${newUlid(now().getTime()).toLowerCase()}`,
        name,
        path,
        enabled: body.enabled !== false,
        settings: { ...DEFAULT_SETTINGS, ...settings },
        createdAt: time,
        updatedAt: time,
      };
      hotFolders.set(folder.id, folder);
      return folder;
    },

    patchHotFolder(id: string, body: unknown): HotFolder {
      const folder = hotFolders.get(id);
      if (!folder) throw notFound(`Hot folder ${id}`);
      if (!isRecord(body)) throw invalid('The request body must be a JSON object.');
      const errors: FieldError[] = [];
      if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
        errors.push({ field: 'name', message: 'Enter a name.' });
      }
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') errors.push({ field: 'enabled', message: 'Must be true or false.' });
      const settings = validateSettings(body.settings, errors);
      if (errors.length) throw invalid('The hot folder could not be updated.', errors);
      const next: HotFolder = {
        ...folder,
        name: typeof body.name === 'string' ? body.name.trim() : folder.name,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : folder.enabled,
        settings: { ...folder.settings, ...settings },
        updatedAt: iso(),
      };
      hotFolders.set(id, next);
      return next;
    },

    /** Stops watching. Files on disk are never touched; existing jobs keep their hotFolderId. */
    deleteHotFolder(id: string): void {
      if (!hotFolders.delete(id)) throw notFound(`Hot folder ${id}`);
    },

    listPlugins: (): Plugin[] => plugins,

    listDevices: (): Device[] => [...devices.values()],

    createDevice(body: unknown): Device {
      if (!isRecord(body)) throw invalid('The request body must be a JSON object.');
      const errors: FieldError[] = [];
      if (typeof body.name !== 'string' || body.name.trim() === '') errors.push({ field: 'name', message: 'Enter a device name.' });
      if (body.kind !== 'printer') errors.push({ field: 'kind', message: 'Only printer devices can be added here.' });
      const plugin = plugins.find((p) => p.id === body.pluginId);
      if (!plugin || !isPrinterDriver(plugin)) errors.push({ field: 'pluginId', message: 'Choose an installed printer driver.' });
      const config = isRecord(body.config) ? body.config : {};
      // Name was checked above; a missing config is validated as {} so required keys are reported.
      validateDeviceFields({ ...body, name: undefined, config: body.config ?? config }, errors, plugin);
      if (errors.length) throw invalid('The device could not be added.', errors);
      const time = iso();
      const fullConfig = configWithDefaults(plugin?.configSchema, config);
      const device: Device = {
        id: `dev-${newUlid(now().getTime()).toLowerCase()}`,
        name: (body.name as string).trim(),
        kind: 'printer',
        pluginId: plugin?.id ?? '',
        config: fullConfig,
        autoDispatch: body.autoDispatch === true,
        maxConcurrency: typeof body.maxConcurrency === 'number' ? body.maxConcurrency : 1,
        status: probeDevice(plugin, fullConfig),
        createdAt: time,
        updatedAt: time,
      };
      devices.set(device.id, device);
      return device;
    },

    patchDevice(id: string, body: unknown): Device {
      const device = devices.get(id);
      if (!device) throw notFound(`Device ${id}`);
      if (!isRecord(body)) throw invalid('The request body must be a JSON object.');
      const plugin = plugins.find((p) => p.id === device.pluginId);
      const errors: FieldError[] = [];
      validateDeviceFields(body, errors, plugin);
      if (errors.length) throw invalid('The device could not be updated.', errors);
      const config = isRecord(body.config) ? configWithDefaults(plugin?.configSchema, body.config) : device.config;
      const status = probeDevice(plugin, config);
      const next: Device = {
        ...device,
        name: typeof body.name === 'string' ? body.name.trim() : device.name,
        config,
        autoDispatch: typeof body.autoDispatch === 'boolean' ? body.autoDispatch : device.autoDispatch,
        maxConcurrency: typeof body.maxConcurrency === 'number' ? body.maxConcurrency : device.maxConcurrency,
        status,
        updatedAt: iso(),
      };
      devices.set(id, next);
      if (status.state !== device.status.state) {
        events.publish('device.status', id, { deviceId: id, state: status.state, reason: status.reason }, next.updatedAt);
      }
      return next;
    },

    /**
     * Simulates a file arriving in a hot folder. Returns null when the folder is missing or
     * disabled (a disabled folder ingests nothing).
     */
    ingest(input: IngestInput): JobRecord | null {
      const folder = hotFolders.get(input.hotFolderId);
      if (!folder?.enabled) return null;
      const pages = indexPages(input.pages ?? [DEFAULT_INGEST_PAGE]);
      return receive(pages, (id) => {
        const name = input.name ?? `incoming-${id.slice(-6).toLowerCase()}`;
        return {
          name,
          sourcePath: joinPath(folder.path, `${name}.pdf`),
          sizeBytes: pages.length * INGEST_BYTES_PER_PAGE,
          priority: folder.settings.defaultPriority,
          hotFolderId: folder.id,
          deviceId: folder.settings.defaultDeviceId ?? null,
          createdMessage: `Job created from hot folder ${folder.name}.`,
        };
      });
    },

    /** POST /jobs (Spec 052a): a PDF uploaded through the API rather than through a hot folder. */
    /** POST /jobs answers the new job as GET /jobs/:id does; the record stays internal. */
    upload(input: UploadInput): Job {
      const size = input.bytes.byteLength;
      if (size > uploadMaxBytes) {
        throw new MockJobError(413, 'upload_too_large', `The upload is larger than ${uploadMaxBytes} bytes`, {
          maxBytes: uploadMaxBytes,
        });
      }
      if (!isPdf(input.bytes)) throw new MockJobError(400, 'upload_not_pdf', `The upload does not start with ${PDF_MAGIC}`);
      const displayName = input.name?.trim() || undefined;
      const record = receive(indexPages([DEFAULT_INGEST_PAGE]), (id) => ({
        name: displayName ?? `upload-${id.slice(-6).toLowerCase()}.pdf`,
        sourcePath: null,
        sizeBytes: size,
        priority: DEFAULT_SETTINGS.defaultPriority,
        hotFolderId: null,
        deviceId: null,
        createdMessage: 'Job created from an upload.',
      }));
      if (displayName !== undefined) displayNames.set(record.id, displayName);
      return view(record);
    },

    /** Cancels pending simulated pipeline steps (tests call this between runs). */
    dispose(): void {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

export type MockDb = ReturnType<typeof createMockDb>;
