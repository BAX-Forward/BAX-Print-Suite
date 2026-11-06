import type { FastifyInstance } from 'fastify';
import type { Job } from '@bax-print/core';
import type { EventBus } from '@bax-print/events';
import type { CutJobLookup } from './cut-routes.js';
import { conflict, notFound, printOutputHttpError, unsupportedFormat } from './errors.js';
import type { JobService } from './jobs.js';
import { doc } from './openapi.js';
import { readSource } from './pdf-cut-extractor.js';
import { startPrintAutoRoute } from './print-auto-route.js';
import { PrintOutputError, PrintSubmissionLedger, type PrintOutput } from './print-output.js';

/** Spec 034b: automatic routing of ready jobs; `main.ts` sets it only with `BPS_PRINT_AUTO_ROUTE=1`. */
export interface PrintAutoRouteOptions {
  /** The bus whose `job.status.changed` events to `ready` are routed. */
  readonly bus: EventBus;
  /** Records a failed automatic submission in the job history, when given. */
  readonly history?: Pick<JobService, 'recordStep'>;
}

export interface PrintOutputRouteOptions {
  /** The one configured printer plugin; closed with the server. */
  readonly output: PrintOutput;
  /** Absolute path of a stored blob, the same resolver the proof route reads source files with. */
  readonly blobPath: (storageKey: string) => string;
  /** Spec 034b: sends every job that becomes ready to `output` once; stopped with the server. */
  readonly autoRoute?: PrintAutoRouteOptions;
}

export interface PrintOutputRouteDeps extends PrintOutputRouteOptions {
  readonly jobs: CutJobLookup;
}

const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } };

const OUTPUT_JOB_PARAMS = {
  type: 'object',
  required: ['id', 'outputJobId'],
  properties: { id: { type: 'string', minLength: 1 }, outputJobId: { type: 'string', minLength: 1, maxLength: 256 } },
};

const PRINTER_ERROR = "The printer plugin failed (`printer_error`, the plugin's uppercase code in `details.code`)";

/**
 * Document refusals answer 409 `document_input_unsupported` or 413 `document_too_large`, other
 * plugin failures 502 `printer_error`; anything else is the server's own error.
 */
async function viaPlugin<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof PrintOutputError) throw printOutputHttpError(error.code);
    throw error;
  }
}

const UNKNOWN_OUTPUT_JOB = 'Unknown job (`not_found`), or an output job not submitted for this job (`unknown_output_job`)';

/**
 * Spec 034a: sends a job's first source PDF to the configured printer plugin and reports or
 * cancels the output job it creates. Nothing is recorded on the job.
 *
 * Spec 034b: the job of every submission, manual or automatic, is kept in memory; an output job
 * is reported or cancelled only under that job, otherwise the answer is 404 `unknown_output_job`
 * and the plugin is not asked. With `autoRoute`, ready jobs are sent automatically.
 */
export function registerPrintOutputRoutes(app: FastifyInstance, deps: PrintOutputRouteDeps): void {
  const printOutput = deps.output;
  const ledger = new PrintSubmissionLedger();
  const autoRoute = deps.autoRoute
    ? startPrintAutoRoute({ ...deps.autoRoute, jobs: deps.jobs, output: printOutput, blobPath: deps.blobPath, ledger, log: app.log })
    : undefined;
  app.addHook('onClose', async () => {
    autoRoute?.stop();
    await autoRoute?.idle();
    await printOutput.close();
  });

  const requireJob = async (id: string): Promise<Job> => {
    const job = await deps.jobs.get(id);
    if (!job) throw notFound('Job', id);
    return job;
  };

  const requireOutputJob = async (id: string, outputJobId: string): Promise<void> => {
    await requireJob(id);
    if (!ledger.belongsTo(outputJobId, id)) throw printOutputHttpError('UNKNOWN_OUTPUT_JOB');
  };

  app.post<{ Params: { id: string } }>(
    '/jobs/:id/print',
    {
      schema: doc({
        operationId: 'printJob',
        summary: "Sends a job's first source PDF to the configured printer plugin",
        tags: ['print'],
        params: ID_PARAMS,
        responseSchema: 'PrintSubmission',
        responses: {
          202: 'The plugin accepted the document; poll the output job for its state',
          404: 'Unknown job',
          409:
            'The source is not a PDF (`unsupported_format`), the job has no source file (`conflict`) or the device takes no PDF documents (`document_input_unsupported`)',
          413: "The document is above the device's document size limit (`document_too_large`)",
          502: PRINTER_ERROR,
        },
      }),
    },
    async (request, reply) => {
      const { id } = request.params;
      const job = await requireJob(id);
      if (job.sourceFormat !== 'pdf') {
        throw unsupportedFormat(`Job ${id} has a ${job.sourceFormat ?? 'unrecognized'} source; only PDF is sent to the printer`);
      }
      const bytes = await readSource(job, deps.blobPath);
      if (!bytes) throw conflict(`Job ${id} has no source file to print`);
      const submission = await viaPlugin(() => printOutput.submit(job, bytes, 'pdf'));
      ledger.record(submission.outputJobId, id);
      return reply.status(202).send({ outputJobId: submission.outputJobId });
    },
  );

  app.get<{ Params: { id: string; outputJobId: string } }>(
    '/jobs/:id/print/:outputJobId',
    {
      schema: doc({
        operationId: 'getPrintOutputJob',
        summary: 'Reports the state of an output job as the printer plugin sees it',
        tags: ['print'],
        params: OUTPUT_JOB_PARAMS,
        responseSchema: 'PrintOutputStatus',
        responses: { 200: 'The output job state', 404: UNKNOWN_OUTPUT_JOB, 502: PRINTER_ERROR },
      }),
    },
    async (request) => {
      await requireOutputJob(request.params.id, request.params.outputJobId);
      return viaPlugin(() => printOutput.status(request.params.outputJobId));
    },
  );

  app.delete<{ Params: { id: string; outputJobId: string } }>(
    '/jobs/:id/print/:outputJobId',
    {
      schema: doc({
        operationId: 'cancelPrintOutputJob',
        summary: 'Cancels an output job at the printer plugin',
        tags: ['print'],
        params: OUTPUT_JOB_PARAMS,
        responseSchema: 'PrintOutputStatus',
        responses: { 200: 'The output job state after the cancel', 404: UNKNOWN_OUTPUT_JOB, 502: PRINTER_ERROR },
      }),
    },
    async (request) => {
      await requireOutputJob(request.params.id, request.params.outputJobId);
      return viaPlugin(() => printOutput.cancel(request.params.outputJobId));
    },
  );
}
