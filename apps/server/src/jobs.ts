import { open } from 'node:fs/promises';
import {
  InvalidArgumentError,
  SYSTEM_ACTOR,
  parseTicketEdits,
  systemClock,
  ticketEdits,
  ulid,
  validateAccountingReport,
  withStatus,
  type Actor,
  type ArtifactRole,
  type Clock,
  type DeviceAccountingReport,
  type Job,
  type JobStatus,
  type JobTicket,
  type SourceFile,
  type SourceFormat,
} from '@bax-print/core';
import { applyEdits, type NestItem } from '@bax-print/edits';
import { sniffJobSourceFormat, VECTOR_HEADER_MAX_BYTES } from '@bax-print/inspect';
import { EventTypes, type CloudEvent, type EventBus } from '@bax-print/events';
import { artifactKey, sourceKey, type JobRepository, type Storage } from '@bax-print/store';
import { JobNotFoundError } from '@bax-print/archive';

const JOB_SOURCE = '/bps/jobs';
const DEVICE_SOURCE = '/bps/devices';

export type StepPhase = 'started' | 'progress' | 'completed' | 'failed';

const STEP_TYPES: Readonly<Record<StepPhase, string>> = {
  started: EventTypes.stepStarted,
  progress: EventTypes.stepProgress,
  completed: EventTypes.stepCompleted,
  failed: EventTypes.stepFailed,
};

/**
 * A source file of a new job: its bytes, or (Spec 052c) a whole local file the blob store adopts
 * without the bytes passing through memory. The caller must not use an adopted `path` afterwards.
 */
export type CreateJobSource =
  | { readonly name: string; readonly bytes: Uint8Array }
  | { readonly name: string; readonly path: string };

