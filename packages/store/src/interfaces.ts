import {
  BpsError,
  type HotFolder,
  type HotFolderSettings,
  type Job,
  type JobLifecycle,
  type JobStatus,
} from '@bax-print/core';

// ---------------------------------------------------------------------------------------------
// Job queries beyond the Spec 008 JobRepository (job-repository.ts)
// ---------------------------------------------------------------------------------------------

export interface JobQueueQuery {
  /** Match any of these statuses. */
  readonly status?: readonly JobStatus[];
  readonly lifecycle?: JobLifecycle;
  readonly hotFolderId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface JobQueuePage {
  readonly items: Job[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export const DEFAULT_JOB_PAGE_SIZE = 50;
export const MAX_JOB_PAGE_SIZE = 500;

export interface JobQueueIndex {
  /** Jobs in queue order: priority descending, then oldest first. */
  queue(query?: JobQueueQuery): Promise<JobQueuePage>;
  /** A non-terminal job from `hotFolderId` whose first source file has `sha256`, for dedupe. */
  findLiveBySha256(hotFolderId: string, sha256: string): Promise<Job | undefined>;
}

// ---------------------------------------------------------------------------------------------
// Hot folder repository
// ---------------------------------------------------------------------------------------------

export interface NewHotFolder {
  readonly id?: string;
  readonly name: string;
  /** Absolute path; stored resolved. */
  readonly path: string;
  readonly enabled?: boolean;
  readonly settings?: Partial<HotFolderSettings>;
}

export type HotFolderUpdate = Partial<Pick<HotFolder, 'name' | 'enabled'>> & {
  readonly settings?: Partial<HotFolderSettings>;
};

export interface HotFolderRepository {
  list(): Promise<HotFolder[]>;
  get(id: string): Promise<HotFolder | undefined>;
  findByPath(path: string): Promise<HotFolder | undefined>;
  /** Throws {@link DuplicateHotFolderError} when the path is already registered. */
  create(input: NewHotFolder): Promise<HotFolder>;
  /** Throws {@link HotFolderNotFoundError}. */
  update(id: string, patch: HotFolderUpdate): Promise<HotFolder>;
}

export class HotFolderNotFoundError extends BpsError {
  readonly hotFolderId: string;

  constructor(hotFolderId: string) {
    super('HOT_FOLDER_NOT_FOUND', `hot folder not found: ${hotFolderId}`);
    this.hotFolderId = hotFolderId;
  }
}

export class DuplicateHotFolderError extends BpsError {
  readonly path: string;

  constructor(path: string) {
    super('HOT_FOLDER_EXISTS', `a hot folder is already registered for ${path}`);
    this.path = path;
  }
}
