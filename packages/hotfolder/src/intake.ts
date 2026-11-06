import { copyFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import {
  FAILED_SUBFOLDER,
  isTerminal,
  nextUlid,
  noopLogger,
  sniffSourceFormat,
  systemClock,
  withStatus,
  type Clock,
  type HotFolder,
  type Job,
  type JobError,
  type JobPage,
  type JobStatus,
  type JobStep,
  type Logger,
  type SourceFormatSniffer,
} from '@bax-print/core';
import {
  EventTypes,
  hotFolderFileSkippedEvent,
  jobCreatedEvent,
  jobStatusChangedEvent,
  stepEvent,
  type EventBus,
} from '@bax-print/events';
import { sha256Hex, sourceKey, type JobQueueIndex, type JobRepository, type Storage } from '@bax-print/store';

/** CloudEvents `source` of events published by hot folder intake. */
export const HOTFOLDER_EVENT_SOURCE = '/bps/hotfolder';

/** Plugin id recorded on preflight steps run by the in-process inspector. */
export const BUILTIN_INSPECTOR_ID = 'builtin.inspect';

export interface InspectionResult {
  readonly pageCount: number;
  readonly pages: readonly JobPage[];
}

/** Port for the document inspector that moves a job from `inspecting` to `ready`. */
export interface DocumentInspector {
  inspect(document: { readonly name: string; readonly bytes: Uint8Array }): Promise<InspectionResult>;
}

export interface IntakeDeps {
  readonly jobs: JobRepository & Pick<JobQueueIndex, 'findLiveBySha256'>;
  readonly storage: Storage;
  readonly inspector: DocumentInspector;
  readonly bus?: EventBus;
  readonly logger?: Logger;
  readonly clock?: Clock;
  /**
   * Detects `sourceFormat` from the file's bytes. Defaults to core's `sniffSourceFormat` (PDF and
   * raster). Spec 035b: hosts that take in SVG and DXF pass the inspect package's
   * `sniffJobSourceFormat`, which reads them with the vector header reader.
   */
  readonly sniffSourceFormat?: SourceFormatSniffer;
}

export type IntakeOutcome =
  | { kind: 'ready'; job: Job; movedTo: string | undefined }
  | { kind: 'duplicate'; duplicateOf: Job; movedTo: string | undefined }
  | { kind: 'failed'; job: Job | undefined; error: JobError; movedTo: string | undefined };

/** Where originals go after successful intake (relative settings resolve against the folder). */
export function processedDirOf(folder: HotFolder): string {
  const target = folder.settings.moveProcessedTo;
  return isAbsolute(target) ? target : join(folder.path, target);
}

export function failedDirOf(folder: HotFolder): string {
  return join(folder.path, FAILED_SUBFOLDER);
}

const RETRYABLE_MOVE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MOVE_ATTEMPTS = 5;
const MOVE_RETRY_DELAY_MS = 100;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function freeTarget(dir: string, name: string, tag: string): Promise<string> {
  const direct = join(dir, name);
  if (!(await exists(direct))) {
    return direct;
  }
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const tagged = join(dir, `${stem}-${tag}${extension}`);
  return (await exists(tagged)) ? join(dir, `${stem}-${tag}-${Date.now()}${extension}`) : tagged;
}

/**
 * Moves `source` into `dir`, never overwriting: name clashes get a `-<tag>` suffix. Retries
 * briefly when the file is reported busy (e.g. a virus scanner) and falls back to copy + delete
 * across volumes.
 */
export async function moveIntoFolder(source: string, dir: string, tag: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = await freeTarget(dir, basename(source), tag);
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(source, target);
      return target;
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code);
      if (code === 'EXDEV') {
        await copyFile(source, target);
        await unlink(source);
        return target;
      }
      if (!RETRYABLE_MOVE_CODES.has(code) || attempt >= MOVE_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, MOVE_RETRY_DELAY_MS * attempt));
    }
  }
}

export function toJobError(error: unknown, fallbackCode = 'INTAKE_FAILED'): JobError {
  const code =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : fallbackCode;
  return { code, message: error instanceof Error ? error.message : String(error) };
}

function withStep(job: Job, step: JobStep): Job {
  const steps = job.steps ?? [];
  const known = steps.some((existing) => existing.id === step.id);
  return {
    ...job,
    steps: known ? steps.map((existing) => (existing.id === step.id ? step : existing)) : [...steps, step],
  };
}

/** Persists a job and publishes the matching event. */
class IntakeRecorder {
  constructor(private readonly deps: IntakeDeps) {}

  now(): string {
    return (this.deps.clock ?? systemClock)().toISOString();
  }

  async create(job: Job): Promise<Job> {
    await this.deps.jobs.save(job);
    this.deps.bus?.publish(jobCreatedEvent(HOTFOLDER_EVENT_SOURCE, job));
    return job;
  }

  /** Validated by the core status machine via {@link withStatus}. */
  async transition(job: Job, to: JobStatus, patch: Partial<Job> = {}): Promise<Job> {
    const next = withStatus({ ...job, ...patch }, to, this.now());
    await this.deps.jobs.save(next);
    this.deps.bus?.publish(jobStatusChangedEvent(HOTFOLDER_EVENT_SOURCE, job.id, job.status, to));
    return next;
  }

