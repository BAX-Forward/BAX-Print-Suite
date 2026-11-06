import type { FastifyInstance } from 'fastify';
import {
  groupAccountingByAccountingId,
  parseTicketAccountingId,
  systemClock,
  validateAccountingReport,
  type AccountingIdGroup,
  type Clock,
  type DeviceAccountingReport,
  type Job,
  type JobTicket,
} from '@bax-print/core';
import { accountingIdInvalid, notFound } from './errors.js';
import { doc } from './openapi.js';
import { parseProductionReportQuery } from './production-report-routes.js';

/** The jobs whose ticket carries the accounting ID; the store package's job repositories satisfy it. */
export interface AccountingJobStore {
  get(jobId: string): Promise<Job | null | undefined>;
  save(job: Job): Promise<unknown>;
  list(): Promise<readonly Job[]>;
}

/**
 * The device accounting reports the report is built from. The server keeps no accounting report
 * store of its own (reports are only published as history events), so the caller provides them.
 */
export interface AccountingReportSource {
  list(): Promise<readonly DeviceAccountingReport[]>;
}

export interface AccountingRouteOptions {
  readonly jobs: AccountingJobStore;
  /** Mounts `GET /reports/accounting`; without it only `PUT /jobs/:id/accounting-id` is mounted. */
  readonly reports?: AccountingReportSource;
  readonly clock?: Clock;
}

/** `GET /reports/accounting`: the window and the core groups of the reports inside it. */
export interface AccountingReport {
  readonly from: string;
  readonly to: string;
  readonly groups: readonly AccountingIdGroup[];
}

const ACCOUNTING_ID_FIELD = 'accountingId';

const PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

/** Documented only: the handler checks the body itself so that a bad value answers `accounting_id_invalid`. */
const BODY_DOC = {
  type: 'object',
  required: [ACCOUNTING_ID_FIELD],
  properties: {
    accountingId: {
      type: ['string', 'null'],
      description: 'Customer or cost-center code, 1-64 letters, digits, space and `- _ . /` after trimming; null clears it',
    },
  },
};

/** Documented only, like the production report window. */
const QUERY_DOC = {
  type: 'object',
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', format: 'date-time', description: 'Inclusive start of the window, ISO 8601 UTC ending in Z' },
    to: { type: 'string', format: 'date-time', description: 'Exclusive end of the window, ISO 8601 UTC ending in Z' },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads `{ accountingId: string | null }`: a trimmed accounting ID to set, or `null` to clear it. */
export function parseAccountingIdBody(body: unknown): string | null {
  if (!isRecord(body) || !(ACCOUNTING_ID_FIELD in body)) {
    throw accountingIdInvalid('send { "accountingId": string | null }', ACCOUNTING_ID_FIELD);
  }
  const value = body[ACCOUNTING_ID_FIELD];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw accountingIdInvalid('accountingId must be a string or null', ACCOUNTING_ID_FIELD);
  }
  const parsed = parseTicketAccountingId(value);
  if (!parsed.ok) throw accountingIdInvalid(parsed.error.errors.join('; '), parsed.error.field);
  return parsed.value ?? null;
}

/** The ticket with `accountingId` set, or without it for `null`. */
function withAccountingId(ticket: JobTicket, accountingId: string | null): JobTicket {
  const { accountingId: _previous, ...rest } = ticket;
  return accountingId === null ? rest : { ...rest, accountingId };
}

/** Reads `from` and `to` with the production report's own check, so both reports accept the same windows. */
function parseAccountingReportQuery(query: unknown): { from: string; to: string } {
  const values: Record<string, unknown> = isRecord(query) ? query : {};
  const { from, to } = parseProductionReportQuery({ from: values.from, to: values.to });
  return { from, to };
}

function reportedWithin(report: DeviceAccountingReport, from: string, to: string): boolean {
  const at = Date.parse(report.reportedAt);
  return at >= Date.parse(from) && at < Date.parse(to);
}

/** Spec 017d: set or clear a job's accounting ID, and the Spec 017c accounting ID report. */
export function registerAccountingRoutes(app: FastifyInstance, deps: AccountingRouteOptions): void {
  const { jobs, reports } = deps;
  const clock = deps.clock ?? systemClock;

  app.put<{ Params: { id: string } }>(
    '/jobs/:id/accounting-id',
    {
      schema: doc({
        operationId: 'setJobAccountingId',
        summary: "Set the job ticket's accounting ID, or clear it with null",
        tags: ['jobs'],
        params: PARAMS,
        bodyDoc: BODY_DOC,
        responses: {
          200: '`{ job }`: the job with its updated ticket',
          404: 'No job has this id (`not_found`)',
          422: 'The accounting ID is missing, not a string or null, or invalid (`accounting_id_invalid`, `details.field` names it)',
        },
      }),
    },
    async (request) => {
      const accountingId = parseAccountingIdBody(request.body);
      const job = await jobs.get(request.params.id);
      if (!job) throw notFound('job', request.params.id);
      const updated: Job = { ...job, ticket: withAccountingId(job.ticket, accountingId), updatedAt: clock().toISOString() };
      await jobs.save(updated);
      return { job: updated };
    },
  );

  if (!reports) return;

  app.get(
    '/reports/accounting',
    {
      schema: doc({
        operationId: 'getAccountingReport',
        summary:
          'Device accounting quantities reported in the window [from, to), summed per job accounting ID (null last). ' +
          'The server stores no accounting reports itself; they come from the report source the server is configured with',
        tags: ['reports'],
        queryDoc: QUERY_DOC,
        responses: {
          200: 'The report; quantities are summed only when kind, name and unit match, and units are never converted',
          400: 'A provided accounting report or a stored job accounting ID cannot be reported',
          422: 'The window is invalid (`report_range_invalid`)',
        },
        responseSchema: 'AccountingReport',
      }),
    },
    async (request): Promise<AccountingReport> => {
      const { from, to } = parseAccountingReportQuery(request.query);
      const inWindow = (await reports.list()).map(validateAccountingReport).filter((report) => reportedWithin(report, from, to));
      return { from, to, groups: groupAccountingByAccountingId(inWindow, await jobs.list()) };
    },
  );
}
