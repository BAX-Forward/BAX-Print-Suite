import type { AccountingKind, AccountingQuantity, DeviceAccountingReport } from './accounting.js';
import { InvalidArgumentError } from './errors.js';
import type { Job } from './job.js';

export const ACCOUNTING_ID_MAX_LENGTH = 64;

/** ASCII letters, digits, space and `- _ . /`, 1 to 64 characters. */
const ACCOUNTING_ID_PATTERN = /^[A-Za-z0-9 _./-]{1,64}$/;

/**
 * Parses a print accounting ID: a customer or cost-center code used to group device accounting reports.
 * The value is trimmed; the result is 1-64 characters of letters, digits, space and `- _ . /`.
 */
export function parseAccountingId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError('accountingId must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > ACCOUNTING_ID_MAX_LENGTH) {
    throw new InvalidArgumentError(`accountingId must be 1-${ACCOUNTING_ID_MAX_LENGTH} characters after trimming`);
  }
  if (!ACCOUNTING_ID_PATTERN.test(trimmed)) {
    throw new InvalidArgumentError('accountingId may contain only letters, digits, space and - _ . /');
  }
  return trimmed;
}

/** Device quantities summed for one accounting ID; `null` collects jobs without an ID. */
export interface AccountingIdGroup {
  readonly accountingId: string | null;
  /** Jobs with at least one report in this group, in first-seen order. */
  readonly jobIds: readonly string[];
  /** One entry per kind, name and unit, in first-seen order. Units are never converted. */
  readonly quantities: readonly AccountingQuantity[];
}

export type AccountingJob = Pick<Job, 'id'> & { readonly ticket: { readonly accountingId?: string } };

interface GroupBuilder {
  readonly jobIds: Set<string>;
  readonly totals: Map<string, AccountingQuantity>;
}

function accountingIdsByJob(jobs: readonly AccountingJob[]): ReadonlyMap<string, string | null> {
  const byJob = new Map<string, string | null>();
  for (const job of jobs) {
    const raw = job.ticket.accountingId;
    const accountingId = raw === undefined ? null : parseAccountingId(raw);
    const known = byJob.get(job.id);
    if (known !== undefined && known !== accountingId) {
      throw new InvalidArgumentError(`job ${job.id} is listed with different accounting IDs`);
    }
    byJob.set(job.id, accountingId);
  }
  return byJob;
}

function quantityKey(kind: AccountingKind, name: string, unit: string): string {
  return JSON.stringify([kind, name, unit]);
}

function addQuantity(totals: Map<string, AccountingQuantity>, quantity: AccountingQuantity): void {
  const key = quantityKey(quantity.kind, quantity.name, quantity.unit);
  const current = totals.get(key);
  totals.set(key, current === undefined ? { ...quantity } : { ...current, value: current.value + quantity.value });
}

function compareGroupKeys(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * Sums device accounting report quantities per job accounting ID. Quantities are summed only when kind,
 * name and unit all match. Reports for jobs without an accounting ID, or for jobs not in `jobs`, are
 * grouped under `null`. Groups are ordered by accounting ID with `null` last.
 */
export function groupAccountingByAccountingId(
  reports: readonly DeviceAccountingReport[],
  jobs: readonly AccountingJob[],
): readonly AccountingIdGroup[] {
  const byJob = accountingIdsByJob(jobs);
  const groups = new Map<string | null, GroupBuilder>();
  for (const report of reports) {
    const accountingId = byJob.get(report.jobId) ?? null;
    let group = groups.get(accountingId);
    if (group === undefined) {
      group = { jobIds: new Set<string>(), totals: new Map<string, AccountingQuantity>() };
      groups.set(accountingId, group);
    }
    group.jobIds.add(report.jobId);
    for (const quantity of report.quantities) addQuantity(group.totals, quantity);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compareGroupKeys(a, b))
    .map(([accountingId, group]) => ({
      accountingId,
      jobIds: [...group.jobIds],
      quantities: [...group.totals.values()],
    }));
}
