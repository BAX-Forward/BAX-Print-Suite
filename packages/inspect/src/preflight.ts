import { withStatus, type Job, type JobStatus, type JobTicket } from "@bax-print/core";
import { summarize, type CheckConfig, type InspectContext, type PreflightReport } from "@bax-print/plugin-sdk";
import { DEFAULT_PROFILE } from "./profile.js";
import { BUILTIN_CHECKS } from "./registry.js";

/**
 * Preflight decisions on the job (Spec 007 FR2, FR5): any `error` finding holds the job with
 * reason `preflight`; an operator may release the hold with a reason, which is written to the
 * audit trail. Status changes go through core's `withStatus`, so the core status machine
 * decides what is legal: a preflight hold is `inspecting → ready → held`, and a release is
 * `held → ready` (Spec 007). Queuing is a later operator step.
 */

/** Checks whose result depends on the job's edits. They rerun when the edits change (FR5). */
export const EDIT_DEPENDENT_CHECKS: readonly string[] = ["document", "printable-width", "image-resolution", "color-spaces"];

export interface JobHold {
  readonly reason: string;
  readonly detail?: string;
  readonly since: string;
}

export interface AuditEntry {
  readonly at: string;
  readonly type: string;
  readonly actor?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** A core job plus the preflight hold and audit trail this package records on it. */
export type PreflightJob = Job & {
  readonly hold?: JobHold;
  readonly audit?: readonly AuditEntry[];
};

export type PreflightDecision = { status: "ready" } | { status: "held"; detail: string };

export function decide(report: PreflightReport): PreflightDecision {
  const errors = report.findings.filter((f) => f.severity === "error");
  if (errors.length === 0) return { status: "ready" };
  const checks = [...new Set(errors.map((f) => f.checkId))].join(", ");
  return { status: "held", detail: `${errors.length} preflight error${errors.length === 1 ? "" : "s"} (${checks})` };
}

export interface ActionOptions {
  at: string;
  actor?: string;
}

function withAudit<T extends PreflightJob>(job: T, options: ActionOptions, type: string, detail: Record<string, unknown>): T {
  const entry: AuditEntry = { at: options.at, type, ...(options.actor !== undefined ? { actor: options.actor } : {}), detail };
  return { ...job, audit: [...(job.audit ?? []), entry] };
}

/** One status step through core's machine, audited; `hold` is kept only while the job is held. */
function moveTo<T extends PreflightJob>(job: T, to: JobStatus, options: ActionOptions, hold?: JobHold): T {
  const moved = { ...(withStatus(job, to, options.at) as T), hold: to === "held" ? hold : undefined };
  return withAudit(moved, options, "status.changed", { from: job.status, to });
}

/** Records a report on an `inspecting` job and moves it to `ready` or `held`. Throws on any other status. */
export function applyPreflightReport<T extends PreflightJob>(job: T, report: PreflightReport, options: ActionOptions): T {
  const decision = decide(report);
  const audited = withAudit(job, options, "preflight.completed", {
    inspector: report.inspector,
    profileId: report.profileId,
    summary: report.summary,
  });
  const ready = moveTo(audited, "ready", options);
  if (decision.status === "ready") return ready;
  return moveTo(ready, "held", options, { reason: "preflight", detail: decision.detail, since: options.at });
}

export class NotPreflightHoldError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} is not held by preflight`);
    this.name = "NotPreflightHoldError";
  }
}

export class OverrideReasonRequiredError extends Error {
  constructor() {
    super("Clearing a preflight hold needs a reason");
    this.name = "OverrideReasonRequiredError";
  }
}

export const MAX_OVERRIDE_REASON_LENGTH = 1000;

/** Releases a preflight hold (`held → ready`), with the operator's reason in the audit trail. */
export function clearPreflightHold<T extends PreflightJob>(job: T, options: ActionOptions & { reason: string }): T {
  if (job.status !== "held" || job.hold?.reason !== "preflight") throw new NotPreflightHoldError(job.id);
  const reason = options.reason.trim().slice(0, MAX_OVERRIDE_REASON_LENGTH);
  if (reason.length === 0) throw new OverrideReasonRequiredError();
  const audited = withAudit(job, options, "preflight.override", { reason, hold: job.hold.detail });
  return moveTo(audited, "ready", options);
}

/** A hot folder's preflight binding. Core hot folders without one are accepted as-is. */
export interface PreflightBinding {
  readonly settings: { readonly preflightProfileId?: string };
}

function processSection(ticket: JobTicket, stage: string): Readonly<Record<string, unknown>> | undefined {
  const value = ticket.process[stage];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Per-job ticket choice (`process.preflight.profileId`), else the hot folder binding, else the default profile. */
export function selectProfileId(job: Pick<Job, "ticket">, hotFolder?: PreflightBinding, fallback = DEFAULT_PROFILE.id): string {
  const fromTicket = processSection(job.ticket, "preflight")?.profileId;
  if (typeof fromTicket === "string" && fromTicket.length > 0) return fromTicket;
  return hotFolder?.settings.preflightProfileId ?? fallback;
}

export interface MediumWidth {
  readonly printableWidthMm?: number;
}

/**
 * The `Inspector/1` context of a job: its edits, the target medium's printable width and the
 * cut-contour names from `process.cut.spotNames`. Edits are passed as stored; the inspector
 * validates them and reports invalid ones as an error finding.
 */
export function inspectContextOf(job: Pick<Job, "ticket">, medium?: MediumWidth): InspectContext {
  const { ticket } = job;
  const spotNames = processSection(ticket, "cut")?.spotNames;
  const cutSpotNames = Array.isArray(spotNames) && spotNames.every((name) => typeof name === "string") ? (spotNames as string[]) : undefined;
  return {
    edits: [...(ticket.edits ?? [])] as InspectContext["edits"],
    ...(medium?.printableWidthMm !== undefined ? { printableWidthMm: medium.printableWidthMm } : {}),
    ...(cutSpotNames ? { cutSpotNames } : {}),
  };
}

/** The subset of a profile's checks that reruns after an edit. */
export function reinspectionChecks(checks: Readonly<Record<string, CheckConfig>>): Record<string, CheckConfig> {
  return Object.fromEntries(Object.entries(checks).filter(([id]) => EDIT_DEPENDENT_CHECKS.includes(id)));
}

const CHECK_ORDER = new Map(BUILTIN_CHECKS.map((check, index) => [check.id, index]));

/**
 * Replaces the findings of the rerun checks in `previous` with those of `rerun`. Findings
 * are ordered by check (built-in order, others after), keeping each check's own order.
 */
export function mergeReinspection(previous: PreflightReport, rerun: PreflightReport, rerunChecks: readonly string[]): PreflightReport {
  const replaced = new Set(rerunChecks);
  const combined = [...previous.findings.filter((f) => !replaced.has(f.checkId)), ...rerun.findings];
  const rank = (checkId: string): number => CHECK_ORDER.get(checkId) ?? CHECK_ORDER.size;
  const findings = combined.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f.checkId) - rank(b.f.checkId) || a.i - b.i).map(({ f }) => f);
  return { ...rerun, profileId: rerun.profileId ?? previous.profileId, conformance: previous.conformance, findings, summary: summarize(findings) };
}
