import { InvalidArgumentError } from './errors.js';

/** Internal helpers shared by the cost and production reports; not exported from the package index. */

export type ReportGroupBy = 'customer' | 'device' | 'day' | 'none';

/** Group key for records with no customer or device. */
export const UNASSIGNED_GROUP_KEY = 'unassigned';
/** Group key used when the report is not grouped. */
export const ALL_GROUP_KEY = 'all';
/** Label of the totals row in CSV output. */
export const TOTAL_ROW_LABEL = 'total';

export const REPORT_GROUP_BY: readonly ReportGroupBy[] = ['customer', 'device', 'day', 'none'];
/** ISO 8601 date-time in UTC: seconds and fractions optional, `Z` designator required. */
const UTC_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/;
const ISO_DATE_LENGTH = 10;
export const CSV_LINE_BREAK = '\r\n';
const CSV_QUOTE_NEEDED = /[",\r\n]/;

export interface ReportWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/** Parses an ISO 8601 UTC date-time to epoch milliseconds, rejecting impossible calendar dates. */
export function parseUtc(value: unknown, field: string, context: string): number {
  if (typeof value !== 'string' || !UTC_DATE_TIME_PATTERN.test(value)) {
    throw new InvalidArgumentError(`${context}: ${field} must be an ISO 8601 UTC date-time ending in Z`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, ISO_DATE_LENGTH) !== value.slice(0, ISO_DATE_LENGTH)) {
    throw new InvalidArgumentError(`${context}: ${field} is not a valid date-time`);
  }
  return ms;
}

/** Validates the half-open window [from, to) and the grouping. */
export function parseReportWindow(
  options: { readonly from: string; readonly to: string; readonly groupBy: ReportGroupBy },
  context: string,
): ReportWindow {
  const fromMs = parseUtc(options.from, 'from', context);
  const toMs = parseUtc(options.to, 'to', context);
  if (fromMs >= toMs) {
    throw new InvalidArgumentError(`${context}: from must be earlier than to`);
  }
  if (!REPORT_GROUP_BY.includes(options.groupBy)) {
    throw new InvalidArgumentError(`${context}: groupBy must be one of ${REPORT_GROUP_BY.join(', ')}`);
  }
  return { fromMs, toMs };
}

export function isInWindow(ms: number, window: ReportWindow): boolean {
  return ms >= window.fromMs && ms < window.toMs;
}

function labelOrUnassigned(value: string | undefined): string {
  return value === undefined || value.trim() === '' ? UNASSIGNED_GROUP_KEY : value;
}

/** Group key of a record; `day` is the UTC calendar day of `atMs`. */
export function groupKey(
  record: { readonly customer?: string; readonly deviceId?: string },
  atMs: number,
  groupBy: ReportGroupBy,
): string {
  switch (groupBy) {
    case 'customer':
      return labelOrUnassigned(record.customer);
    case 'device':
      return labelOrUnassigned(record.deviceId);
    case 'day':
      return new Date(atMs).toISOString().slice(0, ISO_DATE_LENGTH);
    case 'none':
      return ALL_GROUP_KEY;
  }
}

/** Code-unit order; day keys therefore sort chronologically. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Quotes a field per RFC 4180 when it contains a comma, double quote or line break. */
export function csvField(value: string): string {
  return CSV_QUOTE_NEEDED.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
