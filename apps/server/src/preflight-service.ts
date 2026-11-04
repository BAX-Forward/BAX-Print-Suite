import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_OVERRIDE_REASON_LENGTH,
  applyPreflightReport,
  decide,
  inspectContextOf,
  mergeReinspection,
  profileToChecks,
  reinspectionChecks,
  selectProfileId,
  type AuditEntry,
  type PreflightJob,
} from "@bax-print/inspect";
import {
  SYSTEM_ACTOR,
  parseEdits,
  ticketEdits,
  withStatus,
  type Actor,
  type Job,
  type JobArtifact,
  type JobEdit,
  type JobStatus,
} from "@bax-print/core";
import {
  EditError,
  computeGeometry,
  editedPpi,
  geometryErrors,
  normalizeRect,
  type EffectivePpi,
  type ImagePlacement,
  type PageSource,
} from "@bax-print/edits";
import { summarize, type CheckConfig, type Finding, type Inspector, type PreflightReport } from "@bax-print/plugin-sdk";
import { HttpError, conflict, invalid, notFound } from "./errors.js";
import type { JobService } from "./jobs.js";
import type { ProfileService } from "./profiles.js";
import type { FindingsStore, HotFolderStore, JobStore } from "./stores.js";

/**
 * Preflight on jobs (Spec 007 FR2, FR3, FR5). Runs the selected profile through an
 * `Inspector`, records the report, and moves the job to `ready` or `held`. Edits rerun the
 * edit-dependent checks; an operator may clear a preflight hold with a reason. The audit trail
 * is the job's event history: every decision is published through `JobService`.
 */

/** `checkId` of findings the service itself produces (missing profile, inspector failure). */
export const SERVICE_CHECK_ID = "preflight";
const SERVICE_INSPECTOR = { id: "org.bax-print.server.preflight", version: "0.1.0" };
const STAGE = "preflight";
const MAX_LOG_LINES_KEPT = 50;

type Hold = NonNullable<Job["hold"]>;

/** The `JobService` operations preflight publishes through. */
export type PreflightEvents = Pick<JobService, "recordStep" | "recordOperatorAction" | "addArtifact">;

export interface PreflightServiceOptions {
  /** The same repository `events` reads, so published events find the job. */
  jobs: JobStore;
  findings: FindingsStore;
  profiles: ProfileService;
  events: PreflightEvents;
  /** Runs `inspect()`. Usually the built-in inspector. */
  inspector: Inspector;
  /** Runs `fixup()` for normalization (FR3). Optional: nothing else depends on it. */
  fixupInspector?: Inspector;
  hotFolders?: HotFolderStore;
  /** File system path of a stored blob, e.g. a job's `sourceFiles[0].storageKey`. */
  blobPath: (storageKey: string) => string;
  /** Host-owned directory; fixup output goes to `<spoolDir>/derived/<jobId>/` before it is stored. */
  spoolDir: string;
  now?: () => Date;
}

export interface FindingsView {
  jobId: string;
  status: JobStatus;
  hold?: Hold;
  report: PreflightReport | null;
}

