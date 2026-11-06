import type { FastifyInstance } from 'fastify';
import { InvalidArgumentError, parsePlaneCurvesSetting, systemClock, type Clock, type Job, type PlaneCurvesSetting } from '@bax-print/core';
import { notFound, planeCurvesInvalid } from './errors.js';
import { doc } from './openapi.js';

/** Spec 044d: `1` mounts `PUT` and `DELETE /jobs/:id/plane-curves`; unset leaves them off; any other value stops startup. */
export const PLANE_CURVES_ENV = 'BPS_PLANE_CURVES';

/**
 * Spec 044d: the worst case is 4 channels of 256 points of `{"in":255,"out":255}` (about 21 bytes each)
 * plus the methods and keys, about 22 KB of compact JSON. 64 KiB leaves room for pretty-printed JSON and
 * still stays well below Fastify's default.
 */
export const PLANE_CURVES_BODY_LIMIT = 64 * 1024;

export function parsePlaneCurvesFlag(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[PLANE_CURVES_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${PLANE_CURVES_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

/** The jobs whose plane-curves setting is set; the store package's job repositories satisfy it. */
export interface PlaneCurvesJobStore {
  get(jobId: string): Promise<Job | null | undefined>;
  save(job: Job): Promise<unknown>;
}

export interface PlaneCurvesRouteOptions {
  readonly jobs: PlaneCurvesJobStore;
  readonly clock?: Clock;
}

const PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

/**
 * Reads a `PUT /jobs/:id/plane-curves` body with core `parsePlaneCurvesSetting`. A missing body is an
 * error too: the route sets a setting, and `DELETE` turns the curves off.
 */
export function parsePlaneCurvesBody(body: unknown): PlaneCurvesSetting {
  try {
    const setting = parsePlaneCurvesSetting(body ?? null);
    if (setting === undefined) throw planeCurvesInvalid('send a plane-curves setting object');
    return setting;
  } catch (error) {
    if (error instanceof InvalidArgumentError) throw planeCurvesInvalid(error.message);
    throw error;
  }
}

/** The job without `planeCurves`, or with `setting` as its `planeCurves`. */
function withPlaneCurves(job: Job, setting: PlaneCurvesSetting | undefined, updatedAt: string): Job {
  const { planeCurves: _previous, ...rest } = job;
  return setting === undefined ? { ...rest, updatedAt } : { ...rest, planeCurves: setting, updatedAt };
}

/** Spec 044d: set or clear a job's Spec 044b plane-curves setting. */
export function registerPlaneCurvesRoutes(app: FastifyInstance, deps: PlaneCurvesRouteOptions): void {
  const { jobs } = deps;
  const clock = deps.clock ?? systemClock;

  const update = async (id: string, setting: PlaneCurvesSetting | undefined): Promise<{ job: Job }> => {
    const job = await jobs.get(id);
    if (!job) throw notFound('Job', id);
    const updated = withPlaneCurves(job, setting, clock().toISOString());
    await jobs.save(updated);
    return { job: updated };
  };

  app.put<{ Params: { id: string } }>(
    '/jobs/:id/plane-curves',
    {
      bodyLimit: PLANE_CURVES_BODY_LIMIT,
      schema: doc({
        operationId: 'setJobPlaneCurves',
        summary: "Set the job's per-channel curves (linearization) setting, replacing any previous one",
        tags: ['jobs'],
        params: PARAMS,
        bodyDoc: { $ref: '#/components/schemas/PlaneCurvesSetting' },
        responses: {
          200: '`{ job }`: the job with its new `planeCurves`',
          400: 'The body is not a valid plane-curves setting, e.g. `{}`, an unknown field or method, or points out of order (`invalid_plane_curves`)',
          404: 'No job has this id (`not_found`)',
          413: `The body is larger than ${String(PLANE_CURVES_BODY_LIMIT)} bytes (\`invalid_request\`)`,
        },
        responseSchema: 'PlaneCurvesJob',
      }),
    },
    async (request) => update(request.params.id, parsePlaneCurvesBody(request.body)),
  );

  app.delete<{ Params: { id: string } }>(
    '/jobs/:id/plane-curves',
    {
      schema: doc({
        operationId: 'clearJobPlaneCurves',
        summary: "Remove the job's plane-curves setting, so no curves are requested",
        tags: ['jobs'],
        params: PARAMS,
        responses: {
          200: '`{ job }`: the job without `planeCurves`',
          404: 'No job has this id (`not_found`)',
        },
        responseSchema: 'PlaneCurvesJob',
      }),
    },
    async (request) => update(request.params.id, undefined),
  );
}
