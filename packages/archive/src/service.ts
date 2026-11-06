import {
  assertPurgeable,
  InvalidArgumentError,
  InvalidLifecycleError,
  isTerminal,
  markArchived,
  markRestored,
  markTrashed,
  markUntrashed,
  normalizeJobInkLimit,
  normalizeJobPlaneCurves,
  normalizeJobScreening,
  normalizeJobWhiteInk,
  requireRole,
  SYSTEM_ACTOR,
  systemClock,
  ulid,
  withLegalHold,
  type Actor,
  type Clock,
  type ColorSetupRevision,
  type Job,
  type SourceFile,
} from '@bax-print/core';
import { EventTypes, historyForJob, type CloudEvent, type EventBus, type Outbox } from '@bax-print/events';
import {
  artifactKey,
  jobKeyPrefix,
  packageKey,
  sha256Hex,
  sourceKey,
  type ArchiveIndexRepository,
  type ArchiveIndexRow,
  type ArchivePage,
  type ArchiveSearchQuery,
  type BlobStat,
  type JobRepository,
  type Storage,
} from '@bax-print/store';
import type { ColorSetupResolver } from './color-setups.js';
import { JobNotFoundError, PackageIntegrityError, RemapRequiredError } from './errors.js';
import { pack, unpack, type PackResult, type UnpackedPackage } from './package.js';
import { selectJobsToArchive, validateRules, type ArchiveRule } from './policy.js';
import { resolveReprintSetup, type ReprintSetupRequest } from './reprint-setup.js';
import { DEFAULT_RETENTION_MS, selectJobsToPurge } from './retention.js';
import { exportTicketXjdf } from './xjdf.js';

const EVENT_SOURCE = '/bps/archive';
const MAX_COPIES = 100_000;
export const IMPORTED_FROM_KEY = 'bps.importedFrom';

/** Device and medium catalog used to validate imported packages. */
export interface DeviceMediaCatalog {
  hasDevice(id: string): Promise<boolean>;
  hasMedium(id: string): Promise<boolean>;
}

export interface ArchiveServiceDeps {
  readonly jobs: JobRepository;
  readonly index: ArchiveIndexRepository;
  /** Storage holding active job blobs (sources and artifacts). */
  readonly blobs: Storage;
  /** `Storage/1` backend that receives `.bpsjob` packages. */
  readonly archive: Storage;
  readonly bus: EventBus;
  readonly outbox: Outbox;
  readonly colorSetups: ColorSetupResolver;
  readonly catalog?: DeviceMediaCatalog;
  readonly clock?: Clock;
  readonly newId?: () => string;
  readonly rules?: readonly ArchiveRule[];
  readonly retentionMs?: number;
}

export interface ReprintOptions extends ReprintSetupRequest {
  readonly copies?: number;
  readonly presetId?: string;
}

export interface ImportOptions {
  /** Original device id → local device id. */
  readonly deviceMap?: Readonly<Record<string, string>>;
  /** Original medium id → local medium id. */
  readonly mediumMap?: Readonly<Record<string, string>>;
}

export interface ArchiveResult {
  readonly job: Job;
  readonly warnings: readonly string[];
}

export interface PolicyRunResult {
  readonly archived: readonly string[];
  readonly failed: readonly { readonly jobId: string; readonly error: string }[];
}

interface Snapshot {
  readonly job: Job;
  readonly sources: readonly Uint8Array[];
  readonly artifacts: readonly Uint8Array[];
}

export class ArchiveService {
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly rules: readonly ArchiveRule[];
  private readonly retentionMs: number;

  constructor(private readonly deps: ArchiveServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.newId = deps.newId ?? (() => ulid(this.clock().getTime()));
    this.rules = validateRules(deps.rules ?? []);
    this.retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;
    if (!Number.isFinite(this.retentionMs) || this.retentionMs <= 0) {
      throw new InvalidArgumentError('retentionMs must be a positive number of milliseconds');
    }
  }

  async getJob(jobId: string): Promise<Job> {
    const job = await this.deps.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    return job;
  }

