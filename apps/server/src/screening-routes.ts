import type { FastifyInstance } from 'fastify';
import { InvalidArgumentError, parseScreeningSetting, systemClock, type Clock, type Job, type ScreeningSetting } from '@bax-print/core';
import { notFound, screeningInvalid } from './errors.js';
import { doc } from './openapi.js';

/** Spec 039c: `1` mounts `PUT` and `DELETE /jobs/:id/screening`; unset leaves them off; any other value stops startup. */
export const SCREENING_ENV = 'BPS_SCREENING';

/** Spec 039c: a screening setting is a few small fields, so the body is capped well below Fastify's default. */
export const SCREENING_BODY_LIMIT = 16 * 1024;

export function parseScreeningFlag(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[SCREENING_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${SCREENING_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

/** The jobs whose screening setting is set; the store package's job repositories satisfy it. */
export interface ScreeningJobStore {
  get(jobId: string): Promise<Job | null | undefined>;
  save(job: Job): Promise<unknown>;
}

export interface ScreeningRouteOptions {
  readonly jobs: ScreeningJobStore;
  readonly clock?: Clock;
}

const PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

/**
 * Reads a `PUT /jobs/:id/screening` body with core `parseScreeningSetting`. A missing body is an
 * error too: the route sets a setting, and `DELETE` turns screening off.
 */
export function parseScreeningBody(body: unknown): ScreeningSetting {
  try {
    const setting = parseScreeningSetting(body ?? null);
    if (setting === undefined) throw screeningInvalid('send a screening setting object');
    return setting;
  } catch (error) {
    if (error instanceof InvalidArgumentError) throw screeningInvalid(error.message);
    throw error;
  }
}

/** The job without `screening`, or with `setting` as its `screening`. */
function withScreening(job: Job, setting: ScreeningSetting | undefined, updatedAt: string): Job {
  const { screening: _previous, ...rest } = job;
  return setting === undefined ? { ...rest, updatedAt } : { ...rest, screening: setting, updatedAt };
}

/** Spec 039c: set or clear a job's Spec 039b screening setting. */
export function registerScreeningRoutes(app: FastifyInstance, deps: ScreeningRouteOptions): void {
  const { jobs } = deps;
  const clock = deps.clock ?? systemClock;

  const update = async (id: string, setting: ScreeningSetting | undefined): Promise<{ job: Job }> => {
    const job = await jobs.get(id);
    if (!job) throw notFound('Job', id);
    const updated = withScreening(job, setting, clock().toISOString());
    await jobs.save(updated);
    return { job: updated };
  };

  app.put<{ Params: { id: string } }>(
    '/jobs/:id/screening',
    {
      bodyLimit: SCREENING_BODY_LIMIT,
      schema: doc({
        operationId: 'setJobScreening',
        summary: "Set the job's screening setting, replacing any previous one",
        tags: ['jobs'],
        params: PARAMS,
        bodyDoc: { $ref: '#/components/schemas/ScreeningSetting' },
        responses: {
          200: '`{ job }`: the job with its new `screening`',
          400: 'The body is not a valid screening setting, e.g. an unknown field, kind or size (`invalid_screening`)',
          404: 'No job has this id (`not_found`)',
          413: `The body is larger than ${String(SCREENING_BODY_LIMIT)} bytes (\`invalid_request\`)`,
        },
        responseSchema: 'ScreeningJob',
      }),
    },
    async (request) => update(request.params.id, parseScreeningBody(request.body)),
  );

  app.delete<{ Params: { id: string } }>(
    '/jobs/:id/screening',
    {
      schema: doc({
        operationId: 'clearJobScreening',
        summary: "Remove the job's screening setting, so no screening is requested",
        tags: ['jobs'],
        params: PARAMS,
        responses: {
          200: '`{ job }`: the job without `screening`',
          404: 'No job has this id (`not_found`)',
        },
        responseSchema: 'ScreeningJob',
      }),
    },
    async (request) => update(request.params.id, undefined),
  );
}
