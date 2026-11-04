import type { Job, JobStatus, JobStep } from '@bax-print/core';
import type { EventInput } from './cloudevent.js';
import { EventTypes } from './event-types.js';

/** Payloads of the Spec 001 job machine and hot folder events (ARCHITECTURE.md §5). */

export interface JobCreatedData {
  readonly job: Job;
}

export interface JobStatusChangedData {
  readonly jobId: string;
  readonly from: JobStatus;
  readonly to: JobStatus;
}

export interface StepEventData {
  readonly jobId: string;
  readonly step: JobStep;
}

export interface HotFolderFileDetectedData {
  readonly hotFolderId: string;
  readonly path: string;
}

export interface HotFolderFileSkippedData {
  readonly hotFolderId: string;
  readonly path: string;
  readonly reason: 'duplicate';
  readonly duplicateOf?: string;
}

export function jobCreatedEvent(source: string, job: Job): EventInput<JobCreatedData> {
  return { type: EventTypes.jobCreated, source, subject: job.id, data: { job } };
}

export function jobStatusChangedEvent(
  source: string,
  jobId: string,
  from: JobStatus,
  to: JobStatus,
): EventInput<JobStatusChangedData> {
  return { type: EventTypes.jobStatusChanged, source, subject: jobId, data: { jobId, from, to } };
}

export function stepEvent(
  source: string,
  type: typeof EventTypes.stepStarted | typeof EventTypes.stepCompleted | typeof EventTypes.stepFailed,
  jobId: string,
  step: JobStep,
): EventInput<StepEventData> {
  return { type, source, subject: jobId, data: { jobId, step } };
}

export function hotFolderFileDetectedEvent(
  source: string,
  data: HotFolderFileDetectedData,
): EventInput<HotFolderFileDetectedData> {
  return { type: EventTypes.hotFolderFileDetected, source, subject: data.hotFolderId, data };
}

export function hotFolderFileSkippedEvent(
  source: string,
  data: HotFolderFileSkippedData,
): EventInput<HotFolderFileSkippedData> {
  return { type: EventTypes.hotFolderFileSkipped, source, subject: data.duplicateOf ?? data.hotFolderId, data };
}
