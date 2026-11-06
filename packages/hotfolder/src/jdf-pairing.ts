import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { effectiveFilePatterns, nextUlid, noopLogger, type HotFolder, type JobError } from '@bax-print/core';
import { JDF_TICKET_MAX_BYTES, readJdfTicket, type JdfTicket } from '@bax-print/inspect';
import {
  failedDirOf,
  ingestFile,
  moveQuietly,
  processedDirOf,
  toJobError,
  type IntakeDeps,
  type IntakeOutcome,
} from './intake.js';
import { isCandidateFileName, isTemporaryFileName } from './patterns.js';

/**
 * Spec 037b: hot-folder JDF pairing. A ticket is paired with a file only when its single FileSpec
 * URL is a plain file name in the hot folder itself. URLs are never fetched, resolved or opened:
 * the only file system access is a bounded read of the ticket and an lstat / realpath of the one
 * named file inside the folder.
 */

/** Why a ticket was not paired. */
export const JDF_PAIRING_ERROR_CODES = Object.freeze([
  'JDF_NO_FILE_REF',
  'JDF_MULTIPLE_FILE_REFS',
  'JDF_UNSAFE_FILE_REF',
  'JDF_FILE_MISSING',
  'JDF_INVALID',
  'JDF_TRUNCATED',
] as const);

export type JdfPairingErrorCode = (typeof JDF_PAIRING_ERROR_CODES)[number];

export type JdfPairing =
  | { readonly kind: 'paired'; readonly ticket: JdfTicket; readonly sourcePath: string }
  | { readonly kind: 'unpaired'; readonly error: JobError };

/** Spec 037b: an intake outcome for a ticket; `movedTo` is the ticket's, `pairedFile` the named file's. */
export type JdfIntakeOutcome = IntakeOutcome & {
  readonly pairedFile?: { readonly path: string; readonly movedTo: string | undefined };
};

/** The longest file name a reference may hold (common file system limit). */
const MAX_FILE_NAME_LENGTH = 255;
/** File names quoted in messages are cut to this length. */
const MAX_NAME_IN_MESSAGE = 64;

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const DELETE = 0x7f;
const FIRST_PRINTABLE = 0x20;

/** True for a `.jdf` file name, compared case-insensitively. */
export function isJdfFileName(fileName: string): boolean {
  return extname(fileName).toLowerCase() === '.jdf';
}

/** A separator, a colon (any URL scheme or drive letter), NUL or another control character. */
function hasUnsafeChar(name: string): boolean {
  for (let at = 0; at < name.length; at += 1) {
    const code = name.charCodeAt(at);
    if (code < FIRST_PRINTABLE || code === DELETE || code === SLASH || code === BACKSLASH || code === COLON) {
      return true;
    }
  }
  return false;
}

/** Without a separator or colon a name cannot be absolute, so only these checks are needed. */
function isPlainName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_FILE_NAME_LENGTH &&
    name !== '.' &&
    name.includes('..') === false &&
    hasUnsafeChar(name) === false
  );
}

/**
 * The file name a FileSpec URL names when it is a plain relative name in the same folder, else
 * `undefined`. Percent escapes are decoded once and the decoded name must pass the same checks
 * (so `%2e%2e%2f` or `%00` are refused) and hold no further `%`.
 */
export function plainFileRefName(url: string): string | undefined {
  if (isPlainName(url) === false) return undefined;
  if (url.includes('%') === false) return url;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    return undefined;
  }
  return isPlainName(decoded) && decoded.includes('%') === false ? decoded : undefined;
}

/** Ticket facts carried as job metadata. Only what `readJdfTicket` reports, no vendor extensions. */
export function jdfTicketMetadata(ticket: JdfTicket): Readonly<Record<string, string>> {
  const mediaName = ticket.media?.name;
  return {
    ...(ticket.jobId === undefined ? {} : { 'jdf.jobId': ticket.jobId }),
    ...(ticket.jobPartId === undefined ? {} : { 'jdf.jobPartId': ticket.jobPartId }),
    ...(ticket.quantity === undefined ? {} : { 'jdf.quantity': String(ticket.quantity) }),
    ...(mediaName === undefined ? {} : { 'jdf.mediaName': mediaName }),
  };
}

function unpaired(code: JdfPairingErrorCode, message: string): JdfPairing {
  return { kind: 'unpaired', error: { code, message } };
}

function quoted(name: string): string {
  return JSON.stringify(name.length > MAX_NAME_IN_MESSAGE ? `${name.slice(0, MAX_NAME_IN_MESSAGE)}...` : name);
}

