import type { FastifyInstance } from 'fastify';
import type { CutJobResult } from '@bax-print/cut-export';
import type { Job } from '@bax-print/core';
import { EditError } from '@bax-print/edits';
import { CutterDriverError } from '@bax-print/plugin-sdk';
import { planCutJob, type CutPlanDeps } from './cut-service.js';
import { conflict, HttpError, notFound } from './errors.js';
import { doc } from './openapi.js';

/**
 * Reads the page a job is cut from (Spec 007g): its page boxes, the contour extraction stage and
 * the configured cut settings. Returns `undefined` when the job has no source document or the
 * page has no boxes.
 */
export type CutExtractor = (job: Job) => Promise<CutPlanDeps | undefined>;

/** The jobs `POST /jobs/:id/cut-job` plans for. */
export interface CutJobLookup {
  get(id: string): Promise<Job | undefined>;
}

export interface CutRouteDeps {
  readonly jobs: CutJobLookup;
  /** Without one the route answers 501 `cut_extractor_not_configured`. */
  readonly extractor?: CutExtractor;
}

type PlannedCutJob = Extract<CutJobResult, { kind: 'job' }>;

/** The success body: the contours and warnings next to the full cut job, or that the job is not cut. */
export type CutJobResponse =
  | { kind: 'none' }
  | { kind: 'job'; contours: PlannedCutJob['job']['contours']; warnings: PlannedCutJob['warnings']; job: PlannedCutJob['job'] };

const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } };

/** A trim-box contour that can't be resolved or a rectangle without area is the job's problem, not the server's. */
async function plan(job: Job, page: CutPlanDeps): Promise<CutJobResult> {
  try {
    return await planCutJob(job, page);
  } catch (error) {
    if (error instanceof EditError || error instanceof CutterDriverError) {
      throw new HttpError(422, 'invalid_cut_contour', error.message);
    }
    throw error;
  }
}

/** Spec 007g: `POST /jobs/:id/cut-job` plans the cut job of a job's page from its edits. */
export function registerCutRoutes(app: FastifyInstance, deps: CutRouteDeps): void {
  app.post<{ Params: { id: string } }>(
    '/jobs/:id/cut-job',
    {
      schema: doc({
        operationId: 'planCutJob',
        summary: "Plans the cut job of a job's page from its cutContour edit or the configured cut settings",
        tags: ['cut'],
        params: ID_PARAMS,
        responses: {
          200: 'The cut job, or `{ kind: "none" }` when the job is not cut',
          404: 'Unknown job',
          409: 'The job has no source document or page boxes',
          422: 'The cut contour edit can not be resolved on the page, or the source is not a readable PDF (`unreadable_pdf`)',
          501: 'No cut extractor is configured (`cut_extractor_not_configured`)',
        },
        responseSchema: 'CutJobResult',
      }),
    },
    async (request): Promise<CutJobResponse> => {
      const { id } = request.params;
      const job = await deps.jobs.get(id);
      if (!job) throw notFound('Job', id);
      if (!deps.extractor) {
        throw new HttpError(501, 'cut_extractor_not_configured', 'This server has no cut contour extractor configured');
      }
      const page = await deps.extractor(job);
      if (!page) throw conflict(`Job ${id} has no source document with page boxes to cut`);
      const result = await plan(job, page);
      if (result.kind === 'none') return { kind: 'none' };
      return { kind: 'job', contours: result.job.contours, warnings: result.warnings, job: result.job };
    },
  );
}
