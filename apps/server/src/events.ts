/**
 * Spec 005 event types. They go through the shared `@bax-print/events` bus (and its outbox), so
 * media events land in the same CloudEvents stream as job events (ARCHITECTURE §5).
 */
export const MediaEventTypes = Object.freeze({
  mediaSynced: 'media.synced',
  profilingStepCompleted: 'profiling.step.completed',
  colorSetupPublished: 'colorsetup.published',
} as const);

export const MEDIA_SOURCE = '/bps/media';
export const COLOR_SETUP_SOURCE = '/bps/color-setups';
export const PROFILING_SOURCE = '/bps/profiling-sessions';

// Type aliases rather than interfaces, so the payloads stay assignable to plain JSON records.

export type MediaSyncedData = {
  readonly source: string;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
};

export type ColorSetupPublishedData = {
  readonly colorSetupId: string;
  readonly revisionId: string;
  readonly number: number;
  readonly supersedes?: string;
};

export type ProfilingStepCompletedData = {
  readonly sessionId: string;
  readonly stepId: string;
  readonly index: number;
  readonly sessionCompleted: boolean;
};
