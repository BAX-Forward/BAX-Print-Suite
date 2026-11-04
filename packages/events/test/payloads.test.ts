import { describe, expect, it } from 'vitest';
import type { Job, JobStep } from '@bax-print/core';
import {
  createEvent,
  EventTypes,
  hotFolderFileDetectedEvent,
  hotFolderFileSkippedEvent,
  jobCreatedEvent,
  jobStatusChangedEvent,
  stepEvent,
} from '../src/index.js';

const SOURCE = '/bps/hotfolder';
const AT = new Date('2026-03-01T09:00:00.000Z');

describe('Spec 001 event payloads', () => {
  it('builds job events with the job id as subject', () => {
    const job = { id: 'job-1' } as Job;
    expect(jobCreatedEvent(SOURCE, job)).toEqual({
      type: 'job.created',
      source: SOURCE,
      subject: 'job-1',
      data: { job },
    });
    const changed = createEvent(jobStatusChangedEvent(SOURCE, 'job-1', 'received', 'inspecting'), 'evt-1', AT);
    expect(changed).toMatchObject({
      specversion: '1.0',
      type: EventTypes.jobStatusChanged,
      subject: 'job-1',
      data: { jobId: 'job-1', from: 'received', to: 'inspecting' },
    });
    const step = { id: 's1', stage: 'preflight', status: 'running', inputs: [], outputs: [] } satisfies JobStep;
    expect(stepEvent(SOURCE, EventTypes.stepStarted, 'job-1', step)).toMatchObject({
      type: 'step.started',
      data: { jobId: 'job-1', step },
    });
  });

  it('builds hot folder events', () => {
    expect(hotFolderFileDetectedEvent(SOURCE, { hotFolderId: 'hf-1', path: '/in/a.pdf' })).toMatchObject({
      type: 'hotfolder.file.detected',
      subject: 'hf-1',
    });
    expect(
      hotFolderFileSkippedEvent(SOURCE, { hotFolderId: 'hf-1', path: '/in/a.pdf', reason: 'duplicate', duplicateOf: 'job-1' }),
    ).toMatchObject({ type: 'hotfolder.file.skipped', subject: 'job-1', data: { reason: 'duplicate' } });
  });
});
