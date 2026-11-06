import type { Hold } from './hold.js';
import type { InkLimitSetting } from './ink-limit-setting.js';
import type { PlaneCurvesSetting } from './plane-curves-setting.js';
import type { ScreeningSetting } from './screening-setting.js';
import type { SourceFormat } from './source-format.js';
import type { JobStatus } from './status.js';
import type { JobTicket } from './ticket.js';
import type { JobError, JobPage, JobStep } from './types.js';
import type { WhiteInkSetting } from './white-ink-setting.js';

/** Archive axis, orthogonal to the print status machine. */
export type JobLifecycle = 'active' | 'archived' | 'trashed';

export const JOB_LIFECYCLES: readonly JobLifecycle[] = ['active', 'archived', 'trashed'];

/** `normalized`: a PDF/X or PDF/A rewrite of a source file (Spec 007 FR3). */
export type ArtifactRole = 'layout' | 'cut' | 'preview' | 'normalized';

export const ARTIFACT_ROLES: readonly ArtifactRole[] = ['layout', 'cut', 'preview', 'normalized'];

export interface SourceFile {
  readonly name: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly storageKey: string;
}

export interface JobArtifact extends SourceFile {
  readonly role: ArtifactRole;
}

export interface Job {
  readonly id: string;
  readonly name: string;
  readonly customerRef?: string;
  readonly status: JobStatus;
  readonly priority: number;
  readonly hotFolderId?: string;
  readonly deviceId?: string;
  readonly mediumId?: string;
  readonly presetId?: string;
  /** Color setup revision used at render time (Spec 005). */
  readonly colorSetupRevisionId?: string;
  readonly sourceFiles: readonly SourceFile[];
  readonly artifacts: readonly JobArtifact[];
  readonly ticket: JobTicket;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly doneAt?: string;
  readonly lifecycle: JobLifecycle;
  readonly archivedAt?: string;
  readonly trashedAt?: string;
  readonly legalHold: boolean;
  readonly reprintOf?: string;
  /** Spec 031c: format of the first source file from its magic bytes; absent when unrecognized. */
  readonly sourceFormat?: SourceFormat;
  /** Inspection result (Spec 001), set when the job reaches `ready`. */
  readonly pageCount?: number;
  readonly pages?: readonly JobPage[];
  /** Pipeline steps run for this job (Spec 001). */
  readonly steps?: readonly JobStep[];
  /** Why the job failed, when status is `failed`. */
  readonly error?: JobError;
  /** Why the job is held (Spec 007), set only while status is `held`. */
  readonly hold?: Hold;
  /** Spec 038b: requested white ink layer; absent means white ink is off. */
  readonly whiteInk?: WhiteInkSetting;
  /** Spec 039b: requested screening threshold array; absent means no screening is requested. */
  readonly screening?: ScreeningSetting;
  /** Spec 040b: requested total area coverage limit; absent means no ink limit is requested. */
  readonly inkLimit?: InkLimitSetting;
  /** Spec 044b: requested per-channel tone curves; absent means no curves are requested. */
  readonly planeCurves?: PlaneCurvesSetting;
}
