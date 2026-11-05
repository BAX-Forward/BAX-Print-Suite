import type { FastifyInstance } from 'fastify';
import {
  MAX_STEP_REPEAT_COPIES,
  stepAndRepeatJob,
  type Contour,
  type ImposeWarning,
  type Layout,
  type SourceBox,
  type StepRepeatJob,
  type StepRepeatJobOptions,
  type StepRepeatRotation,
} from '@bax-print/nest';
import type { CutJobLookup } from './cut-routes.js';
import { conflict, HttpError, notFound } from './errors.js';
import { doc } from './openapi.js';
import { readSource } from './pdf-cut-extractor.js';

/** Builds the step-and-repeat job; tests replace it. */
export type StepRepeatRunner = (opts: StepRepeatJobOptions) => Promise<StepRepeatJob>;

export interface StepRepeatRouteOptions {
  /** Absolute path of a stored blob, the same resolver the cut extractor reads source files with. */
  readonly blobPath: (storageKey: string) => string;
  /** Default `stepAndRepeatJob` from `@bax-print/nest`. */
  readonly run?: StepRepeatRunner;
}

export interface StepRepeatRouteDeps extends StepRepeatRouteOptions {
  readonly jobs: CutJobLookup;
}

/** The request body of `POST /jobs/:id/step-repeat`. */
export interface StepRepeatBody {
  copies: number;
  rollWidthMm: number;
  marginsMm: { left: number; right: number; lead: number; trail: number };
  gapXMm: number;
  gapYMm: number;
  rotate: StepRepeatRotation;
  sourceBox: SourceBox;
  pageIndex?: number;
}

/** The success body: the roll layout, one trim contour per copy and the imposed PDF. */
export interface StepRepeatResponse {
  layout: Layout;
  cutContours: Contour[];
  warnings: ImposeWarning[];
  imposedPdfBase64: string;
}

const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } };

const NON_NEGATIVE = { type: 'number', minimum: 0 };

const STEP_REPEAT_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['copies', 'rollWidthMm', 'marginsMm', 'gapXMm', 'gapYMm', 'rotate', 'sourceBox'],
  properties: {
    copies: { type: 'integer', minimum: 1, maximum: MAX_STEP_REPEAT_COPIES },
    rollWidthMm: { type: 'number', exclusiveMinimum: 0 },
    marginsMm: {
      type: 'object',
      additionalProperties: false,
      required: ['left', 'right', 'lead', 'trail'],
      properties: { left: NON_NEGATIVE, right: NON_NEGATIVE, lead: NON_NEGATIVE, trail: NON_NEGATIVE },
    },
    gapXMm: NON_NEGATIVE,
    gapYMm: NON_NEGATIVE,
    rotate: { enum: ['none', 'auto'] },
    sourceBox: { enum: ['trim', 'bleed'] },
    pageIndex: { type: 'integer', minimum: 0 },
  },
};

/** Prefix of the errors `stepAndRepeatJob` throws for a source PDF it can't read. */
const NEST_JOB_ERROR_PREFIX = 'stepAndRepeatJob:';

/**
 * Options the nest package rejects (an item wider than the roll, too many placements, a missing
 * page) and a source it can't read are the request's problem, not the server's.
 */
async function build(run: StepRepeatRunner, opts: StepRepeatJobOptions): Promise<StepRepeatJob> {
  try {
    return await run(opts);
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError(422, 'invalid_step_repeat', error.message);
    if (error instanceof Error && error.message.startsWith(NEST_JOB_ERROR_PREFIX)) {
      throw new HttpError(422, 'unreadable_pdf', error.message);
    }
    throw error;
  }
}

/** Spec 003u: `POST /jobs/:id/step-repeat` steps and repeats a page of a job's source PDF on roll media. */
export function registerStepRepeatRoutes(app: FastifyInstance, deps: StepRepeatRouteDeps): void {
  const run = deps.run ?? stepAndRepeatJob;
  app.post<{ Params: { id: string }; Body: StepRepeatBody }>(
    '/jobs/:id/step-repeat',
    {
      schema: doc({
        operationId: 'stepRepeatJob',
        summary: "Steps and repeats a page of a job's first source PDF on roll media, with one trim cut contour per copy",
        tags: ['nest'],
        params: ID_PARAMS,
        body: STEP_REPEAT_BODY,
        responses: {
          200: 'The roll layout, the cut contours and the imposed PDF (base64)',
          400: 'The body does not match the schema (`invalid_request`)',
          404: 'Unknown job',
          409: 'The job has no source file',
          422: 'The options can not be laid out (`invalid_step_repeat`) or the source is not a readable PDF (`unreadable_pdf`)',
        },
        responseSchema: 'StepRepeatResult',
      }),
    },
    async (request): Promise<StepRepeatResponse> => {
      const { id } = request.params;
      const job = await deps.jobs.get(id);
      if (!job) throw notFound('Job', id);
      const sourcePdf = await readSource(job, deps.blobPath);
      if (!sourcePdf) throw conflict(`Job ${id} has no source file to step and repeat`);
      const { body } = request;
      const result = await build(run, {
        sourcePdf,
        sourceBox: body.sourceBox,
        copies: body.copies,
        rollWidthMm: body.rollWidthMm,
        marginsMm: body.marginsMm,
        gapXMm: body.gapXMm,
        gapYMm: body.gapYMm,
        rotate: body.rotate,
        ...(body.pageIndex === undefined ? {} : { pageIndex: body.pageIndex }),
      });
      return {
        layout: result.layout,
        cutContours: result.cutContours,
        warnings: result.warnings,
        imposedPdfBase64: Buffer.from(result.imposedPdf).toString('base64'),
      };
    },
  );
}
