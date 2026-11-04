import type {
  ColorSetup,
  ColorSetupRevisionRecord,
  JobColorBinding,
  Medium,
  OutputMode,
  Preset,
  ProfileRecord,
  ProfilingArtifactMeta,
  ProfilingSession,
} from '@bax-print/core';

export interface StoredArtifact {
  meta: ProfilingArtifactMeta;
  bytes: Uint8Array;
}

/**
 * Persistence for the media library and profiling workflow.
 * Color setup revisions, profiling artifacts and job bindings are append-only.
 */
export interface MediaRepository {
  /** Runs `fn` atomically. `fn` must be synchronous; nested calls use savepoints. */
  transaction<T>(fn: () => T): T;

  insertMedium(medium: Medium): void;
  updateMedium(medium: Medium): void;
  getMedium(id: string): Medium | undefined;
  listMedia(options?: { includeArchived?: boolean }): Medium[];
  findMediumByDeviceRef(deviceProfile: string, mediumKey: string): Medium | undefined;
  /** Deletes the medium, its modes, color setups and presets. Revisions are kept. */
  deleteMedium(id: string): void;

  insertOutputMode(mode: OutputMode): void;
  updateOutputMode(mode: OutputMode): void;
  getOutputMode(id: string): OutputMode | undefined;
  listOutputModes(mediumId: string): OutputMode[];
  findOutputMode(mediumId: string, deviceProfile: string, modeKey: string): OutputMode | undefined;

  insertColorSetup(setup: ColorSetup): void;
  updateColorSetup(setup: ColorSetup): void;
  getColorSetup(id: string): ColorSetup | undefined;
  getColorSetupByOutputMode(outputModeId: string): ColorSetup | undefined;
  listColorSetups(mediumId: string): ColorSetup[];

  appendRevision(revision: ColorSetupRevisionRecord): void;
  getRevision(id: string): ColorSetupRevisionRecord | undefined;
  listRevisions(colorSetupId: string): ColorSetupRevisionRecord[];

  insertPreset(preset: Preset): void;
  updatePreset(preset: Preset): void;
  getPreset(id: string): Preset | undefined;
  listPresets(): Preset[];
  deletePreset(id: string): void;

  /** Idempotent: profiles are keyed by SHA-256. */
  putProfile(record: ProfileRecord, bytes: Uint8Array): void;
  getProfile(sha256: string): ProfileRecord | undefined;
  getProfileBytes(sha256: string): Uint8Array | undefined;

  insertSession(session: ProfilingSession): void;
  updateSession(session: ProfilingSession): void;
  getSession(id: string): ProfilingSession | undefined;
  listSessions(): ProfilingSession[];

  appendArtifact(meta: ProfilingArtifactMeta, bytes: Uint8Array): void;
  getArtifact(id: string): StoredArtifact | undefined;
  listArtifacts(sessionId: string): ProfilingArtifactMeta[];

  insertJobBinding(binding: JobColorBinding): void;
  getJobBinding(jobId: string): JobColorBinding | undefined;
  countJobBindingsForMedium(mediumId: string): number;

  close(): void;
}
