import type { AuditEntry, JobRecord as Job, JobStep } from '../api/types';

/** One row of the job-detail timeline: a pipeline step or an audit entry (recorded from events). */
export type TimelineItem =
  | { kind: 'step'; key: string; time: string; step: JobStep }
  | { kind: 'audit'; key: string; time: string; entry: AuditEntry };

/** Steps and audit entries merged oldest first. Items without a time keep their relative order at the end. */
export function buildTimeline(job: Pick<Job, 'steps' | 'audit'>): TimelineItem[] {
  const items: TimelineItem[] = [
    ...job.steps.map((step): TimelineItem => ({
      kind: 'step',
      key: `step-${step.id}`,
      time: step.startedAt ?? step.finishedAt ?? '',
      step,
    })),
    ...(job.audit ?? []).map((entry): TimelineItem => ({ kind: 'audit', key: `audit-${entry.id}`, time: entry.time, entry })),
  ];
  return items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => {
      if (!a.item.time || !b.item.time) return (a.item.time ? -1 : b.item.time ? 1 : 0) || a.order - b.order;
      return Date.parse(a.item.time) - Date.parse(b.item.time) || a.order - b.order;
    })
    .map(({ item }) => item);
}

/** Path the latest successful output step delivered the PDF to (handoff driver result). */
export function deliveredPath(job: Pick<Job, 'steps'>): string | null {
  for (let i = job.steps.length - 1; i >= 0; i -= 1) {
    const step = job.steps[i];
    const path = step.result?.deliveredPath;
    if (step.stage === 'output' && step.status === 'completed' && typeof path === 'string') return path;
  }
  return null;
}
