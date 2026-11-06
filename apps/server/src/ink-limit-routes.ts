import type { FastifyInstance } from 'fastify';
import { InvalidArgumentError, parseInkLimitSetting, systemClock, type Clock, type InkLimitSetting, type Job } from '@bax-print/core';
import { inkLimitInvalid, notFound } from './errors.js';
import { doc } from './openapi.js';

/** Spec 040c: `1` mounts `PUT` and `DELETE /jobs/:id/ink-limit`; unset leaves them off; any other value stops startup. */
export const INK_LIMIT_ENV = 'BPS_INK_LIMIT';

/** Spec 040c: an ink-limit setting is two small fields, so the body is capped well below Fastify's default. */
export const INK_LIMIT_BODY_LIMIT = 16 * 1024;

export function parseInkLimitFlag(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[INK_LIMIT_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${INK_LIMIT_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

/** The jobs whose ink-limit setting is set; the store package's job repositories satisfy it. */
export interface InkLimitJobStore {
  get(jobId: string): Promise<Job | null | undefined>;
  save(job: Job): Promise<unknown>;
}

export interface InkLimitRouteOptions {
  readonly jobs: InkLimitJobStore;
  readonly clock?: Clock;
}

const PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

/**
 * Reads a `PUT /jobs/:id/ink-limit` body with core `parseInkLimitSetting`. A missing body is an
 * error too: the route sets a setting, and `DELETE` turns the ink limit off.
 */
export function parseInkLimitBody(body: unknown): InkLimitSetting {
  try {
    const setting = parseInkLimitSetting(body ?? null);
    if (setting === undefined) throw inkLimitInvalid('send an ink-limit setting object');
    return setting;
  } catch (error) {
    if (error instanceof InvalidArgumentError) throw inkLimitInvalid(error.message);
    throw error;
  }
}

/** The job without `inkLimit`, or with `setting` as its `inkLimit`. */
function withInkLimit(job: Job, setting: InkLimitSetting | undefined, updatedAt: string): Job {
  const { inkLimit: _previous, ...rest } = job;
  return setting === undefined ? { ...rest, updatedAt } : { ...rest, inkLimit: setting, updatedAt };
}

/** Spec 040c: set or clear a job's Spec 040b ink-limit setting. */
export function registerInkLimitRoutes(app: FastifyInstance, deps: InkLimitRouteOptions): void {
  const { jobs } = deps;
  const clock = deps.clock ?? systemClock;

  const update = async (id: string, setting: InkLimitSetting | undefined): Promise<{ job: Job }> => {
    const job = await jobs.get(id);
    if (!job) throw notFound('Job', id);
    const updated = withInkLimit(job, setting, clock().toISOString());
    await jobs.save(updated);
    return { job: updated };
  };

  app.put<{ Params: { id: string } }>(
    '/jobs/:id/ink-limit',
    {
      bodyLimit: INK_LIMIT_BODY_LIMIT,
      schema: doc({
        operationId: 'setJobInkLimit',
        summary: "Set the job's ink-limit (TAC) setting, replacing any previous one",
        tags: ['jobs'],
        params: PARAMS,
        bodyDoc: { $ref: '#/components/schemas/InkLimitSetting' },
        responses: {
          200: '`{ job }`: the job with its new `inkLimit`',
          400: 'The body is not a valid ink-limit setting, e.g. an unknown field, method or limit (`invalid_ink_limit`)',
          404: 'No job has this id (`not_found`)',
          413: `The body is larger than ${String(INK_LIMIT_BODY_LIMIT)} bytes (\`invalid_request\`)`,
        },
        responseSchema: 'InkLimitJob',
      }),
    },
    async (request) => update(request.params.id, parseInkLimitBody(request.body)),
  );

  app.delete<{ Params: { id: string } }>(
    '/jobs/:id/ink-limit',
    {
      schema: doc({
        operationId: 'clearJobInkLimit',
        summary: "Remove the job's ink-limit setting, so no ink limit is requested",
        tags: ['jobs'],
        params: PARAMS,
        responses: {
          200: '`{ job }`: the job without `inkLimit`',
          404: 'No job has this id (`not_found`)',
        },
        responseSchema: 'InkLimitJob',
      }),
    },
    async (request) => update(request.params.id, undefined),
  );
}