export interface EditsResult {
  job: Job;
  report: PreflightReport | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberList(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Data of a resolution finding the host can re-evaluate: the image as placed in source user
 * space, the page it is on (index and box `[x0, y0, x1, y1]` in pt, from the inspector report)
 * and the profile's minimum. Inspectors report source placements; the host applies the job's
 * edits, so the source PDF is never re-read for an edit.
 */
interface ImageFindingData {
  pageIndex: number;
  page: PageSource;
  image: ImagePlacement;
  minPpi: number;
}

function pageOf(data: Record<string, unknown>): { pageIndex: number; page: PageSource } | undefined {
  const { pageIndex, pageBox } = data;
  if (typeof pageIndex !== "number" || !Number.isInteger(pageIndex) || pageIndex < 0) return undefined;
  if (!isNumberList(pageBox, 4)) return undefined;
  const [x0, y0, x1, y1] = pageBox as [number, number, number, number];
  return { pageIndex, page: { box: normalizeRect(x0, y0, x1, y1) } };
}

function imageFindingData(data: unknown): ImageFindingData | undefined {
  if (!isRecord(data) || !isRecord(data.image)) return undefined;
  const located = pageOf(data);
  const { minPpi } = data;
  const { pixelWidth, pixelHeight, ctm } = data.image;
  if (!located || typeof minPpi !== "number") return undefined;
  if (typeof pixelWidth !== "number" || typeof pixelHeight !== "number" || !isNumberList(ctm, 6)) return undefined;
  return { ...located, minPpi, image: { pixelWidth, pixelHeight, ctm: ctm as unknown as ImagePlacement["ctm"] } };
}

/** Page boxes named by a report's findings, by page index. */
export function reportPages(report: PreflightReport | undefined): PageSource[] {
  const pages: PageSource[] = [];
  for (const finding of report?.findings ?? []) {
    const located = isRecord(finding.data) ? pageOf(finding.data) : undefined;
    if (located && pages[located.pageIndex] === undefined) pages[located.pageIndex] = located.page;
  }
  return pages.filter((page): page is PageSource => page !== undefined);
}

function ppiAfterEdits(image: ImagePlacement, page: PageSource, edits: readonly JobEdit[]): EffectivePpi | undefined {
  try {
    return editedPpi(image, computeGeometry(page, edits));
  } catch (error) {
    if (error instanceof EditError || error instanceof RangeError) return undefined;
    throw error;
  }
}

/**
 * Re-evaluates resolution findings at the edited size (Spec 007 FR5): effective ppi is
 * `editedPpi(image, computeGeometry(page, ticket.edits))`. A finding whose image now meets the
 * minimum is dropped; one that still falls short reports the edited resolution.
 */
export function applyEditsToImageFindings(job: Pick<Job, "ticket">, report: PreflightReport): PreflightReport {
  const edits = ticketEdits(job.ticket);
  if (edits.length === 0) return report;
  let changed = false;
  const findings = report.findings.flatMap((finding): Finding[] => {
    const data = imageFindingData(finding.data);
    const ppi = data ? ppiAfterEdits(data.image, data.page, edits) : undefined;
    if (!data || !ppi) return [finding];
    changed = true;
    if (ppi.min >= data.minPpi) return [];
    const effective = Math.round(ppi.min);
    return [
      {
        ...finding,
        message: `Image resolution is ${effective} ppi after edits, below the ${data.minPpi} ppi minimum`,
        data: { ...(finding.data as Record<string, unknown>), effectivePpi: effective, editsApplied: true },
      },
    ];
  });
  return changed ? { ...report, findings, summary: summarize(findings) } : report;
}

function serviceReport(at: string, profileId: string, finding: Omit<Finding, "checkId" | "severity">): PreflightReport {
  const findings: Finding[] = [{ checkId: SERVICE_CHECK_ID, severity: "error", ...finding }];
  return { inspector: SERVICE_INSPECTOR, profileId, generatedAt: at, pageCount: 0, findings, summary: summarize(findings), conformance: [] };
}

/** The status move, or `undefined` when core's status machine does not allow it. */
function tryStatus(job: Job, to: JobStatus, at: string): Job | undefined {
  try {
    return withStatus(job, to, at);
  } catch {
    return undefined;
  }
}

function statusEntry(at: string, from: JobStatus, to: JobStatus): AuditEntry {
  return { at, type: "status.changed", detail: { from, to } };
}

function isPreflightHeld(job: Job): boolean {
  return job.status === "held" && job.hold?.reason === "preflight";
}

/** A copy of the job without its hold (it is set only while the job is held). */
function withoutHold(job: Job): Job {
  const copy: { -readonly [K in keyof Job]: Job[K] } = { ...job };
  delete copy.hold;
  return copy;
}

/** A job as stored: the `audit` list the inspect helpers build is published as events instead. */
function stripAudit(job: PreflightJob): { job: Job; entries: readonly AuditEntry[] } {
  const { audit, ...rest } = job;
  return { job: rest as Job, entries: audit ?? [] };
}

export class PreflightService {
  private readonly options: PreflightServiceOptions;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: PreflightServiceOptions) {
    this.options = options;
  }

  async findings(jobId: string): Promise<FindingsView> {
    const job = await this.job(jobId);
    const report = (await this.options.findings.get(jobId)) ?? null;
    return { jobId, status: job.status, ...(job.hold ? { hold: job.hold } : {}), report };
  }

  /** Full inspection. Accepts `received`, `inspecting`, `ready`, or a job held by preflight. */
  inspectJob(jobId: string, actor: Actor = SYSTEM_ACTOR): Promise<Job> {
    return this.serialized(jobId, async () => {
      const job = await this.job(jobId);
      if (job.status !== "received" && job.status !== "inspecting" && job.status !== "ready" && !isPreflightHeld(job)) {
        throw conflict(`Job ${jobId} is ${job.status}${job.hold ? ` (${job.hold.reason})` : ""}; it can't be inspected now`);
      }
      return this.inspectAndDecide(job, undefined, actor);
    });
  }

  /** `PATCH /jobs/:id/edits`: replaces the edit stack and reruns the edit-dependent checks (FR5). */
  updateEdits(jobId: string, input: unknown, actor: Actor = SYSTEM_ACTOR): Promise<EditsResult> {
    return this.serialized(jobId, async () => {
      const parsed = parseEdits(input);
      if (!parsed.ok) throw invalid("Invalid edits", parsed.errors);
      const current = await this.job(jobId);
      if (current.status !== "received" && current.status !== "ready" && current.status !== "held") {
        throw conflict(`Job ${jobId} is ${current.status}; edits can only change before it is queued`);
      }
      const previous = await this.options.findings.get(jobId);
      const geometry = geometryErrors(reportPages(previous), parsed.value);
      if (geometry.length > 0) throw invalid("The edits can't be applied to this job", geometry);

      const at = this.now();
      const job: Job = { ...current, ticket: { ...current.ticket, edits: parsed.value }, updatedAt: at };
      await this.options.jobs.save(job);
      await this.options.events.recordOperatorAction(jobId, actor, "edits.changed", {
        count: parsed.value.length,
        kinds: parsed.value.map((edit) => edit.kind),
      });
      // Not inspected yet: the first inspection sees the new edits.
      if (job.status === "received") return { job, report: null };

      if (job.status === "held" && job.hold?.reason !== "preflight") {
        // An operator hold stays in place; the findings still update.
        const report = await this.runInspection(job, previous);
        await this.options.findings.put(jobId, report);
        return { job, report };
      }
      const decided = await this.inspectAndDecide(job, previous, actor);
      return { job: decided, report: (await this.options.findings.get(jobId)) ?? null };
    });
  }

  /**
   * Clears a preflight hold with the operator's reason, published as a `preflight.override`
   * event. The job goes to `ready`. Queuing is a later operator step. A job that cannot
   * enter `ready` is a conflict.
   */
  clearHold(jobId: string, reason: string, actor: Actor = SYSTEM_ACTOR): Promise<Job> {
    return this.serialized(jobId, async () => {
      const job = await this.job(jobId);
      if (!isPreflightHeld(job)) throw conflict(`Job ${jobId} is not held by preflight`);
      const trimmed = reason.trim().slice(0, MAX_OVERRIDE_REASON_LENGTH);
      if (trimmed.length === 0) throw invalid("Clearing a preflight hold needs a reason");
      const at = this.now();
      const moved = tryStatus(job, "ready", at);
      if (!moved) throw conflict(`Job ${jobId} can't leave held`);
      const cleared = withoutHold(moved);
      await this.options.jobs.save(cleared);
      await this.publish(jobId, actor, [
        { at, type: "preflight.override", detail: { reason: trimmed, hold: job.hold?.detail ?? null } },
        statusEntry(at, job.status, cleared.status),
      ]);
      return cleared;
    });
  }

  /** FR3: rewrites the job's source to a PDF/X or PDF/A level, stored as a `normalized` artifact. The source stays. */
  normalize(jobId: string, target: string, fixupOptions: Record<string, unknown> | undefined, actor: Actor = SYSTEM_ACTOR): Promise<JobArtifact> {
    return this.serialized(jobId, async () => {
      const inspector = this.options.fixupInspector;
      if (!inspector?.fixup) throw new HttpError(501, "not_available", "No normalization engine is configured");
      const targets = inspector.fixupTargets ?? [];
      if (!targets.includes(target)) {
        throw invalid(`Unsupported normalization target ${JSON.stringify(target)}`, [`supported: ${targets.join(", ") || "none"}`]);
      }
      const job = await this.job(jobId);
      if (job.status === "failed" || job.status === "cancelled" || job.status === "done") throw conflict(`Job ${jobId} is ${job.status}`);
      const result = await inspector.fixup({
        document: { kind: "file", path: this.sourcePath(job) },
        target,
        outputDir: path.join(this.options.spoolDir, "derived", job.id),
        ...(fixupOptions ? { options: fixupOptions } : {}),
      });
      const bytes = new Uint8Array(await readFile(result.document.path));
      const updated = await this.options.events.addArtifact(jobId, "normalized", path.basename(result.document.path), bytes);
      const artifact = updated.artifacts[updated.artifacts.length - 1];
      if (!artifact) throw new Error(`Job ${jobId}: the normalized artifact was not stored`);
      await this.options.events.recordOperatorAction(jobId, actor, "preflight.normalized", {
        target: result.target,
        storageKey: artifact.storageKey,
        inspector: { id: inspector.id, version: inspector.version },
        log: result.log.slice(-MAX_LOG_LINES_KEPT),
      });
      return artifact;
    });
  }

  /**
   * Runs the profile and decides `ready` or `held`. Where core allows it the job passes through
   * `inspecting` and the inspect package's decision applies; otherwise (a re-inspection the
   * status machine does not route through `inspecting`) the same decision is applied in place.
   */
  private async inspectAndDecide(job: Job, previous: PreflightReport | undefined, actor: Actor): Promise<Job> {
    const at = this.now();
    const inspecting = job.status === "inspecting" ? job : tryStatus(job, "inspecting", at);
    if (!inspecting && job.status === "received") throw conflict(`Job ${job.id} can't start inspection`);
    const report = await this.runInspection(inspecting ?? job, previous);
    await this.options.findings.put(job.id, report);

    const entries: AuditEntry[] = inspecting && inspecting !== job ? [statusEntry(at, job.status, "inspecting")] : [];
    let decided: Job;
    if (inspecting) {
      const applied = stripAudit(applyPreflightReport<PreflightJob>(inspecting, report, { at }));
      decided = applied.job;
      entries.push(...applied.entries);
    } else {
      decided = this.settleInPlace(job, report, at, entries);
    }
    await this.options.jobs.save(decided);
    await this.publish(job.id, actor, entries);
    return decided;
  }

  /** The preflight decision for a `ready` or preflight-held job that stays out of `inspecting`. */
  private settleInPlace(job: Job, report: PreflightReport, at: string, entries: AuditEntry[]): Job {
    const decision = decide(report);
    entries.push({ at, type: "preflight.completed", detail: { inspector: report.inspector, profileId: report.profileId, summary: report.summary } });
    if (decision.status === "held") {
      const hold: Hold = { reason: "preflight", since: job.hold?.since ?? at, detail: decision.detail };
      if (job.status === "held") return { ...job, hold, updatedAt: at };
      const held = tryStatus(job, "held", at);
      if (!held) throw conflict(`Job ${job.id} can't be held`);
      entries.push(statusEntry(at, job.status, "held"));
      return { ...held, hold };
    }
    if (job.status !== "held") return job;
    const released = tryStatus(job, "ready", at);
    if (!released) throw conflict(`Job ${job.id} can't leave held`);
    entries.push(statusEntry(at, job.status, released.status));
    return withoutHold(released);
  }

  /** Runs the job's profile. With a previous report, only the edit-dependent checks rerun. */
  private async runInspection(job: Job, previous: PreflightReport | undefined): Promise<PreflightReport> {
    const at = this.now();
    const hotFolder = job.hotFolderId ? await this.options.hotFolders?.get(job.hotFolderId) : undefined;
    const profileId = selectProfileId(job, hotFolder);
    const profile = await this.options.profiles.find(profileId);
    if (!profile) {
      return serviceReport(at, profileId, {
        message: `Preflight profile ${profileId} does not exist`,
        data: { rule: "profile-missing", profileId },
      });
    }
    const checks = profileToChecks(profile);
    const partial = previous !== undefined && previous.profileId === profileId && !previous.findings.some((f) => f.checkId === SERVICE_CHECK_ID);
    const requested: Record<string, CheckConfig> = partial ? reinspectionChecks(checks) : checks;
    let inspected: PreflightReport;
    try {
      inspected = await this.options.inspector.inspect({
        document: { kind: "file", path: this.sourcePath(job) },
        profileId,
        checks: requested,
        context: inspectContextOf(job),
      });
    } catch (error) {
      // An inspection that can't run must not let the job through.
      return serviceReport(at, profileId, {
        message: `Inspection failed: ${(error as Error).message}`.slice(0, 2000),
        data: { rule: "inspection-failed" },
      });
    }
    // Edits apply to the fresh findings only; merged ones from `previous` were already adjusted.
    const report = applyEditsToImageFindings(job, inspected);
    return partial && previous ? mergeReinspection(previous, report, Object.keys(requested)) : report;
  }

  private async publish(jobId: string, actor: Actor, entries: readonly AuditEntry[]): Promise<void> {
    for (const entry of entries) {
      const detail = { ...(entry.detail ?? {}), at: entry.at };
      if (entry.type === "preflight.completed") await this.options.events.recordStep(jobId, STAGE, "completed", detail);
      else await this.options.events.recordOperatorAction(jobId, actor, entry.type, detail);
    }
  }

  private sourcePath(job: Job): string {
    const source = job.sourceFiles[0];
    if (!source) throw conflict(`Job ${job.id} has no source file`);
    return this.options.blobPath(source.storageKey);
  }

  private async job(id: string): Promise<Job> {
    const job = await this.options.jobs.get(id);
    if (!job) throw notFound("Job", id);
    return job;
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  /** One operation per job at a time, so a slow inspection can't race an edit. */
  private serialized<T>(jobId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(jobId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.locks.set(jobId, settled);
    void settled.then(() => {
      if (this.locks.get(jobId) === settled) this.locks.delete(jobId);
    });
    return run;
  }
}
