import type { FastifyInstance } from 'fastify';
import { MarkSpecError, parseProofWatermark, proofWatermark, type ProofWatermark } from '@bax-print/marks';
import type { CutJobLookup } from './cut-routes.js';
import { conflict, HttpError, notFound, proofWatermarkInvalid } from './errors.js';
import { doc } from './openapi.js';
import { readSource } from './pdf-cut-extractor.js';

export interface ProofRouteOptions {
  /** Absolute path of a stored blob, the same resolver the step-repeat route reads source files with. */
  readonly blobPath: (storageKey: string) => string;
}

export interface ProofRouteDeps extends ProofRouteOptions {
  readonly jobs: CutJobLookup;
}

const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } };

/**
 * Documentation only: the marks package validates the options, so out-of-range values answer
 * 422 with its issues instead of a Fastify 400 (and are not coerced on the way).
 */
const PROOF_BODY = {
  type: 'object',
  properties: {
    text: { description: '1-64 printable ASCII characters, not blank; default `PROOF`' },
    opacity: { description: 'Number from 0.05 to 0.9; default 0.25' },
    angleDeg: { description: "Number from -360 to 360, counter-clockwise from the page's x axis; default 45" },
    fontSizePt: { description: 'Number from 1 to 2000, or `auto` to fit the trim box; default `auto`' },
  },
};

function parseOptions(body: unknown): ProofWatermark {
  try {
    return parseProofWatermark(body);
  } catch (error) {
    if (error instanceof MarkSpecError) throw proofWatermarkInvalid(error.message, error.issues);
    throw error;
  }
}

/** The options are already valid, so anything the marks package rejects now is the source PDF. */
async function stamp(sourcePdf: Uint8Array, options: ProofWatermark): Promise<Uint8Array> {
  try {
    return await proofWatermark(sourcePdf, options);
  } catch (error) {
    if (error instanceof MarkSpecError) throw new HttpError(422, 'unreadable_pdf', error.message);
    throw error;
  }
}

/** Spec 004a: `POST /jobs/:id/proof` answers a job's first source PDF with the Spec 003z proof watermark on every page. */
export function registerProofRoutes(app: FastifyInstance, deps: ProofRouteDeps): void {
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/jobs/:id/proof',
    {
      schema: doc({
        operationId: 'proofJob',
        summary: "Stamps the proof watermark on every page of a job's first source PDF",
        tags: ['marks'],
        params: ID_PARAMS,
        body: PROOF_BODY,
        produces: 'application/pdf',
        responses: {
          200: 'The watermarked PDF',
          400: 'The body is not a JSON object (`invalid_request`)',
          404: 'Unknown job',
          409: 'The job has no source file',
          422: 'The options are invalid (`proof_watermark_invalid`, issues in `details`) or the source is not a readable PDF (`unreadable_pdf`)',
        },
      }),
    },
    async (request, reply) => {
      const options = parseOptions(request.body);
      const { id } = request.params;
      const job = await deps.jobs.get(id);
      if (!job) throw notFound('Job', id);
      const sourcePdf = await readSource(job, deps.blobPath);
      if (!sourcePdf) throw conflict(`Job ${id} has no source file to proof`);
      const proof = await stamp(sourcePdf, options);
      return reply
        .header('content-type', 'application/pdf')
        .send(Buffer.from(proof.buffer, proof.byteOffset, proof.byteLength));
    },
  );
}
