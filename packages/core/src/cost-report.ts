import type { AccountingCost, CostEstimate } from './costing.js';
import { MINOR_UNITS_PER_MAJOR } from './costing.js';
import { InvalidArgumentError } from './errors.js';

export type CostReportGroupBy = 'customer' | 'device' | 'day' | 'none';

/** Group key for records with no customer or device. */
export const UNASSIGNED_GROUP_KEY = 'unassigned';
/** Group key used when the report is not grouped. */
export const ALL_GROUP_KEY = 'all';
/** Label of the totals row in CSV output. */
export const TOTAL_ROW_LABEL = 'total';

const GROUP_BY: readonly CostReportGroupBy[] = ['customer', 'device', 'day', 'none'];
/** ISO 8601 date-time in UTC: seconds and fractions optional, `Z` designator required. */
const UTC_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/;
const ISO_DATE_LENGTH = 10;
const CSV_DECIMALS = 2;
const CSV_LINE_BREAK = '\r\n';
const CSV_HEADER = ['group', 'jobs', 'currency', 'estimated', 'actual', 'variance', 'unpriced_jobs'] as const;
const CSV_QUOTE_NEEDED = /[",\r\n]/;

export interface JobCostRecord {
  readonly jobId: string;
  /** ISO 8601 date-time in UTC, for example `2026-03-01T14:30:00Z`. */
  readonly completedAt: string;
  readonly customer?: string;
  readonly deviceId?: string;
  readonly estimate?: CostEstimate;
  readonly actual?: AccountingCost;
}

export interface CostReportOptions {
  /** Inclusive start of the window, ISO 8601 UTC. */
  readonly from: string;
  /** Exclusive end of the window, ISO 8601 UTC. */
  readonly to: string;
  readonly groupBy: CostReportGroupBy;
}

export interface CostReportTotals {
  readonly jobs: number;
  /** Integer minor units; sum of estimate totals over jobs with an estimate. */
  readonly estimatedMinor: number;
  /** Integer minor units; sum of actual totals over jobs with an actual cost. */
  readonly actualMinor: number;
  /** Integer minor units; actual minus estimate, only over jobs that have both. */
  readonly varianceMinor: number;
  /** Jobs with no cost at all, or whose actual cost lists unpriced quantities. */
  readonly unpricedJobs: number;
}

export interface CostReportGroup extends CostReportTotals {
  readonly key: string;
}

export interface CostReport {
  /** ISO 4217 code shared by every amount; null when no job in the window has a cost. */
  readonly currency: string | null;
  readonly from: string;
  readonly to: string;
  /** Sorted by key in code-unit order; day keys therefore sort chronologically. */
  readonly groups: readonly CostReportGroup[];
  readonly totals: CostReportTotals;
}

const EMPTY_TOTALS: CostReportTotals = { jobs: 0, estimatedMinor: 0, actualMinor: 0, varianceMinor: 0, unpricedJobs: 0 };

/** Parses an ISO 8601 UTC date-time to epoch milliseconds, rejecting impossible calendar dates. */
function parseUtc(value: unknown, field: string): number {
  if (typeof value !== 'string' || !UTC_DATE_TIME_PATTERN.test(value)) {
    throw new InvalidArgumentError(`cost report: ${field} must be an ISO 8601 UTC date-time ending in Z`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, ISO_DATE_LENGTH) !== value.slice(0, ISO_DATE_LENGTH)) {
    throw new InvalidArgumentError(`cost report: ${field} is not a valid date-time`);
  }
  return ms;
}

function minorAmount(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidArgumentError(`cost report: ${field} must be an integer number of minor units`);
  }
  return value;
}

function safeAdd(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw new InvalidArgumentError('cost report: amount is too large to represent exactly');
  }
  return sum;
}

function labelOrUnassigned(value: string | undefined): string {
  return value === undefined || value.trim() === '' ? UNASSIGNED_GROUP_KEY : value;
}

function groupKey(record: JobCostRecord, completedMs: number, groupBy: CostReportGroupBy): string {
  switch (groupBy) {
    case 'customer':
      return labelOrUnassigned(record.customer);
    case 'device':
      return labelOrUnassigned(record.deviceId);
    case 'day':
      return new Date(completedMs).toISOString().slice(0, ISO_DATE_LENGTH);
    case 'none':
      return ALL_GROUP_KEY;
  }
}

function isUnpriced(record: JobCostRecord): boolean {
  if (record.actual !== undefined) return record.actual.unpriced.length > 0;
  return record.estimate === undefined;
}

