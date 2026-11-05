import { isTerminal, type Job, type JobProductionRecord } from '@bax-print/core';

/** The job fields a production record is read from; a stored `Job` satisfies it. */
export type ProductionJob = Pick<Job, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'doneAt' | 'customerRef' | 'deviceId'>;

/**
 * When the job reached its final status. A done job records `doneAt`; failed and cancelled jobs
 * record no time of their own, so their last update stands in for it.
 */
function finishedAt(job: ProductionJob): string | undefined {
  if (!isTerminal(job.status)) return undefined;
  return job.status === 'done' ? (job.doneAt ?? job.updatedAt) : job.updatedAt;
}

/** Spec 023b: the Spec 023a production record of a job. A job is received when it is created. */
export function toProductionRecord(job: ProductionJob): JobProductionRecord {
  const finished = finishedAt(job);
  return {
    jobId: job.id,
    status: job.status,
    receivedAt: job.createdAt,
    ...(finished === undefined ? {} : { finishedAt: finished }),
    ...(job.customerRef === undefined ? {} : { customer: job.customerRef }),
    ...(job.deviceId === undefined ? {} : { deviceId: job.deviceId }),
  };
}

export function toProductionRecords(jobs: readonly ProductionJob[]): JobProductionRecord[] {
  return jobs.map(toProductionRecord);
}
