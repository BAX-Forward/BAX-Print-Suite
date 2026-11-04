/**
 * Spec 001 additions to the job model: priority bounds, inspection results, job steps, hot
 * folders, and the logger port. Job, JobStatus and JobTicket live in job.ts, status.ts and
 * ticket.ts.
 */

import type { JobTicket } from './ticket.js';

export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 100;
export const DEFAULT_PRIORITY = 50;

export function isValidPriority(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_PRIORITY &&
    value <= MAX_PRIORITY
  );
}

/** A rectangle in PDF points (1/72 in). */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface JobPage {
  /** Zero-based page index. */
  readonly index: number;
  readonly widthPt: number;
  readonly heightPt: number;
  /** Present only when the document declares a trim box for the page. */
  readonly trimBox?: Box;
}

export interface JobError {
  readonly code: string;
  readonly message: string;
}

export const JOB_STAGES = [
  'intake',
  'preflight',
  'layout',
  'render',
  'color',
  'screening',
  'output',
  'cut',
] as const;

export type JobStage = (typeof JOB_STAGES)[number];

/** Step-level states are separate from job states (ARCHITECTURE.md §4). */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobStep {
  readonly id: string;
  readonly stage: JobStage;
  readonly status: StepStatus;
  readonly pluginId?: string;
  readonly pluginVersion?: string;
  readonly deviceId?: string;
  /** Storage keys read by the step. */
  readonly inputs: readonly string[];
  /** Storage keys written by the step. */
  readonly outputs: readonly string[];
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: JobError;
}

export interface HotFolderSettings {
  /** Where originals go after successful intake. Relative paths resolve against the hot folder. */
  readonly moveProcessedTo: string;
  readonly defaultPriority: number;
  /** Basename glob patterns (`*` and `?`), matched case-insensitively. */
  readonly filePatterns: readonly string[];
  /** Skip files whose sha256 matches a live job from the same hot folder. */
  readonly dedupe: boolean;
  readonly ticketTemplate?: JobTicket;
  /** Preflight profile for jobs from this folder (Spec 007 FR2). A per-job ticket profile overrides it. */
  readonly preflightProfileId?: string;
}

export const DEFAULT_HOT_FOLDER_SETTINGS: Readonly<HotFolderSettings> = Object.freeze({
  moveProcessedTo: '_processed',
  defaultPriority: DEFAULT_PRIORITY,
  filePatterns: Object.freeze(['*.pdf']),
  dedupe: true,
});

/** Subfolder (relative to the hot folder) that receives files whose intake failed. */
export const FAILED_SUBFOLDER = '_failed';

export function withHotFolderDefaults(settings: Partial<HotFolderSettings> = {}): HotFolderSettings {
  return {
    moveProcessedTo: settings.moveProcessedTo ?? DEFAULT_HOT_FOLDER_SETTINGS.moveProcessedTo,
    defaultPriority: settings.defaultPriority ?? DEFAULT_HOT_FOLDER_SETTINGS.defaultPriority,
    filePatterns:
      settings.filePatterns && settings.filePatterns.length > 0
        ? [...settings.filePatterns]
        : [...DEFAULT_HOT_FOLDER_SETTINGS.filePatterns],
    dedupe: settings.dedupe ?? DEFAULT_HOT_FOLDER_SETTINGS.dedupe,
    ...(settings.ticketTemplate ? { ticketTemplate: settings.ticketTemplate } : {}),
    ...(settings.preflightProfileId ? { preflightProfileId: settings.preflightProfileId } : {}),
  };
}

export interface HotFolder {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly settings: HotFolderSettings;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Minimal structured logger accepted by packages that log. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const noopLogger: Logger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
