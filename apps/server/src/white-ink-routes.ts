import type { FastifyInstance } from 'fastify';
import { InvalidArgumentError, parseWhiteInkSetting, systemClock, type Clock, type Job, type WhiteInkSetting } from '@bax-print/core';
import { notFound, whiteInkInvalid } from './errors.js';
import { doc } from './openapi.js';

/** Spec 038c: `1` mounts `PUT` and `DELETE /jobs/:id/white-ink`; unset leaves them off; any other value stops startup. */
export const WHITE_INK_ENV = 'BPS_WHITE_INK';

export function parseWhiteInkFlag(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[WHITE_INK_ENV];
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${WHITE_INK_ENV} must be 1 or unset, got ${JSON.stringify(value)}`);
}

/** The jobs whose white ink setting is set; the store package's job repositories satisfy it. */
export interface WhiteInkJobStore {
  get(jobId: string): Promise<Job | null | undefined>;
  save(job: Job): Promise<unknown>;
}

export interface WhiteInkRouteOptions {
  readonly jobs: WhiteInkJobStore;
  readonly clock?: Clock;
}

const PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

/**
 * Reads a `PUT /jobs/:id/white-ink` body with core `parseWhiteInkSetting`. A missing body is an
 * error too: the route sets a setting, and `DELETE` turns white ink off.
 */
export function parseWhiteInkBody(body: unknown): WhiteInkSetting {
  try {
    const setting = parseWhiteInkSetting(body ?? null);
    if (setting === undefined) throw whiteInkInvalid('send a white ink setting object');
    return setting;
  } catch (error) {
    if (error instanceof InvalidArgumentError) throw whiteInkInvalid(error.message);
    throw error;
  }
}

/** The job without `whiteInk`, or with `setting` as its `whiteInk`. */
function withWhiteInk(job: Job, setting: WhiteInkSetting | undefined, updatedAt: string): Job {
  const { whiteInk: _previous, ...rest } = job;
  return setting === undefined ? { ...rest, updatedAt } : { ...rest, whiteInk: setting, updatedAt };
}

/** Spec 038c: set or clear a job's Spec 038b white ink setting. */
export function registerWhiteInkRoutes(app: FastifyInstance, deps: WhiteInkRouteOptions): void {
  const { jobs } = deps;
  const clock = deps.clock ?? systemClock;

  const update = async (id: string, setting: WhiteInkSetting | undefined): Promise<{ job: Job }> => {
    const job = await jobs.get(id);
    if (!job) throw notFound('Job', id);
    const updated = withWhiteInk(job, setting, clock().toISOString());
    await jobs.save(updated);
    return { job: updated };
  };

  app.put<{ Params: { id: string } }>(
    '/jobs/:id/white-ink',
    {
      schema: doc({
        operationId: 'setJobWhiteInk',
        summary: "Set the job's white ink setting, replacing any previous one",
        tags: ['jobs'],
        params: PARAMS,
        bodyDoc: { $ref: '#/components/schemas/WhiteInkSetting' },
        responses: {
          200: '`{ job }`: the job with its new `whiteInk`',
          400: 'The body is not a valid white ink setting, e.g. an unknown field or a value out of range (`invalid_white_ink`)',
          404: 'No job has this id (`not_found`)',
        },
        responseSchema: 'WhiteInkJob',
      }),
    },
    async (request) => update(request.params.id, parseWhiteInkBody(request.body)),
  );

  app.delete<{ Params: { id: string } }>(
    '/jobs/:id/white-ink',
    {
      schema: doc({
        operationId: 'clearJobWhiteInk',
        summary: "Remove the job's white ink setting, so white ink is off",
        tags: ['jobs'],
        params: PARAMS,
        responses: {
          200: '`{ job }`: the job without `whiteInk`',
          404: 'No job has this id (`not_found`)',
        },
        responseSchema: 'WhiteInkJob',
      }),
    },
    async (request) => update(request.params.id, undefined),
  );
}
