import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  completeStep,
  createFinishingPlan,
  FINISHING_STEP_KINDS,
  finishingProgress,
  skipStep,
  startStep,
  type Actor,
  type FinishingPlan,
  type FinishingProgress,
  type FinishingStepInput,
} from '@bax-print/core';
import type { FinishingPlanRepository } from '@bax-print/store';
import { notFound } from './errors.js';
import { doc } from './openapi.js';

export interface FinishingRouteOptions {
  /** The store package's `SqliteFinishingPlanRepository` satisfies it. */
  readonly plans: FinishingPlanRepository;
  /** Clock for plan and step timestamps; defaults to the system clock. */
  readonly now?: () => Date;
}

export interface FinishingRouteDeps extends FinishingRouteOptions {
  /** Resolves the caller; its id is recorded as the step's actor. */
  readonly authenticate: (request: FastifyRequest) => Actor;
}

/** The request body of `PUT /jobs/:id/finishing`. */
export interface PutFinishingPlanBody {
  steps: FinishingStepInput[];
}

/** The request body of `POST /jobs/:id/finishing/steps/:index/skip`. */
export interface SkipFinishingStepBody {
  reason: string;
}

/** A plan with its progress, as every finishing route answers it. */
export interface FinishingPlanState {
  readonly plan: FinishingPlan;
  readonly progress: FinishingProgress;
}

interface StepParams {
  id: string;
  index: number;
}

const JOB_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } };

const STEP_PARAMS = {
  type: 'object',
  required: ['id', 'index'],
  properties: { id: { type: 'string', minLength: 1 }, index: { type: 'integer', minimum: 0 } },
};

/** Shapes only; core checks the labels (`other` needs one, none may be blank). */
const PUT_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: { kind: { enum: [...FINISHING_STEP_KINDS] }, label: { type: 'string' } },
      },
    },
  },
};

const SKIP_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: { reason: { type: 'string', minLength: 1 } },
};

const NO_PLAN = 'The job has no finishing plan (`not_found`)';
const STORED_INVALID = 'The stored plan is malformed (`finishing_plan_invalid`)';
const STEP_INVALID = 'No such step, or the actor or time is invalid';
const TRANSITION_INVALID = 'The step status does not allow the move (`finishing_transition_invalid`)';

type StepMove = (plan: FinishingPlan, index: number, actor: string, at: string) => FinishingPlan;

const stateOf = (plan: FinishingPlan): FinishingPlanState => ({ plan, progress: finishingProgress(plan) });

/** Spec 004d: HTTP routes over the Spec 004b finishing plans persisted by Spec 004c. */
export function registerFinishingRoutes(app: FastifyInstance, deps: FinishingRouteDeps): void {
  const { plans, authenticate } = deps;
  const now = deps.now ?? (() => new Date());

  const planOf = (jobId: string): FinishingPlan => {
    const plan = plans.get(jobId);
    if (!plan) throw notFound('Finishing plan for job', jobId);
    return plan;
  };

  // Read, move and save run without an await between them, so two requests never interleave.
  const moveStep = (jobId: string, index: number, actor: Actor, move: StepMove): FinishingPlanState =>
    stateOf(plans.save(move(planOf(jobId), index, actor.id, now().toISOString())));

  app.put<{ Params: { id: string }; Body: PutFinishingPlanBody }>(
    '/jobs/:id/finishing',
    {
      schema: doc({
        operationId: 'putFinishingPlan',
        summary: "Creates the job's finishing plan from ordered steps, all pending; an existing plan is replaced",
        tags: ['finishing'],
        params: JOB_PARAMS,
        body: PUT_BODY,
        responses: {
          200: 'The plan replaced an existing one',
          201: 'The new plan',
          400: 'The body does not match the schema, or a label is missing or blank',
          422: 'The plan is invalid (`finishing_plan_invalid`)',
        },
        responseSchema: 'FinishingPlanState',
      }),
    },
    async (request, reply) => {
      const { id } = request.params;
      const existed = plans.get(id) !== undefined;
      const saved = plans.save(createFinishingPlan(id, request.body.steps, now().toISOString()));
      return reply.status(existed ? 200 : 201).send(stateOf(saved));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/jobs/:id/finishing',
    {
      schema: doc({
        operationId: 'getFinishingPlan',
        summary: "Reads the job's finishing plan and its progress",
        tags: ['finishing'],
        params: JOB_PARAMS,
        responses: { 200: 'The plan and its progress', 404: NO_PLAN, 422: STORED_INVALID },
        responseSchema: 'FinishingPlanState',
      }),
    },
    async (request): Promise<FinishingPlanState> => stateOf(planOf(request.params.id)),
  );

  const moves: readonly { action: string; operationId: string; summary: string; move: StepMove }[] = [
    {
      action: 'start',
      operationId: 'startFinishingStep',
      summary: 'Starts a pending step; every earlier step must be done or skipped',
      move: startStep,
    },
    { action: 'complete', operationId: 'completeFinishingStep', summary: 'Completes an in-progress step', move: completeStep },
  ];

  for (const { action, operationId, summary, move } of moves) {
    app.post<{ Params: StepParams }>(
      `/jobs/:id/finishing/steps/:index/${action}`,
      {
        schema: doc({
          operationId,
          summary,
          tags: ['finishing'],
          params: STEP_PARAMS,
          responses: { 200: 'The updated plan and its progress', 400: STEP_INVALID, 404: NO_PLAN, 409: TRANSITION_INVALID, 422: STORED_INVALID },
          responseSchema: 'FinishingPlanState',
        }),
      },
      async (request): Promise<FinishingPlanState> =>
        moveStep(request.params.id, request.params.index, authenticate(request), move),
    );
  }

  app.post<{ Params: StepParams; Body: SkipFinishingStepBody }>(
    '/jobs/:id/finishing/steps/:index/skip',
    {
      schema: doc({
        operationId: 'skipFinishingStep',
        summary: 'Skips a pending or in-progress step, recording the reason',
        tags: ['finishing'],
        params: STEP_PARAMS,
        body: SKIP_BODY,
        responses: {
          200: 'The updated plan and its progress',
          400: `The reason is missing or blank; or: ${STEP_INVALID}`,
          404: NO_PLAN,
          409: TRANSITION_INVALID,
          422: STORED_INVALID,
        },
        responseSchema: 'FinishingPlanState',
      }),
    },
    async (request): Promise<FinishingPlanState> => {
      const { reason } = request.body;
      return moveStep(request.params.id, request.params.index, authenticate(request), (plan, index, actor, at) =>
        skipStep(plan, index, actor, at, reason),
      );
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/jobs/:id/finishing',
    {
      schema: doc({
        operationId: 'deleteFinishingPlan',
        summary: "Deletes the job's finishing plan",
        tags: ['finishing'],
        params: JOB_PARAMS,
        responses: { 204: 'Deleted', 404: NO_PLAN },
      }),
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!plans.delete(id)) throw notFound('Finishing plan for job', id);
      return reply.status(204).send();
    },
  );

  app.get(
    '/finishing/incomplete',
    {
      schema: doc({
        operationId: 'listIncompleteFinishingPlans',
        summary: 'Lists the plans with a step that is neither done nor skipped, least recently saved first',
        tags: ['finishing'],
        responses: { 200: 'The incomplete plans and their progress', 422: STORED_INVALID },
        responseSchema: 'FinishingPlanStateList',
      }),
    },
    async (): Promise<{ items: FinishingPlanState[] }> => ({ items: plans.listIncomplete().map(stateOf) }),
  );
}
