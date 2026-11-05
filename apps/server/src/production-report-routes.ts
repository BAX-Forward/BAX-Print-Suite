import type { FastifyInstance } from 'fastify';
import {
  InvalidArgumentError,
  productionReport,
  productionReportToCsv,
  type ProductionReportGroupBy,
  type ProductionReportOptions,
} from '@bax-print/core';
import { reportFormatInvalid, reportGroupByInvalid, reportRangeInvalid } from './errors.js';
import { doc } from './openapi.js';
import { toProductionRecords, type ProductionJob } from './production-records.js';

/** The jobs a report is built from; the store package's job repositories satisfy it. */
export interface ProductionJobSource {
  list(): Promise<readonly ProductionJob[]>;
}

export interface ProductionReportRouteOptions {
  readonly jobs: ProductionJobSource;
}

export type ProductionReportFormat = 'json' | 'csv';

export interface ProductionReportQuery extends ProductionReportOptions {
  readonly format: ProductionReportFormat;
}

export const PRODUCTION_REPORT_GROUP_BY: readonly ProductionReportGroupBy[] = ['day', 'device', 'customer', 'none'];
export const PRODUCTION_REPORT_FORMATS: readonly ProductionReportFormat[] = ['json', 'csv'];

const DEFAULT_GROUP_BY: ProductionReportGroupBy = 'none';
const DEFAULT_FORMAT: ProductionReportFormat = 'json';
const UNSAFE_FILENAME_CHARS = /[^0-9A-Za-z.-]/g;

/**
 * Documented only: the handler checks the query itself so that a bad value answers the route's
 * own 422 codes rather than Fastify's 400.
 */
const QUERY_DOC = {
  type: 'object',
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', format: 'date-time', description: 'Inclusive start of the window, ISO 8601 UTC ending in Z' },
    to: { type: 'string', format: 'date-time', description: 'Exclusive end of the window, ISO 8601 UTC ending in Z' },
    groupBy: { enum: [...PRODUCTION_REPORT_GROUP_BY], default: DEFAULT_GROUP_BY },
    format: { enum: [...PRODUCTION_REPORT_FORMATS], default: DEFAULT_FORMAT },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Checks the window with the core report itself, so the route accepts exactly what core accepts. */
function parseRange(from: unknown, to: unknown): { from: string; to: string } {
  if (typeof from !== 'string' || typeof to !== 'string') {
    throw reportRangeInvalid('from and to are required, each one ISO 8601 UTC date-time ending in Z');
  }
  try {
    productionReport([], { from, to, groupBy: DEFAULT_GROUP_BY });
  } catch (error) {
    if (error instanceof InvalidArgumentError) throw reportRangeInvalid(error.message);
    throw error;
  }
  return { from, to };
}

/** Reads `from`, `to`, `groupBy` (default `none`) and `format` (default `json`). */
export function parseProductionReportQuery(query: unknown): ProductionReportQuery {
  const values: Record<string, unknown> = isRecord(query) ? query : {};
  const range = parseRange(values.from, values.to);
  const groupBy = values.groupBy ?? DEFAULT_GROUP_BY;
  if (!isOneOf(PRODUCTION_REPORT_GROUP_BY, groupBy)) {
    throw reportGroupByInvalid(`groupBy must be one of ${PRODUCTION_REPORT_GROUP_BY.join(', ')}`);
  }
  const format = values.format ?? DEFAULT_FORMAT;
  if (!isOneOf(PRODUCTION_REPORT_FORMATS, format)) {
    throw reportFormatInvalid(`format must be one of ${PRODUCTION_REPORT_FORMATS.join(', ')}`);
  }
  return { ...range, groupBy, format };
}

/** `production-report_<from>_<to>.csv` with the colons of the date-times replaced. */
export function productionReportFilename(query: ProductionReportOptions): string {
  const safe = (value: string): string => value.replace(UNSAFE_FILENAME_CHARS, '-');
  return `production-report_${safe(query.from)}_${safe(query.to)}.csv`;
}

/** Spec 023b: the Spec 023a production report over the jobs in the job repository. */
export function registerProductionReportRoutes(app: FastifyInstance, deps: ProductionReportRouteOptions): void {
  const { jobs } = deps;

  app.get(
    '/reports/production',
    {
      schema: doc({
        operationId: 'getProductionReport',
        summary: 'Jobs received, completed, failed or cancelled and turnaround over the window [from, to), as JSON or CSV',
        tags: ['reports'],
        queryDoc: QUERY_DOC,
        responses: {
          200: 'The report: JSON with `format=json`, RFC 4180 CSV with `format=csv`',
          400: 'A stored job cannot be reported (its finish is earlier than its creation, or two jobs share an id)',
          422: 'The window is invalid (`report_range_invalid`), or `groupBy` (`report_group_by_invalid`) or `format` (`report_format_invalid`) is unknown',
        },
        responseSchema: 'ProductionReport',
        alsoProduces: ['text/csv'],
      }),
    },
    async (request, reply) => {
      const { format, ...options } = parseProductionReportQuery(request.query);
      const report = productionReport(toProductionRecords(await jobs.list()), options);
      if (format === 'json') return reply.send(report);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${productionReportFilename(options)}"`)
        .send(productionReportToCsv(report));
    },
  );
}
