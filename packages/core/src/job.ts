import type { JobStatus } from './status.js';
import type { JobTicket } from './ticket.js';
import type { JobError, JobPage, JobStep } from './types.js';

/** Archive axis, orthogonal to the print status machine. */
export type JobLifecycle = 'active' | 'archived' | 'trashed';

export const JOB_LIFECYCLES: readonly JobLifecycle[] = ['active', 'archived', 'trashed'];

export type ArtifactRole = 'layout' | 'cut' | 'preview';

export const ARTIFACT_ROLES: readonly ArtifactRole[] = ['layout', 'cut', 'preview'];

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
  /** Inspection result (Spec 001), set when the job reaches `ready`. */
  readonly pageCount?: number;
  readonly pages?: readonly JobPage[];
  /** Pipeline steps run for this job (Spec 001). */
  readonly steps?: readonly JobStep[];
  /** Why the job failed, when status is `failed`. */
  readonly error?: JobError;
}