  async step(
    job: Job,
    step: JobStep,
    type: typeof EventTypes.stepStarted | typeof EventTypes.stepCompleted | typeof EventTypes.stepFailed,
  ): Promise<Job> {
    const next = { ...withStep(job, step), updatedAt: this.now() };
    await this.deps.jobs.save(next);
    this.deps.bus?.publish(stepEvent(HOTFOLDER_EVENT_SOURCE, type, job.id, step));
    return next;
  }
}

/**
 * Ingests one stable file from a hot folder: hash, dedupe, create the job (`received`), copy the
 * bytes into managed storage keyed by job id, inspect (`inspecting` → `ready`), and move the
 * original to `_processed` (or `_failed`). Never throws: failures are returned as outcomes.
 */
export async function ingestFile(path: string, folder: HotFolder, deps: IntakeDeps): Promise<IntakeOutcome> {
  const logger = deps.logger ?? noopLogger;
  const recorder = new IntakeRecorder(deps);
  const name = basename(path);
  let job: Job | undefined;
  let step: JobStep | undefined;
  try {
    const bytes = await readFile(path);
    const sha256 = sha256Hex(bytes);
    if (folder.settings.dedupe) {
      const duplicate = await deps.jobs.findLiveBySha256(folder.id, sha256);
      if (duplicate) {
        deps.bus?.publish(
          hotFolderFileSkippedEvent(HOTFOLDER_EVENT_SOURCE, {
            hotFolderId: folder.id,
            path,
            reason: 'duplicate',
            duplicateOf: duplicate.id,
          }),
        );
        logger.info('duplicate file skipped', { path, duplicateOf: duplicate.id });
        const movedTo = await moveQuietly(path, processedDirOf(folder), `dup-${nextUlid()}`, logger);
        return { kind: 'duplicate', duplicateOf: duplicate, movedTo };
      }
    }

    const createdAt = recorder.now();
    const id = nextUlid(Date.parse(createdAt));
    const storageKey = sourceKey(id, 0, name);
    const template = folder.settings.ticketTemplate;
    const sourceFormat = (deps.sniffSourceFormat ?? sniffSourceFormat)(bytes);
    job = await recorder.create({
      id,
      name,
      status: 'received',
      priority: folder.settings.defaultPriority,
      hotFolderId: folder.id,
      ...(sourceFormat === undefined ? {} : { sourceFormat }),
      sourceFiles: [{ name, sha256, sizeBytes: bytes.byteLength, storageKey }],
      artifacts: [],
      ticket: template ? structuredClone(template) : { intent: { quantity: 1 }, process: {} },
      tags: [],
      metadata: {},
      createdAt,
      updatedAt: createdAt,
      lifecycle: 'active',
      legalHold: false,
    });

    const blob = await deps.storage.put(storageKey, bytes);
    if (blob.sha256 !== sha256) {
      throw Object.assign(new Error('stored copy does not match the intake file'), { code: 'FILE_CHANGED' });
    }
    job = await recorder.transition(job, 'inspecting');

    step = {
      id: nextUlid(),
      stage: 'preflight',
      status: 'running',
      pluginId: BUILTIN_INSPECTOR_ID,
      inputs: [storageKey],
      outputs: [],
      startedAt: recorder.now(),
    };
    job = await recorder.step(job, step, EventTypes.stepStarted);
    const report = await deps.inspector.inspect({ name, bytes });
    step = { ...step, status: 'completed', finishedAt: recorder.now() };
    job = await recorder.step(job, step, EventTypes.stepCompleted);

    job = await recorder.transition(job, 'ready', {
      pageCount: report.pageCount,
      pages: report.pages.map((page) => ({ ...page })),
    });
    const movedTo = await moveQuietly(path, processedDirOf(folder), job.id, logger);
    logger.info('job ready', { jobId: job.id, path, pageCount: report.pageCount });
    return { kind: 'ready', job, movedTo };
  } catch (error) {
    const jobError = toJobError(error);
    logger.warn('intake failed', { path, jobId: job?.id, error: jobError });
    if (job) {
      job = await failJob(recorder, job, step, jobError, logger);
    }
    const movedTo = await moveQuietly(path, failedDirOf(folder), job?.id ?? nextUlid(), logger);
    return { kind: 'failed', job, error: jobError, movedTo };
  }
}

async function failJob(
  recorder: IntakeRecorder,
  job: Job,
  step: JobStep | undefined,
  error: JobError,
  logger: Logger,
): Promise<Job> {
  let current = job;
  try {
    if (step && step.status === 'running') {
      current = await recorder.step(
        current,
        { ...step, status: 'failed', finishedAt: recorder.now(), error },
        EventTypes.stepFailed,
      );
    }
    if (!isTerminal(current.status)) {
      current = await recorder.transition(current, 'failed', { error });
    }
  } catch (failure) {
    logger.error('could not mark job as failed', { jobId: job.id, error: toJobError(failure) });
  }
  return current;
}

async function moveQuietly(
  source: string,
  dir: string,
  tag: string,
  logger: Logger,
): Promise<string | undefined> {
  try {
    return await moveIntoFolder(source, dir, tag);
  } catch (error) {
    logger.error('could not move intake file', { source, dir, error: toJobError(error) });
    return undefined;
  }
}
