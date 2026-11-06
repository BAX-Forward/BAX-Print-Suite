import { createHash } from 'node:crypto';
import type { JobStatus } from '@bax-print/core';
import { EventTypes, type CloudEvent, type EventBus } from '@bax-print/events';
import type { CutJobLookup } from './cut-routes.js';
import type { JobService } from './jobs.js';
import { readSource } from './pdf-cut-extractor.js';
import {
  parsePrintOutputFlag,
  PRINT_OUTPUT_ENV,
  PrintOutputError,
  type PrintOutput,
  type PrintSubmissionLedger,
} from './print-output.js';

export const PRINT_AUTO_ROUTE_ENV = 'BPS_PRINT_AUTO_ROUTE';

/** Spec 034b: the status a job is routed in: prepress is finished and the job is ready to print. */
export const PRINT_AUTO_ROUTE_STATUS: JobStatus = 'ready';

/** The step stage a failed automatic submission is recorded under in the job history. */
export const PRINT_AUTO_ROUTE_STAGE = 'print-auto-route';

/** Plugin codes for a device that takes no such document; the job is skipped, never retried. */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['DOCUMENT_INPUT_UNSUPPORTED', 'FORMAT_NOT_ACCEPTED']);

/**
 * Spec 034b: `true` only for `BPS_PRINT_AUTO_ROUTE=1`; unset is off. Any other value, or `1`
 * without `BPS_PRINT_OUTPUT=1`, stops startup.
 */
export function parsePrintAutoRouteFlag(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[PRINT_AUTO_ROUTE_ENV];
  if (value === undefined) return false;
  if (value !== '1') throw new Error(`${PRINT_AUTO_ROUTE_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
  if (!parsePrintOutputFlag(env)) throw new Error(`${PRINT_AUTO_ROUTE_ENV}=1 needs ${PRINT_OUTPUT_ENV}=1`);
  return true;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Spec 034b: the submission id of a job's automatic print, the same for the same job and document.
 * It is a UUID-shaped string (version 8, RFC 9562 custom) over the sha256 of both.
 */
export function autoRouteSubmissionId(jobId: string, documentSha256: string): string {
  const hex = sha256Hex(`bps-print-auto-route\u0000${jobId}\u0000${documentSha256}`);
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The server log; only ids and codes are logged, never settings or document bytes. */
export interface PrintAutoRouteLog {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface PrintAutoRouteDeps {
  readonly bus: EventBus;
  readonly jobs: CutJobLookup;
  readonly output: PrintOutput;
  /** Absolute path of a stored blob, the resolver the print routes read source files with. */
  readonly blobPath: (storageKey: string) => string;
  /** Where each submission's job is recorded, shared with the print routes. */
  readonly ledger: PrintSubmissionLedger;
  readonly log: PrintAutoRouteLog;
  /** Records a failed submission as a failed step in the job history, when given. */
  readonly history?: Pick<JobService, 'recordStep'>;
}

export interface PrintAutoRoute {
  /** Unsubscribes from the bus; routes already started still finish. */
  stop(): void;
  /** Resolves once every started route has settled. */
  idle(): Promise<void>;
}

/** The job id of a `job.status.changed` event into the routed status, else `undefined`. */
function finishedJobId(event: CloudEvent): string | undefined {
  if (event.type !== EventTypes.jobStatusChanged) return undefined;
  const { data } = event;
  if (typeof data !== 'object' || data === null) return undefined;
  if (!('to' in data) || data.to !== PRINT_AUTO_ROUTE_STATUS) return undefined;
  return 'jobId' in data && typeof data.jobId === 'string' && data.jobId !== '' ? data.jobId : undefined;
}

/**
 * Spec 034b: sends every job that changes to `ready` (from any source, hot folders included) to
 * the print output once. The submission id comes from the job id and the document's sha256, and
 * the ids already used are kept in memory, so a repeated event never submits twice. A device that
 * takes no such document is skipped with one log line; any other failure is logged, recorded in
 * the job history when `history` is given, and not retried.
 */
export function startPrintAutoRoute(deps: PrintAutoRouteDeps): PrintAutoRoute {
  const submitted = new Set<string>();
  const pending = new Set<Promise<void>>();
  const unsubscribe = deps.bus.subscribe((event) => {
    const jobId = finishedJobId(event);
    if (jobId === undefined) return;
    const routing: Promise<void> = route(deps, submitted, jobId).finally(() => pending.delete(routing));
    pending.add(routing);
  });
  return {
    stop: unsubscribe,
    idle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

/** Never rejects: every failure ends in `failed`. */
async function route(deps: PrintAutoRouteDeps, submitted: Set<string>, jobId: string): Promise<void> {
  let submissionId: string | undefined;
  try {
    const job = await deps.jobs.get(jobId);
    if (!job) {
      deps.log.warn({ jobId }, 'print auto-route skipped the job: it no longer exists');
      return;
    }
    if (job.sourceFormat !== 'pdf') {
      deps.log.info({ jobId, sourceFormat: job.sourceFormat ?? 'unrecognized' }, 'print auto-route skipped the job: only PDF is sent');
      return;
    }
    const bytes = await readSource(job, deps.blobPath);
    if (!bytes) {
      deps.log.warn({ jobId }, 'print auto-route skipped the job: it has no source file');
      return;
    }
    submissionId = autoRouteSubmissionId(job.id, sha256Hex(bytes));
    // Checked and added with no await in between, so concurrent events for one document submit once.
    if (submitted.has(submissionId)) return;
    submitted.add(submissionId);
    const submission = await deps.output.submit(job, bytes, 'pdf', { submissionId });
    deps.ledger.record(submission.outputJobId, job.id);
    deps.log.info({ jobId, outputJobId: submission.outputJobId }, 'print auto-route submitted the job');
  } catch (error) {
    await failed(deps, jobId, submissionId, error);
  }
}

async function failed(deps: PrintAutoRouteDeps, jobId: string, submissionId: string | undefined, error: unknown): Promise<void> {
  const code = error instanceof PrintOutputError ? error.code : 'AUTO_ROUTE_FAILED';
  if (UNSUPPORTED_CODES.has(code)) {
    deps.log.info({ jobId, code }, 'print auto-route skipped the job: the printer takes no such document');
    return;
  }
  const ids = submissionId === undefined ? { jobId } : { jobId, submissionId };
  deps.log.error({ ...ids, code }, 'print auto-route failed; it is not retried');
  if (deps.history === undefined) return;
  try {
    await deps.history.recordStep(jobId, PRINT_AUTO_ROUTE_STAGE, 'failed', { ...ids, code });
  } catch {
    deps.log.error({ jobId, code }, 'print auto-route could not record the failure on the job');
  }
}
