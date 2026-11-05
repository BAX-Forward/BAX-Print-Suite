import { csvSafeText } from './cost-report.js';
import { InvalidArgumentError } from './errors.js';
import {
  compareKeys,
  CSV_LINE_BREAK,
  csvField,
  groupKey,
  isInWindow,
  parseReportWindow,
  parseUtc,
  TOTAL_ROW_LABEL,
  type ReportGroupBy,
  type ReportWindow,
} from './report-common.js';
import { isJobStatus, isTerminal, type JobStatus } from './status.js';

export type ProductionReportGroupBy = ReportGroupBy;

const CONTEXT = 'production report';
const MEDIAN_PERCENT = 50;
const P90_PERCENT = 90;
const PERCENT = 100;
const CSV_HEADER = [
  'group',
  'jobs_received',
  'jobs_completed',
  'jobs_failed_or_cancelled',
  'median_turnaround_ms',
  'p90_turnaround_ms',
] as const;

export interface JobProductionRecord {
  readonly jobId: string;
  /** Current print status of the job. */
  readonly status: JobStatus;
  /** When the job entered `received`; ISO 8601 date-time in UTC. */
  readonly receivedAt: string;
  /** When the job reached `done`, `failed` or `cancelled`; required for those statuses and absent otherwise. */
  readonly finishedAt?: string;
  readonly customer?: string;
  readonly deviceId?: string;
}

export interface ProductionReportOptions {
  /** Inclusive start of the window, ISO 8601 UTC. */
  readonly from: string;
  /** Exclusive end of the window, ISO 8601 UTC. */
  readonly to: string;
  readonly groupBy: ProductionReportGroupBy;
}

export interface ProductionReportTotals {
  /** Jobs whose receivedAt is in the window. */
  readonly jobsReceived: number;
  /** Jobs that reached `done` in the window. */
  readonly jobsCompleted: number;
  /** Jobs that reached `failed` or `cancelled` in the window. */
  readonly jobsFailedOrCancelled: number;
  /** Median of received-to-done milliseconds over completed jobs; null when there are none. */
  readonly medianTurnaroundMs: number | null;
  /** 90th percentile of received-to-done milliseconds over completed jobs; null when there are none. */
  readonly p90TurnaroundMs: number | null;
}

export interface ProductionReportGroup extends ProductionReportTotals {
  readonly key: string;
}

export interface ProductionReport {
  readonly from: string;
  readonly to: string;
  /** Sorted by key in code-unit order; day keys therefore sort chronologically. */
  readonly groups: readonly ProductionReportGroup[];
  readonly totals: ProductionReportTotals;
}

interface Tally {
  received: number;
  completed: number;
  failedOrCancelled: number;
  readonly turnarounds: number[];
}

interface ParsedRecord {
  readonly record: JobProductionRecord;
  readonly receivedMs: number;
  readonly finishedMs: number | undefined;
}

/**
 * Percentile by linear interpolation between closest ranks (rank = (n - 1) * p), rounded to whole
 * milliseconds. Integer percent keeps the rank exact. Returns null for an empty sample.
 */
function percentile(sorted: readonly number[], percent: number): number | null {
  if (sorted.length === 0) return null;
  const scaledRank = (sorted.length - 1) * percent;
  const lowerIndex = Math.floor(scaledRank / PERCENT);
  const lower = sorted[lowerIndex];
  const upper = sorted[Math.min(lowerIndex + 1, sorted.length - 1)];
  if (lower === undefined || upper === undefined) return null;
  return Math.round(lower + ((upper - lower) * (scaledRank % PERCENT)) / PERCENT);
}

function toTotals(tally: Tally): ProductionReportTotals {
  const sorted = [...tally.turnarounds].sort((a, b) => a - b);
  return {
    jobsReceived: tally.received,
    jobsCompleted: tally.completed,
    jobsFailedOrCancelled: tally.failedOrCancelled,
    medianTurnaroundMs: percentile(sorted, MEDIAN_PERCENT),
    p90TurnaroundMs: percentile(sorted, P90_PERCENT),
  };
}

function emptyTally(): Tally {
  return { received: 0, completed: 0, failedOrCancelled: 0, turnarounds: [] };
}