  /** Moves a finished job into the archive. Manual archive ignores the policy window. */
  async archive(jobId: string, actor: Actor = SYSTEM_ACTOR): Promise<ArchiveResult> {
    requireRole(actor, 'operator', 'archiving a job');
    const job = await this.getJob(jobId);
    const archived = markArchived(job, this.now());
    const packed = await this.packJob(archived);
    const stat = await this.storePackage(archived.id, packed);

    await this.deps.index.upsert(indexRow(archived, stat));
    await this.deps.jobs.save(archived);
    await this.deleteActiveBlobs(archived);
    this.publish(EventTypes.jobArchived, archived.id, {
      jobId: archived.id,
      packageKey: stat.key,
      packageSha256: stat.sha256,
      actor: actor.id,
      warnings: packed.warnings,
    });
    return { job: archived, warnings: packed.warnings };
  }

  /** Runs the archive policy once: archives every active job whose `done` time is past its rule. */
  async runArchivePolicy(): Promise<PolicyRunResult> {
    const due = selectJobsToArchive(await this.deps.jobs.list({ lifecycle: 'active' }), this.rules, this.clock());
    const archived: string[] = [];
    const failed: { jobId: string; error: string }[] = [];
    for (const job of due) {
      try {
        await this.archive(job.id, SYSTEM_ACTOR);
        archived.push(job.id);
      } catch (error) {
        failed.push({ jobId: job.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { archived, failed };
  }

  /** Brings an archived job back to the active list. */
  async restore(jobId: string, actor: Actor = SYSTEM_ACTOR): Promise<Job> {
    requireRole(actor, 'operator', 'restoring a job');
    const job = await this.getJob(jobId);
    const restored = markRestored(job, this.now());
    const pkg = await this.loadPackage(job);
    await this.writeBlobs(restored.sourceFiles, pkg.sources);
    await this.writeBlobs(restored.artifacts, pkg.artifacts);
    await this.deps.jobs.save(restored);
    await this.deps.index.remove(job.id);
    await this.deps.archive.delete(packageKey(job.id));
    this.publish(EventTypes.jobRestored, job.id, { jobId: job.id, from: 'archive', actor: actor.id });
    return restored;
  }

  /** Creates a new job linked by `reprintOf`, restoring sources, ticket and (when valid) artifacts. */
  async reprint(jobId: string, options: ReprintOptions = {}, actor: Actor = SYSTEM_ACTOR): Promise<ArchiveResult> {
    requireRole(actor, 'operator', 'reprinting a job');
    const original = await this.getJob(jobId);
    if (original.lifecycle === 'trashed') {
      throw new InvalidLifecycleError(`job ${jobId} is in the trash; restore it before reprinting`);
    }
    if (!isTerminal(original.status)) {
      throw new InvalidLifecycleError(`job ${jobId} is ${original.status}; only finished jobs can be reprinted`);
    }

    const snapshot = original.lifecycle === 'archived' ? await this.loadPackage(original) : await this.readActive(original);
    const source = snapshot.job;
    const copies = options.copies ?? source.ticket.intent.quantity;
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
      throw new InvalidArgumentError(`copies must be an integer from 1 to ${MAX_COPIES}`);
    }
    const setup = await resolveReprintSetup(source, options, this.deps.colorSetups);

    const warnings: string[] = [];
    const id = this.newId();
    const at = this.now();
    const sourceFiles = source.sourceFiles.map((file, i) => ({ ...file, storageKey: sourceKey(id, i, file.name) }));
    // Layout and cut outputs depend on device and medium, so they only carry over when both are unchanged.
    const keepArtifacts = !setup.changed;
    const artifacts = keepArtifacts
      ? source.artifacts.map((a, i) => ({ ...a, storageKey: artifactKey(id, a.role, i, a.name) }))
      : [];
    if (setup.changed) {
      warnings.push(
        `device or medium changed (${source.deviceId ?? '-'} / ${source.mediumId ?? '-'} → ` +
          `${setup.deviceId ?? '-'} / ${setup.mediumId ?? '-'}); color setup ${setup.colorSetupRevisionId ?? '-'} ` +
          'replaces the original, and layout and cut files will be regenerated',
      );
    } else if (setup.source === 'none' && setup.deviceId !== undefined) {
      warnings.push('the original job has no recorded color setup revision');
    }

    const job: Job = {
      id,
      name: source.name,
      customerRef: source.customerRef,
      status: 'received',
      priority: source.priority,
      hotFolderId: source.hotFolderId,
      deviceId: setup.deviceId,
      mediumId: setup.mediumId,
      presetId: options.presetId ?? source.presetId,
      colorSetupRevisionId: setup.colorSetupRevisionId,
      sourceFiles,
      artifacts,
      ticket: { ...source.ticket, intent: { ...source.ticket.intent, quantity: copies } },
      tags: [...source.tags],
      metadata: { ...source.metadata },
      createdAt: at,
      updatedAt: at,
      lifecycle: 'active',
      legalHold: false,
      reprintOf: original.id,
    };

    await this.writeBlobs(sourceFiles, snapshot.sources);
    if (keepArtifacts) await this.writeBlobs(artifacts, snapshot.artifacts);
    await this.deps.jobs.save(job);

    this.publish(EventTypes.jobCreated, id, {
      jobId: id,
      name: job.name,
      status: job.status,
      reprintOf: original.id,
      copies,
      actor: actor.id,
    });
    if (setup.changed) {
      this.publish(EventTypes.reprintSetupChanged, id, {
        jobId: id,
        reprintOf: original.id,
        severity: 'warning',
        previous: {
          deviceId: source.deviceId ?? null,
          mediumId: source.mediumId ?? null,
          colorSetupRevisionId: source.colorSetupRevisionId ?? null,
        },
        current: {
          deviceId: setup.deviceId ?? null,
          mediumId: setup.mediumId ?? null,
          colorSetupRevisionId: setup.colorSetupRevisionId ?? null,
        },
        actor: actor.id,
      });
    }
    return { job, warnings };
  }

  /** Moves a job to the trash. Blocked by legal hold. */
  async trash(jobId: string, actor: Actor = SYSTEM_ACTOR): Promise<Job> {
    requireRole(actor, 'operator', 'deleting a job');
    const job = await this.getJob(jobId);
    const trashed = markTrashed(job, this.now());
    await this.deps.jobs.save(trashed);
    if (job.lifecycle === 'archived') await this.deps.index.remove(job.id);
    this.publish(EventTypes.jobTrashed, job.id, { jobId: job.id, from: job.lifecycle, actor: actor.id });
    return trashed;
  }

  async restoreFromTrash(jobId: string, actor: Actor = SYSTEM_ACTOR): Promise<Job> {
    requireRole(actor, 'operator', 'restoring a job from the trash');
    const job = await this.getJob(jobId);
    const restored = markUntrashed(job, this.now());
    if (restored.lifecycle === 'archived') {
      const stat = await this.deps.archive.stat(packageKey(job.id));
      if (!stat) throw new PackageIntegrityError(`the archived package of job ${job.id} is missing`);
      await this.deps.index.upsert(indexRow(restored, stat));
    }
    await this.deps.jobs.save(restored);
    this.publish(EventTypes.jobRestored, job.id, { jobId: job.id, from: 'trash', lifecycle: restored.lifecycle, actor: actor.id });
    return restored;
  }

  /** Operators may place a hold; only admins may remove it. */
  async setLegalHold(jobId: string, hold: boolean, actor: Actor): Promise<Job> {
    requireRole(actor, hold ? 'operator' : 'admin', hold ? 'placing a legal hold' : 'removing a legal hold');
    const job = await this.getJob(jobId);
    const updated = withLegalHold(job, hold, this.now());
    await this.deps.jobs.save(updated);
    this.publish(EventTypes.jobLegalHoldChanged, job.id, { jobId: job.id, legalHold: hold, actor: actor.id });
    return updated;
  }

  /** Permanently removes trashed jobs past the retention window, except those under legal hold. */
  async purgeExpired(): Promise<string[]> {
    const due = selectJobsToPurge(await this.deps.jobs.list({ lifecycle: 'trashed' }), this.clock(), this.retentionMs);
    const purged: string[] = [];
    for (const job of due) {
      await this.purge(job);
      purged.push(job.id);
    }
    return purged;
  }

  /** Imports a `.bpsjob` from another installation as a new archived job. */
  async importPackage(bytes: Uint8Array, options: ImportOptions = {}, actor: Actor = SYSTEM_ACTOR): Promise<ArchiveResult> {
    requireRole(actor, 'operator', 'importing a job package');
    const pkg = unpack(bytes);
    const origin = pkg.job;
    const deviceId = origin.deviceId === undefined ? undefined : (options.deviceMap?.[origin.deviceId] ?? origin.deviceId);
    const mediumId = origin.mediumId === undefined ? undefined : (options.mediumMap?.[origin.mediumId] ?? origin.mediumId);

    const catalog = this.deps.catalog;
    if (catalog) {
      const unknownDevices = deviceId !== undefined && !(await catalog.hasDevice(deviceId)) ? [origin.deviceId as string] : [];
      const unknownMedia = mediumId !== undefined && !(await catalog.hasMedium(mediumId)) ? [origin.mediumId as string] : [];
      if (unknownDevices.length > 0 || unknownMedia.length > 0) {
        throw new RemapRequiredError(unknownDevices, unknownMedia);
      }
    }

    const warnings: string[] = [];
    let colorSetupRevisionId = origin.colorSetupRevisionId;
    if (colorSetupRevisionId !== undefined) {
      const remapped = deviceId !== origin.deviceId || mediumId !== origin.mediumId;
      const local = remapped ? undefined : await this.deps.colorSetups.getRevision(colorSetupRevisionId);
      if (!local) {
        warnings.push(`color setup revision ${colorSetupRevisionId} does not apply here; pick a setup when reprinting`);
        colorSetupRevisionId = undefined;
      }
    }

    const id = this.newId();
    const at = this.now();
    // Spec 038d: job.json may come from another installation; an invalid whiteInk is dropped (white ink off).
    // Spec 039b: an invalid screening is dropped the same way (no screening requested).
    // Spec 040b: an invalid inkLimit is dropped the same way (no ink limit requested).
    // Spec 044b: an invalid planeCurves is dropped the same way (no curves requested).
    const job: Job = normalizeJobPlaneCurves<Job>(normalizeJobInkLimit<Job>(normalizeJobScreening<Job>(normalizeJobWhiteInk<Job>({
      ...origin,
      id,
      deviceId,
      mediumId,
      colorSetupRevisionId,
      sourceFiles: origin.sourceFiles.map((file, i) => ({ ...file, storageKey: sourceKey(id, i, file.name) })),
      artifacts: origin.artifacts.map((a, i) => ({ ...a, storageKey: artifactKey(id, a.role, i, a.name) })),
      metadata: { ...origin.metadata, [IMPORTED_FROM_KEY]: origin.id },
      updatedAt: at,
      lifecycle: 'archived',
      archivedAt: at,
      trashedAt: undefined,
      legalHold: false,
      reprintOf: undefined,
    }))));

    const packed = pack({
      job,
      sources: pkg.sources,
      artifacts: pkg.artifacts,
      colorRevisions: pkg.colorRevisions,
      profiles: pkg.profiles,
      history: pkg.history,
      createdAt: this.clock(),
    });
    const stat = await this.storePackage(id, packed);
    await this.deps.index.upsert(indexRow(job, stat));
    await this.deps.jobs.save(job);

    const allWarnings = [...warnings, ...packed.warnings];
    this.publish(EventTypes.jobImported, id, {
      jobId: id,
      importedFrom: origin.id,
      deviceId: deviceId ?? null,
      mediumId: mediumId ?? null,
      actor: actor.id,
      warnings: allWarnings,
    });
    return { job, warnings: allWarnings };
  }

  /** Package bytes for download or interchange; built on the fly for finished active jobs. */
  async getPackage(jobId: string): Promise<Uint8Array> {
    const job = await this.getJob(jobId);
    if (job.lifecycle === 'archived') return this.deps.archive.get(packageKey(job.id));
    if (job.lifecycle === 'active' && isTerminal(job.status)) return (await this.packJob(job)).bytes;
    throw new InvalidLifecycleError(`job ${jobId} is ${job.lifecycle} / ${job.status}; no package is available`);
  }

  search(query: ArchiveSearchQuery): Promise<ArchivePage> {
    return this.deps.index.search(query);
  }

  async getIndexRow(jobId: string): Promise<ArchiveIndexRow> {
    const row = await this.deps.index.get(jobId);
    if (!row) throw new JobNotFoundError(jobId);
    return row;
  }

  listTrash(): Promise<Job[]> {
    return this.deps.jobs.list({ lifecycle: 'trashed' });
  }

  history(jobId: string): CloudEvent[] {
    return historyForJob(this.deps.outbox, jobId);
  }

  /** Optional XJDF interchange of the ticket (FR8). */
  async exportXjdf(jobId: string): Promise<string> {
    return exportTicketXjdf(await this.getJob(jobId), { at: this.clock() });
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private publish(type: string, jobId: string, data: Record<string, unknown>): void {
    this.deps.bus.publish({ type, source: EVENT_SOURCE, subject: jobId, data });
  }

  private async packJob(job: Job): Promise<PackResult> {
    const snapshot = await this.readActive(job);
    const colorRevisions: ColorSetupRevision[] = [];
    if (job.colorSetupRevisionId !== undefined) {
      const revision = await this.deps.colorSetups.getRevision(job.colorSetupRevisionId);
      if (revision) colorRevisions.push(revision);
    }
    const profiles = new Map<string, Uint8Array>();
    for (const ref of colorRevisions.flatMap((revision) => revision.profiles)) {
      if (!ref.redistributable) continue;
      const bytes = await this.deps.colorSetups.getProfileBytes(ref.id);
      if (bytes) profiles.set(ref.id, bytes);
    }
    const packed = pack({
      job,
      sources: snapshot.sources,
      artifacts: snapshot.artifacts,
      colorRevisions,
      profiles,
      history: historyForJob(this.deps.outbox, job.id),
      createdAt: this.clock(),
    });
    if (job.colorSetupRevisionId !== undefined && colorRevisions.length === 0) {
      return {
        ...packed,
        warnings: [...packed.warnings, `color setup revision ${job.colorSetupRevisionId} could not be resolved`],
      };
    }
    return packed;
  }

  /** Writes a package and reads it back before anything else is changed. */
  private async storePackage(jobId: string, packed: PackResult): Promise<BlobStat> {
    const key = packageKey(jobId);
    const stat = await this.deps.archive.put(key, packed.bytes);
    unpack(await this.deps.archive.get(key));
    return stat;
  }

  private async loadPackage(job: Job): Promise<UnpackedPackage> {
    const pkg = unpack(await this.deps.archive.get(packageKey(job.id)));
    if (pkg.manifest.jobId !== job.id) {
      throw new PackageIntegrityError(`package for job ${job.id} belongs to job ${pkg.manifest.jobId}`);
    }
    return pkg;
  }

  private async readActive(job: Job): Promise<Snapshot> {
    const read = async (file: SourceFile): Promise<Uint8Array> => {
      const bytes = await this.deps.blobs.get(file.storageKey);
      if (sha256Hex(bytes) !== file.sha256) {
        throw new PackageIntegrityError(`stored blob ${file.storageKey} does not match its recorded SHA-256`);
      }
      return bytes;
    };
    return {
      job,
      sources: await Promise.all(job.sourceFiles.map(read)),
      artifacts: await Promise.all(job.artifacts.map(read)),
    };
  }

  private async writeBlobs(files: readonly SourceFile[], data: readonly Uint8Array[]): Promise<void> {
    if (files.length !== data.length) {
      throw new PackageIntegrityError('package contents do not match the job record');
    }
    for (const [i, file] of files.entries()) {
      const bytes = data[i];
      if (bytes === undefined) {
        throw new PackageIntegrityError('package contents do not match the job record');
      }
      if (sha256Hex(bytes) !== file.sha256) {
        throw new PackageIntegrityError(`${file.name} does not match its recorded SHA-256`);
      }
      await this.deps.blobs.put(file.storageKey, bytes);
    }
  }

  private async deleteActiveBlobs(job: Job): Promise<number> {
    const keys = new Set([
      ...job.sourceFiles.map((f) => f.storageKey),
      ...job.artifacts.map((a) => a.storageKey),
      ...(await this.deps.blobs.list(jobKeyPrefix(job.id))),
    ]);
    let removed = 0;
    for (const key of keys) {
      if (await this.deps.blobs.delete(key)) removed++;
    }
    return removed;
  }

  private async purge(job: Job): Promise<void> {
    assertPurgeable(job);
    const removedBlobs = await this.deleteActiveBlobs(job);
    const packageRemoved = await this.deps.archive.delete(packageKey(job.id));
    await this.deps.index.remove(job.id);
    await this.deps.jobs.delete(job.id);
    this.publish(EventTypes.jobPurged, job.id, { jobId: job.id, removedBlobs, packageRemoved });
  }
}

function indexRow(job: Job, stat: BlobStat): ArchiveIndexRow {
  return {
    jobId: job.id,
    name: job.name,
    customerRef: job.customerRef,
    createdAt: job.createdAt,
    doneAt: job.doneAt,
    archivedAt: job.archivedAt ?? job.updatedAt,
    deviceId: job.deviceId,
    mediumId: job.mediumId,
    widthMm: job.ticket.intent.finishedSize?.widthMm,
    heightMm: job.ticket.intent.finishedSize?.heightMm,
    tags: [...job.tags],
    metadata: { ...job.metadata },
    reprintOf: job.reprintOf,
    packageKey: stat.key,
    packageSha256: stat.sha256,
    packageBytes: stat.size,
  };
}
