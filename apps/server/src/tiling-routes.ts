import type { FastifyInstance } from 'fastify';
import { InvalidArgumentError, parseTilingSetting, systemClock, type Clock, type Job, type TilingSetting } from '@bax-print/core';
import { notFound, tilingInvalid } from './errors.js';
import { doc } from './openapi.js';

/** Spec 050a: `1` mounts `PUT` and `DELETE /jobs/:id/tiling`; unset leaves them off; any other value stops startup. */
export const TILING_ENV = 'BPS_TILING';

/**
 * Spec 050a: a tiling setting is a grid and one seam, well under 200 bytes of compact JSON. 64 KiB matches
 * the other job setting routes and still stays well below Fastify's default.
 */
export const TILING_BODY_LIMIT = 64 * 1024;

export function parseTilingFlag(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[TILING_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${TILING_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

/** The jobs whose tiling setting is set; the store package's job repositories satisfy it. */
export interface TilingJobStore {
  get(jobId: string): Promise<Job | null | undefined>;
  save(job: Job): Promise<unknown>;
}

export interface TilingRouteOptions {
  readonly jobs: TilingJobStore;
  readonly clock?: Clock;
}

const PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

/**
 * Reads a `PUT /jobs/:id/tiling` body with core `parseTilingSetting`. A missing body is an error too: the
 * route sets a setting, and `DELETE` turns tiling off.
 */
export function parseTilingBody(body: unknown): TilingSetting {
  try {
    const setting = parseTilingSetting(body ?? null);
    if (setting === undefined) throw tilingInvalid('send a tiling setting object');
    return setting;
  } catch (error) {
    if (error instanceof InvalidArgumentError) throw tilingInvalid(error.message);
    throw error;
  }
}

/** The job without `tiling`, or with `setting` as its `tiling`. */
function withTiling(job: Job, setting: TilingSetting | undefined, updatedAt: string): Job {
  const { tiling: _previous, ...rest } = job;
  return setting === undefined ? { ...rest, updatedAt } : { ...rest, tiling: setting, updatedAt };
}

/** Spec 050a: set or clear a job's tiling setting. */
export function registerTilingRoutes(app: FastifyInstance, deps: TilingRouteOptions): void {
  const { jobs } = deps;
  const clock = deps.clock ?? systemClock;

  const update = async (id: string, setting: TilingSetting | undefined): Promise<{ job: Job }> => {
    const job = await jobs.get(id);
    if (!job) throw notFound('Job', id);
    const updated = withTiling(job, setting, clock().toISOString());
    await jobs.save(updated);
    return { job: updated };
  };

  app.put<{ Params: { id: string } }>(
    '/jobs/:id/tiling',
    {
      bodyLimit: TILING_BODY_LIMIT,
      schema: doc({
        operationId: 'setJobTiling',
        summary: "Set the job's tiling (panel grid and seam) setting, replacing any previous one",
        tags: ['jobs'],
        params: PARAMS,
        bodyDoc: { $ref: '#/components/schemas/TilingSetting' },
        responses: {
          200: '`{ job }`: the job with its new `tiling`',
          400: 'The body is not a valid tiling setting, e.g. `{}`, an unknown field or seam kind, or a grid count out of range (`invalid_tiling`)',
          404: 'No job has this id (`not_found`)',
          413: `The body is larger than ${String(TILING_BODY_LIMIT)} bytes (\`invalid_request\`)`,
        },
        responseSchema: 'TilingJob',
      }),
    },
    async (request) => update(request.params.id, parseTilingBody(request.body)),
  );

  app.delete<{ Params: { id: string } }>(
    '/jobs/:id/tiling',
    {
      schema: doc({
        operationId: 'clearJobTiling',
        summary: "Remove the job's tiling setting, so the job is not tiled",
        tags: ['jobs'],
        params: PARAMS,
        responses: {
          200: '`{ job }`: the job without `tiling`',
          404: 'No job has this id (`not_found`)',
        },
        responseSchema: 'TilingJob',
      }),
    },
    async (request) => update(request.params.id, undefined),
  );
}
