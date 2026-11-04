import type { ProfilingState, RevisionAuthorKind } from '@bax-print/core';

export const MEDIA_EVENT_TYPES = ['media.synced', 'profiling.step.completed', 'colorsetup.published'] as const;
export type MediaEventType = (typeof MEDIA_EVENT_TYPES)[number];

export interface MediaSyncedEvent {
  type: 'media.synced';
  subject: string;
  data: {
    deviceProfile: string;
    mediaCreated: number;
    mediaUpdated: number;
    modesCreated: number;
    modesUpdated: number;
    setupsUpdated: number;
    conflicts: number;
  };
}

export interface ProfilingStepCompletedEvent {
  type: 'profiling.step.completed';
  subject: string;
  data: { sessionId: string; state: ProfilingState; mediumId: string; outputModeId: string };
}

/** Emitted whenever a color setup head moves to a new revision. */
export interface ColorSetupPublishedEvent {
  type: 'colorsetup.published';
  subject: string;
  data: {
    colorSetupId: string;
    revisionId: string;
    seq: number;
    authorKind: RevisionAuthorKind;
    profilingSessionId?: string;
  };
}

export type MediaEvent = MediaSyncedEvent | ProfilingStepCompletedEvent | ColorSetupPublishedEvent;
export type MediaEventSink = (event: MediaEvent) => void;
