import { lstat, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FORMAT_EXTENSIONS, isDocumentFormat, type DocumentFormat, type FolderOutputConfig } from './config.js';
import { FolderOutputError, hasErrno } from './errors.js';

/** Suffix of the temporary file written before the atomic rename. Watchers should ignore it. */
export const PART_SUFFIX = '.part';
/** Suffix of the ticket written next to the output: `<jobId>.bps-ticket.json`. */
export const TICKET_SUFFIX = '.bps-ticket.json';
/** Version of the ticket layout documented in README.md. */
export const TICKET_VERSION = 1;

/**
 * 1 to 128 characters of letters, digits, `.`, `_` and `-`; starts with a letter or digit and does
 * not end with a dot. No separators, so a job id can only ever name a file directly in outputDir.
 */
const JOB_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;

export interface TicketMediaInput {
  name?: string;
  widthMm?: number;
  heightMm?: number;
}

/** A finished document handed to the folder. */
export interface DocumentSubmission {
  jobId: string;
  /** One of the configured `acceptedFormats`. */
  format: string;
  data: Uint8Array;
  /** Positive integer; defaults to 1. Recorded in the ticket only. */
  copies?: number;
  media?: TicketMediaInput;
}

/** `<jobId>.bps-ticket.json`, documented in README.md. */
export interface BpsTicket {
  bpsTicket: number;
  jobId: string;
  /** Output file name, relative to the output folder. */
  file: string;
  format: DocumentFormat;
  copies: number;
  media: { name: string | null; widthMm: number | null; heightMm: number | null };
  /** ISO 8601 UTC timestamp. */
  createdAt: string;
}

export interface FolderSubmitResult {
  jobId: string;
  outputPath: string;
  ticketPath: string | null;
}

/**
 * `queued`: the output file is still in the folder. `done`: something outside BPS removed or moved
 * it. `cancelled`: BPS removed it through `cancel`.
 */
export type FolderJobState = 'queued' | 'done' | 'cancelled';

export interface FolderJobStatus {
  jobId: string;
  state: FolderJobState;
  outputPath: string;
}

interface FolderJob {
  readonly jobId: string;
  readonly outputPath: string;
  readonly ticketPath: string | null;
  readonly state: FolderJobState;
}

export function checkJobId(jobId: unknown): string {
  if (typeof jobId === 'string' && JOB_ID_PATTERN.test(jobId) && jobId.includes('..') === false) return jobId;
  throw new FolderOutputError(
    'INVALID_JOB_ID',
    `job id must be 1-128 letters, digits, ".", "_" or "-", start with a letter or digit, not end with "." and not contain ".."; got ${JSON.stringify(jobId)}`,
  );
}

/** Joins a file name to the output folder and refuses anything that would land elsewhere. */
function pathInside(dir: string, fileName: string): string {
  const path = join(dir, fileName);
  if (dirname(path) === dir) return path;
  throw new FolderOutputError('INVALID_JOB_ID', `refusing to write outside the output folder: ${fileName}`);
}

function checkCopies(copies: unknown): number {
  if (copies === undefined) return 1;
  if (typeof copies === 'number' && Number.isInteger(copies) && copies >= 1) return copies;
  throw new FolderOutputError('INVALID_SUBMISSION', 'copies must be a positive integer');
}

function optionalSize(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  throw new FolderOutputError('INVALID_SUBMISSION', `media.${field} must be a positive number of millimetres`);
}

function checkMedia(media: TicketMediaInput | undefined): BpsTicket['media'] {
  // Submissions arrive from outside the type system, so re-check every field at runtime.
  const name: unknown = media?.name;
  if (name === undefined || typeof name === 'string') {
    return {
      name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : null,
      widthMm: optionalSize(media?.widthMm, 'widthMm'),
      heightMm: optionalSize(media?.heightMm, 'heightMm'),
    };
  }
  throw new FolderOutputError('INVALID_SUBMISSION', 'media.name must be a string');
}

function checkData(data: unknown): Uint8Array {
  if (data instanceof Uint8Array && data.byteLength > 0) return data;
  throw new FolderOutputError('INVALID_SUBMISSION', 'data must be a non-empty byte array');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrno(error, 'ENOENT')) return false;
    throw new FolderOutputError('WRITE_FAILED', `cannot inspect ${path}: ${describeError(error)}`);
  }
}

/**
 * Writes `<finalPath>.part` in the same directory, fsyncs it, then renames it into place, so a
 * watcher sees either nothing or the complete file. Never replaces an existing `finalPath`.
 */
async function writeAtomic(finalPath: string, data: Uint8Array): Promise<void> {
  const partPath = `${finalPath}${PART_SUFFIX}`;
  try {
    // A part file left by an interrupted write is ours to replace. `rm` removes a symlink itself,
    // and the exclusive open below never follows one, so the bytes cannot land outside the folder.
    await rm(partPath, { force: true });
    const handle = await open(partPath, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await pathExists(finalPath)) {
      throw new FolderOutputError('OUTPUT_EXISTS', `${finalPath} already exists`);
    }
    await rename(partPath, finalPath);
  } catch (error) {
    await rm(partPath, { force: true });
    if (error instanceof FolderOutputError) throw error;
    throw new FolderOutputError('WRITE_FAILED', `could not write ${finalPath}: ${describeError(error)}`);
  }
}