/** The first bytes of a file, enough for every format sniff (one past the vector header window). */
async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(VECTOR_HEADER_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface CreateJobInput {
  readonly name: string;
  readonly customerRef?: string;
  readonly sources: readonly CreateJobSource[];
  readonly ticket: JobTicket;
  readonly priority?: number;
  readonly hotFolderId?: string;
  readonly deviceId?: string;
  readonly mediumId?: string;
  readonly presetId?: string;
  readonly colorSetupRevisionId?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface JobServiceDeps {
  readonly jobs: JobRepository;
  readonly blobs: Storage;
  readonly bus: EventBus;
  readonly clock?: Clock;
  readonly newId?: () => string;
}

/**
 * Job operations that feed the production history: every state change, step,
 * operator action and device accounting report becomes an outbox event.
 */
export class JobService {
  private readonly clock: Clock;
  private readonly newId: () => string;

  constructor(private readonly deps: JobServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.newId = deps.newId ?? (() => ulid(this.clock().getTime()));
  }

  async get(jobId: string): Promise<Job> {
    const job = await this.deps.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    return job;
  }

  async create(input: CreateJobInput, actor: Actor = SYSTEM_ACTOR): Promise<Job> {
    if (input.name.trim() === '') throw new InvalidArgumentError('a job needs a name');
    if (input.sources.length === 0) throw new InvalidArgumentError('a job needs at least one source file');
    const priority = input.priority ?? 50;
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
      throw new InvalidArgumentError('priority must be an integer from 0 to 100');
    }
    const edits = parseTicketEdits(input.ticket.edits);
    if (!edits.ok) {
      throw new InvalidArgumentError(`ticket.${edits.error.field}: ${edits.error.errors.join('; ')}`);
    }

    const id = this.newId();
    const at = this.clock().toISOString();
    // Spec 031c: submission takes any bytes; the detected format of the first source is recorded.
    // Spec 035b: SVG and DXF are detected from their header, never from the file name.
    // Spec 052c: an adopted file is sniffed from its head, before the store takes it.
    const first = input.sources[0];
    let sourceFormat: SourceFormat | undefined;
    if (first !== undefined) sourceFormat = sniffJobSourceFormat('bytes' in first ? first.bytes : await readHead(first.path));

    const sourceFiles: SourceFile[] = [];
    for (const [index, source] of input.sources.entries()) {
      const key = sourceKey(id, index, source.name);
      const stat =
        'bytes' in source ? await this.deps.blobs.put(key, source.bytes) : await this.deps.blobs.adoptFile(key, source.path);
      sourceFiles.push({ name: source.name, sha256: stat.sha256, sizeBytes: stat.size, storageKey: key });
    }
    const job: Job = {
      id,
      name: input.name,
      customerRef: input.customerRef,
      status: 'received',
      ...(sourceFormat === undefined ? {} : { sourceFormat }),
      priority,
      hotFolderId: input.hotFolderId,
      deviceId: input.deviceId,
      mediumId: input.mediumId,
      presetId: input.presetId,
      colorSetupRevisionId: input.colorSetupRevisionId,
      sourceFiles,
      artifacts: [],
      ticket: input.ticket,
      tags: [...(input.tags ?? [])],
      metadata: { ...(input.metadata ?? {}) },
      createdAt: at,
      updatedAt: at,
      lifecycle: 'active',
      legalHold: false,
    };
    await this.deps.jobs.save(job);
    this.publishJob(EventTypes.jobCreated, id, { jobId: id, name: job.name, status: job.status, actor: actor.id });
    return job;
  }

  async setStatus(jobId: string, to: JobStatus, actor: Actor = SYSTEM_ACTOR): Promise<Job> {
    const job = await this.get(jobId);
    const updated = withStatus(job, to, this.clock().toISOString());
    await this.deps.jobs.save(updated);
    this.publishJob(EventTypes.jobStatusChanged, jobId, { jobId, from: job.status, to, actor: actor.id });
    return updated;
  }

  /**
   * Layout input for a job (Spec 007 FR4, consumed by Spec 003): each nest item gets the
   * ticket's edit stack, so its footprint reflects rotate, scale, crop, bleed and page size.
   */
  layoutItems<T extends NestItem>(job: Job, items: readonly T[]): T[] {
    const edits = ticketEdits(job.ticket);
    return items.map((item) => applyEdits({ ...item, jobId: item.jobId ?? job.id }, edits));
  }

  /** Stores a layout, cut or preview output of a step on the job. */
  async addArtifact(jobId: string, role: ArtifactRole, name: string, bytes: Uint8Array): Promise<Job> {
    const job = await this.get(jobId);
    const key = artifactKey(jobId, role, job.artifacts.length, name);
    const stat = await this.deps.blobs.put(key, bytes);
    const updated: Job = {
      ...job,
      artifacts: [...job.artifacts, { role, name, sha256: stat.sha256, sizeBytes: stat.size, storageKey: key }],
      updatedAt: this.clock().toISOString(),
    };
    await this.deps.jobs.save(updated);
    return updated;
  }

  async recordStep(
    jobId: string,
    stage: string,
    phase: StepPhase,
    details: Readonly<Record<string, unknown>> = {},
  ): Promise<CloudEvent> {
    await this.get(jobId);
    return this.publishJob(STEP_TYPES[phase], jobId, { jobId, stage, details });
  }

  async recordOperatorAction(
    jobId: string,
    actor: Actor,
    action: string,
    details: Readonly<Record<string, unknown>> = {},
  ): Promise<CloudEvent> {
    await this.get(jobId);
    if (action.trim() === '') throw new InvalidArgumentError('an operator action needs a name');
    return this.publishJob(EventTypes.operatorAction, jobId, { jobId, actor: actor.id, action, details });
  }

  /** Stores device-reported ink and media usage exactly as reported, with units. */
  async recordAccounting(report: unknown): Promise<CloudEvent<DeviceAccountingReport>> {
    const validated = validateAccountingReport(report);
    await this.get(validated.jobId);
    return this.deps.bus.publish({
      type: EventTypes.deviceAccounting,
      source: DEVICE_SOURCE,
      subject: validated.deviceId,
      data: validated,
    });
  }

  /** History is append-only: a correction is a new event that points at the one it corrects. */
  async recordCorrection(
    jobId: string,
    correctsEventId: string,
    reason: string,
    actor: Actor,
    replacement: Readonly<Record<string, unknown>> = {},
  ): Promise<CloudEvent> {
    await this.get(jobId);
    if (reason.trim() === '') throw new InvalidArgumentError('a correction needs a reason');
    return this.publishJob(EventTypes.historyCorrection, jobId, {
      jobId,
      corrects: correctsEventId,
      reason,
      replacement,
      actor: actor.id,
    });
  }

  private publishJob(type: string, jobId: string, data: Record<string, unknown>): CloudEvent {
    return this.deps.bus.publish({ type, source: JOB_SOURCE, subject: jobId, data });
  }
}
