import type { FastifyInstance } from 'fastify';
import type { Job } from '@bax-print/core';
import type { CutJobLookup } from './cut-routes.js';
import { conflict, notFound, printOutputHttpError, unsupportedFormat } from './errors.js';
import { doc } from './openapi.js';
import { readSource } from './pdf-cut-extractor.js';
import { PrintOutputError, type PrintOutput } from './print-output.js';

export interface PrintOutputRouteOptions {
  /** The one configured printer plugin; closed with the server. */
  readonly output: PrintOutput;
  /** Absolute path of a stored blob, the same resolver the proof route reads source files with. */
  readonly blobPath: (storageKey: string) => string;
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

/**
 * Spec 034a: sends a job's first source PDF to the configured printer plugin and reports or
 * cancels the output job it creates. Nothing is recorded on the job.
 */
export function registerPrintOutputRoutes(app: FastifyInstance, deps: PrintOutputRouteDeps): void {
  const printOutput = deps.output;
  app.addHook('onClose', async () => printOutput.close());

  const requireJob = async (id: string): Promise<Job> => {
    const job = await deps.jobs.get(id);
    if (!job) throw notFound('Job', id);
    return job;
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
        responses: { 200: 'The output job state', 404: 'Unknown job', 502: PRINTER_ERROR },
      }),
    },
    async (request) => {
      await requireJob(request.params.id);
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
        responses: { 200: 'The output job state after the cancel', 404: 'Unknown job', 502: PRINTER_ERROR },
      }),
    },
    async (request) => {
      await requireJob(request.params.id);
      return viaPlugin(() => printOutput.cancel(request.params.outputJobId));
    },
  );
}