function encodeTicket(ticket: BpsTicket): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(ticket, null, 2)}\n`);
}

function toStatus(job: FolderJob): FolderJobStatus {
  return { jobId: job.jobId, state: job.state, outputPath: job.outputPath };
}

/** The file-drop core: atomic writes into one folder and per-job status, with no device protocol. */
export class FolderOutput {
  private readonly jobs = new Map<string, FolderJob>();
  private readonly inFlight = new Set<string>();

  constructor(
    readonly config: FolderOutputConfig,
    private readonly now: () => Date,
  ) {}

  async submit(submission: DocumentSubmission): Promise<FolderSubmitResult> {
    const jobId = checkJobId(submission.jobId);
    const format = this.checkFormat(submission.format);
    const copies = checkCopies(submission.copies);
    const media = checkMedia(submission.media);
    const data = checkData(submission.data);
    if (this.inFlight.has(jobId)) {
      throw new FolderOutputError('OUTPUT_EXISTS', `job ${jobId} is already being written`);
    }
    this.inFlight.add(jobId);
    try {
      return await this.write(jobId, format, data, copies, media);
    } finally {
      this.inFlight.delete(jobId);
    }
  }

  /** Current state, refreshed from the folder. */
  async status(jobId: string): Promise<FolderJobStatus> {
    const job = this.requireJob(jobId);
    if (job.state === 'queued' && (await pathExists(job.outputPath)) === false) {
      return toStatus(this.replace({ ...job, state: 'done' }));
    }
    return toStatus(job);
  }

  /** Removes the output and its ticket while they are still waiting; a consumed job stays `done`. */
  async cancel(jobId: string): Promise<FolderJobStatus> {
    await this.status(jobId);
    const job = this.requireJob(jobId);
    if (job.state === 'queued') {
      try {
        await unlink(job.outputPath);
      } catch (error) {
        if (hasErrno(error, 'ENOENT')) return toStatus(this.replace({ ...job, state: 'done' }));
        throw new FolderOutputError('WRITE_FAILED', `could not remove ${job.outputPath}: ${describeError(error)}`);
      }
      if (typeof job.ticketPath === 'string') await rm(job.ticketPath, { force: true });
      return toStatus(this.replace({ ...job, state: 'cancelled' }));
    }
    return toStatus(job);
  }

  /** Job ids whose output is still in the folder. */
  async queuedJobIds(): Promise<string[]> {
    const queued: string[] = [];
    for (const jobId of [...this.jobs.keys()]) {
      if ((await this.status(jobId)).state === 'queued') queued.push(jobId);
    }
    return queued;
  }

  private checkFormat(format: unknown): DocumentFormat {
    if (isDocumentFormat(format) && this.config.acceptedFormats.includes(format)) return format;
    throw new FolderOutputError(
      'FORMAT_NOT_ACCEPTED',
      `format ${JSON.stringify(format)} is not accepted; accepted: ${this.config.acceptedFormats.join(', ')}`,
    );
  }

  private async write(
    jobId: string,
    format: DocumentFormat,
    data: Uint8Array,
    copies: number,
    media: BpsTicket['media'],
  ): Promise<FolderSubmitResult> {
    const dir = this.config.outputDir;
    const fileName = `${jobId}.${FORMAT_EXTENSIONS[format]}`;
    const outputPath = pathInside(dir, fileName);
    const ticketPath = this.config.writeTicket ? pathInside(dir, `${jobId}${TICKET_SUFFIX}`) : null;
    const targets = typeof ticketPath === 'string' ? [ticketPath, outputPath] : [outputPath];
    for (const target of targets) {
      if (await pathExists(target)) throw new FolderOutputError('OUTPUT_EXISTS', `${target} already exists`);
    }
    // The ticket goes first, so a watcher that reacts to the output file can already read it.
    if (typeof ticketPath === 'string') {
      const ticket: BpsTicket = {
        bpsTicket: TICKET_VERSION,
        jobId,
        file: fileName,
        format,
        copies,
        media,
        createdAt: this.now().toISOString(),
      };
      await writeAtomic(ticketPath, encodeTicket(ticket));
    }
    try {
      await writeAtomic(outputPath, data);
    } catch (error) {
      if (typeof ticketPath === 'string') await rm(ticketPath, { force: true });
      throw error;
    }
    this.replace({ jobId, outputPath, ticketPath, state: 'queued' });
    return { jobId, outputPath, ticketPath };
  }

  private requireJob(jobId: string): FolderJob {
    const job = this.jobs.get(checkJobId(jobId));
    if (job === undefined) throw new FolderOutputError('UNKNOWN_JOB', `unknown job ${jobId}`);
    return job;
  }

  private replace(job: FolderJob): FolderJob {
    this.jobs.set(job.jobId, job);
    return job;
  }
}
