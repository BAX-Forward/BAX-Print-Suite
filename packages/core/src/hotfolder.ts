/** Hot folder (Spec 001), with the Spec 007 `preflightProfileId` binding. */
export interface HotFolderSettings {
  moveProcessedTo?: string;
  defaultPriority: number;
  filePatterns: string[];
  dedupe: boolean;
  /** Preflight profile for jobs from this folder. A per-job ticket profile overrides it. */
  preflightProfileId?: string;
}

export interface HotFolder {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  settings: HotFolderSettings;
}