function parseRecord(record: JobProductionRecord, index: number): ParsedRecord {
  const at = `records[${index}]`;
  if (typeof record !== 'object' || record === null) {
    throw new InvalidArgumentError(`${CONTEXT}: ${at} must be an object`);
  }
  if (typeof record.jobId !== 'string' || record.jobId.trim() === '') {
    throw new InvalidArgumentError(`${CONTEXT}: ${at}.jobId must be a non-empty string`);
  }
  if (!isJobStatus(record.status)) {
    throw new InvalidArgumentError(`${CONTEXT}: ${at}.status is not a job status`);
  }
  const receivedMs = parseUtc(record.receivedAt, `${at}.receivedAt`, CONTEXT);
  if (!isTerminal(record.status)) {
    if (record.finishedAt !== undefined) {
      throw new InvalidArgumentError(`${CONTEXT}: ${at}.finishedAt is set but status ${record.status} is not final`);
    }
    return { record, receivedMs, finishedMs: undefined };
  }
  if (record.finishedAt === undefined) {
    throw new InvalidArgumentError(`${CONTEXT}: ${at}.finishedAt is required for status ${record.status}`);
  }
  const finishedMs = parseUtc(record.finishedAt, `${at}.finishedAt`, CONTEXT);
  if (finishedMs < receivedMs) {
    throw new InvalidArgumentError(`${CONTEXT}: ${at}.finishedAt is earlier than receivedAt`);
  }
  return { record, receivedMs, finishedMs };
}

function parseRecords(records: readonly JobProductionRecord[]): readonly ParsedRecord[] {
  const seen = new Set<string>();
  return records.map((record, index) => {
    const parsed = parseRecord(record, index);
    if (seen.has(record.jobId)) {
      throw new InvalidArgumentError(`${CONTEXT}: duplicate job "${record.jobId}"`);
    }
    seen.add(record.jobId);
    return parsed;
  });
}

/** Adds one parsed record's in-window events to the tallies for its group and the total. */
function tallyRecord(
  parsed: ParsedRecord,
  window: ReportWindow,
  groupBy: ProductionReportGroupBy,
  tallyFor: (key: string) => Tally,
  total: Tally,
): void {
  const { record, receivedMs, finishedMs } = parsed;
  if (isInWindow(receivedMs, window)) {
    for (const tally of [tallyFor(groupKey(record, receivedMs, groupBy)), total]) tally.received += 1;
  }
  if (finishedMs === undefined || !isInWindow(finishedMs, window)) return;
  for (const tally of [tallyFor(groupKey(record, finishedMs, groupBy)), total]) {
    if (record.status === 'done') {
      tally.completed += 1;
      tally.turnarounds.push(finishedMs - receivedMs);
    } else {
      tally.failedOrCancelled += 1;
    }
  }
}

/**
 * Production throughput over the half-open window [from, to). A job counts as received when its
 * receivedAt is in the window, and as completed, failed or cancelled when its finishedAt is.
 * Turnaround is received to done, over jobs completed in the window. With `day` grouping each event
 * lands on the UTC day it happened.
 */
export function productionReport(
  records: readonly JobProductionRecord[],
  options: ProductionReportOptions,
): ProductionReport {
  const window = parseReportWindow(options, CONTEXT);
  const parsed = parseRecords(records);

  const byKey = new Map<string, Tally>();
  const tallyFor = (key: string): Tally => {
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;
    const created = emptyTally();
    byKey.set(key, created);
    return created;
  };
  const total = emptyTally();
  for (const entry of parsed) tallyRecord(entry, window, options.groupBy, tallyFor, total);

  const groups = [...byKey.entries()]
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([key, tally]): ProductionReportGroup => ({ key, ...toTotals(tally) }));
  return { from: options.from, to: options.to, groups, totals: toTotals(total) };
}

function csvRow(label: string, totals: ProductionReportTotals): string {
  return [
    csvSafeText(label),
    String(totals.jobsReceived),
    String(totals.jobsCompleted),
    String(totals.jobsFailedOrCancelled),
    totals.medianTurnaroundMs === null ? '' : String(totals.medianTurnaroundMs),
    totals.p90TurnaroundMs === null ? '' : String(totals.p90TurnaroundMs),
  ]
    .map(csvField)
    .join(',');
}

/**
 * Renders a production report as RFC 4180 CSV: header, one row per group, then a totals row; CRLF
 * line breaks. Turnarounds without any completed job are empty fields.
 */
export function productionReportToCsv(report: ProductionReport): string {
  const rows = [
    CSV_HEADER.join(','),
    ...report.groups.map((group) => csvRow(group.key, group)),
    csvRow(TOTAL_ROW_LABEL, report.totals),
  ];
  return rows.join(CSV_LINE_BREAK) + CSV_LINE_BREAK;
}