/** One byte more than the reader looks at, so it can tell that the ticket was cut. */
async function readTicketPrefix(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = new Uint8Array(JDF_TICKET_MAX_BYTES + 1);
    let filled = 0;
    while (filled < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.byteLength - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

/** Checks that `name` is a regular file directly in `root`, not a link and not resolving elsewhere. */
async function locate(root: string, name: string, ticket: JdfTicket): Promise<JdfPairing> {
  const sourcePath = join(root, name);
  let stats;
  try {
    stats = await lstat(sourcePath);
  } catch {
    return unpaired('JDF_FILE_MISSING', `the ticket names ${quoted(name)}, which is not in the hot folder`);
  }
  if (stats.isSymbolicLink()) {
    return unpaired('JDF_UNSAFE_FILE_REF', `the ticket names ${quoted(name)}, which is a symbolic link`);
  }
  if (stats.isFile() === false) {
    return unpaired('JDF_FILE_MISSING', `the ticket names ${quoted(name)}, which is not a regular file`);
  }
  const [realSource, realRoot] = await Promise.all([realpath(sourcePath), realpath(root)]);
  if (dirname(realSource) === realRoot) {
    return { kind: 'paired', ticket, sourcePath };
  }
  return unpaired('JDF_UNSAFE_FILE_REF', `the ticket names ${quoted(name)}, which resolves outside the hot folder`);
}

/**
 * Reads the ticket at `ticketPath` and finds the one file it names in `folder`. Never guesses: a
 * ticket without exactly one safe reference to an existing file in the folder stays unpaired.
 */
export async function pairJdfTicket(ticketPath: string, folder: HotFolder): Promise<JdfPairing> {
  const result = readJdfTicket(await readTicketPrefix(ticketPath));
  if (result.kind === 'error') {
    return unpaired(result.code === 'TRUNCATED' ? 'JDF_TRUNCATED' : 'JDF_INVALID', result.message);
  }
  if (result.truncated) {
    return unpaired('JDF_TRUNCATED', 'the ticket was cut off before all of its file references could be read');
  }
  if (result.hasEntityDecl) {
    return unpaired('JDF_INVALID', 'the ticket declares entities');
  }
  const { count, urls } = result.fileRefs;
  const url = urls[0];
  if (count === 0 || url === undefined) {
    return unpaired('JDF_NO_FILE_REF', 'the ticket names no file');
  }
  if (count > 1) {
    return unpaired('JDF_MULTIPLE_FILE_REFS', `the ticket names ${count} files; exactly one is required`);
  }
  const name = plainFileRefName(url);
  if (name === undefined) {
    return unpaired('JDF_UNSAFE_FILE_REF', `the file reference ${quoted(url)} is not a plain file name in the hot folder`);
  }
  if (isJdfFileName(name) || isCandidateFileName(name, effectiveFilePatterns(folder.settings)) === false) {
    return unpaired('JDF_UNSAFE_FILE_REF', `the ticket names ${quoted(name)}, which the hot folder does not take in`);
  }
  return locate(resolve(folder.path), name, result);
}

/** Same device and inode: the same file, whatever case or spelling the two paths use. */
async function isSameFile(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([lstat(a), lstat(b)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

/** The ticket in the folder that pairs with `sourcePath`, if any; such a file waits for its ticket. */
export async function findClaimingTicket(sourcePath: string, folder: HotFolder): Promise<string | undefined> {
  const root = resolve(folder.path);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() === false || isJdfFileName(entry.name) === false || isTemporaryFileName(entry.name)) {
      continue;
    }
    const ticketPath = join(root, entry.name);
    const pairing = await pairJdfTicket(ticketPath, folder).catch(() => undefined);
    if (pairing?.kind === 'paired' && (await isSameFile(pairing.sourcePath, sourcePath))) {
      return ticketPath;
    }
  }
  return undefined;
}

function ticketTag(outcome: IntakeOutcome): string {
  if (outcome.kind === 'ready') return outcome.job.id;
  if (outcome.kind === 'duplicate') return `dup-${nextUlid()}`;
  return outcome.job?.id ?? nextUlid();
}

/**
 * Ingests one stable JDF ticket. A paired ticket makes one job from the file it names (via
 * {@link ingestFile}, with the ticket facts as metadata) and then moves next to it, into
 * `_processed` or `_failed`. An unpaired ticket fails with a `JDF_*` code and moves to `_failed`;
 * no file is touched. Never throws.
 */
export async function ingestJdfTicket(path: string, folder: HotFolder, deps: IntakeDeps): Promise<JdfIntakeOutcome> {
  const logger = deps.logger ?? noopLogger;
  let pairing: JdfPairing;
  try {
    pairing = await pairJdfTicket(path, folder);
  } catch (error) {
    pairing = unpaired('JDF_INVALID', `the ticket could not be read: ${toJobError(error).message}`);
  }
  if (pairing.kind === 'unpaired') {
    logger.warn('jdf ticket not paired', { path, error: pairing.error });
    const movedTo = await moveQuietly(path, failedDirOf(folder), nextUlid(), logger);
    return { kind: 'failed', job: undefined, error: pairing.error, movedTo };
  }
  const outcome = await ingestFile(pairing.sourcePath, folder, deps, { metadata: jdfTicketMetadata(pairing.ticket) });
  const target = outcome.kind === 'failed' ? failedDirOf(folder) : processedDirOf(folder);
  const movedTo = await moveQuietly(path, target, ticketTag(outcome), logger);
  return { ...outcome, movedTo, pairedFile: { path: pairing.sourcePath, movedTo: outcome.movedTo } };
}
