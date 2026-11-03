import { DAY_MS, InvalidArgumentError, type Job } from '@bax-print/core';

/**
 * Default time a finished job stays in the active list: long enough to cover typical
 * reprint and correction requests on a finished order, short enough to keep the list small.
 */
export const DEFAULT_ARCHIVE_AFTER_MS = 14 * DAY_MS;

/** `archiveAfterMs` counts from the job's `done` time. A rule without `hotFolderId` is global. */
export interface ArchiveRule {
  readonly hotFolderId?: string;
  readonly archiveAfterMs: number;
}

export function validateRules(rules: readonly ArchiveRule[]): readonly ArchiveRule[] {
  const scopes = new Set<string>();
  for (const rule of rules) {
    if (!Number.isFinite(rule.archiveAfterMs) || rule.archiveAfterMs <= 0) {
      throw new InvalidArgumentError('archiveAfterMs must be a positive number of milliseconds');
    }
    const scope = rule.hotFolderId ?? '*';
    if (scopes.has(scope)) {
      throw new InvalidArgumentError(`more than one archive rule for ${rule.hotFolderId ? `hot folder ${scope}` : 'the global scope'}`);
    }
    scopes.add(scope);
  }
  return rules;
}

/** A hot-folder rule wins over the global rule, which wins over the built-in default. */
export function archiveAfterFor(job: Job, rules: readonly ArchiveRule[]): number {
  const specific = job.hotFolderId === undefined ? undefined : rules.find((r) => r.hotFolderId === job.hotFolderId);
  const global = rules.find((r) => r.hotFolderId === undefined);
  return (specific ?? global)?.archiveAfterMs ?? DEFAULT_ARCHIVE_AFTER_MS;
}

export function isDueForArchive(job: Job, rules: readonly ArchiveRule[], now: Date): boolean {
  if (job.lifecycle !== 'active' || job.status !== 'done' || job.doneAt === undefined) return false;
  const doneMs = Date.parse(job.doneAt);
  if (Number.isNaN(doneMs)) return false;
  return now.getTime() - doneMs > archiveAfterFor(job, rules);
}

/** Jobs whose `done` time is strictly older than their rule. */
export function selectJobsToArchive(jobs: readonly Job[], rules: readonly ArchiveRule[], now: Date): Job[] {
  return jobs.filter((job) => isDueForArchive(job, rules, now));
}