function addJob(totals: CostReportTotals, record: JobCostRecord): CostReportTotals {
  const estimate = record.estimate === undefined ? undefined : minorAmount(record.estimate.total, `estimate.total of "${record.jobId}"`);
  const actual = record.actual === undefined ? undefined : minorAmount(record.actual.total, `actual.total of "${record.jobId}"`);
  const variance = estimate !== undefined && actual !== undefined ? actual - estimate : 0;
  return {
    jobs: totals.jobs + 1,
    estimatedMinor: safeAdd(totals.estimatedMinor, estimate ?? 0),
    actualMinor: safeAdd(totals.actualMinor, actual ?? 0),
    varianceMinor: safeAdd(totals.varianceMinor, variance),
    unpricedJobs: totals.unpricedJobs + (isUnpriced(record) ? 1 : 0),
  };
}

/** The single currency of every amount in the records, or null when none carries an amount. */
function reportCurrency(records: readonly JobCostRecord[]): string | null {
  let currency: string | null = null;
  for (const record of records) {
    for (const cost of [record.estimate, record.actual]) {
      if (cost === undefined) continue;
      if (currency === null) {
        currency = cost.currency;
      } else if (cost.currency !== currency) {
        throw new InvalidArgumentError(
          `cost report: mixed currencies ${currency} and ${cost.currency} (job "${record.jobId}")`,
        );
      }
    }
  }
  return currency;
}

/** Aggregates per-job costs completed in [from, to) into groups and totals. */
export function buildCostReport(records: readonly JobCostRecord[], options: CostReportOptions): CostReport {
  const fromMs = parseUtc(options.from, 'from');
  const toMs = parseUtc(options.to, 'to');
  if (fromMs >= toMs) {
    throw new InvalidArgumentError('cost report: from must be earlier than to');
  }
  if (!GROUP_BY.includes(options.groupBy)) {
    throw new InvalidArgumentError(`cost report: groupBy must be one of ${GROUP_BY.join(', ')}`);
  }

  const seen = new Set<string>();
  const inWindow: { readonly record: JobCostRecord; readonly completedMs: number }[] = [];
  for (const [index, record] of records.entries()) {
    if (typeof record.jobId !== 'string' || record.jobId.trim() === '') {
      throw new InvalidArgumentError(`cost report: records[${index}].jobId must be a non-empty string`);
    }
    if (seen.has(record.jobId)) {
      throw new InvalidArgumentError(`cost report: duplicate job "${record.jobId}"`);
    }
    seen.add(record.jobId);
    const completedMs = parseUtc(record.completedAt, `records[${index}].completedAt`);
    if (completedMs >= fromMs && completedMs < toMs) inWindow.push({ record, completedMs });
  }

  const currency = reportCurrency(inWindow.map((entry) => entry.record));
  const byKey = new Map<string, CostReportTotals>();
  let totals = EMPTY_TOTALS;
  for (const { record, completedMs } of inWindow) {
    const key = groupKey(record, completedMs, options.groupBy);
    byKey.set(key, addJob(byKey.get(key) ?? EMPTY_TOTALS, record));
    totals = addJob(totals, record);
  }

  const groups = [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, group]): CostReportGroup => ({ key, ...group }));
  return { currency, from: options.from, to: options.to, groups, totals };
}

/** Formats integer minor units as major units with exactly two decimals, without floating-point division. */
function formatMajor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / MINOR_UNITS_PER_MAJOR);
  const fraction = abs % MINOR_UNITS_PER_MAJOR;
  return `${sign}${major}.${String(fraction).padStart(CSV_DECIMALS, '0')}`;
}

/** Quotes a field per RFC 4180 when it contains a comma, double quote or line break. */
function csvField(value: string): string {
  return CSV_QUOTE_NEEDED.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Leading characters a spreadsheet may treat as the start of a formula. */
const CSV_FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Neutralises spreadsheet formula injection in a free-text field by prefixing a single quote
 * when it starts with =, +, -, @, tab or CR. Applied to text fields only; amounts are
 * generated by formatMajor and a leading minus there is a real negative number.
 */
export function csvSafeText(value: string): string {
  return CSV_FORMULA_START.test(value) ? `'${value}` : value;
}

function csvRow(label: string, currency: string, totals: CostReportTotals): string {
  return [
    csvSafeText(label),
    String(totals.jobs),
    csvSafeText(currency),
    formatMajor(totals.estimatedMinor),
    formatMajor(totals.actualMinor),
    formatMajor(totals.varianceMinor),
    String(totals.unpricedJobs),
  ]
    .map(csvField)
    .join(',');
}

/** Renders a cost report as RFC 4180 CSV: header, one row per group, then a totals row; CRLF line breaks. */
export function costReportToCsv(report: CostReport): string {
  const currency = report.currency ?? '';
  const rows = [
    CSV_HEADER.join(','),
    ...report.groups.map((group) => csvRow(group.key, currency, group)),
    csvRow(TOTAL_ROW_LABEL, currency, report.totals),
  ];
  return rows.join(CSV_LINE_BREAK) + CSV_LINE_BREAK;
}
