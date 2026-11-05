import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { FinishingStepInput } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import {
  MemoryArchiveIndex,
  MemoryJobRepository,
  MemoryStorage,
  openDatabase,
  SqliteFinishingPlanRepository,
  type Database,
} from '@bax-print/store';
import { buildServer } from '../src/app.js';
import type { FinishingPlanState } from '../src/finishing-routes.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { fakeClock, sequentialIds } from './helpers.js';

const NOW = '2026-03-01T08:00:00.000Z';
const OPERATOR = 'operator-1';

const STEPS: readonly FinishingStepInput[] = [{ kind: 'laminate' }, { kind: 'cut' }, { kind: 'other', label: 'Pack' }];

interface InjectResponse {
  readonly statusCode: number;
  readonly body: string;
  json<T = unknown>(): T;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly db: Database;
}

describe('/jobs/:id/finishing routes (Spec 004d)', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.app.close();
    h?.db.close();
    h = undefined;
  });

  /** A server over an in-memory job database, wired as `main.ts` wires it with `BPS_DATABASE`. */
  function createHarness(): Harness {
    const time = fakeClock(NOW);
    const outbox = new MemoryOutbox();
    const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
    const repository = new MemoryJobRepository();
    const archive = new ArchiveService({
      jobs: repository,
      index: new MemoryArchiveIndex(),
      blobs: new MemoryStorage(),
      archive: new MemoryStorage(),
      bus,
      outbox,
      colorSetups: new StaticColorSetupResolver(),
      clock: time.clock,
      newId: sequentialIds('pkg'),
    });
    const media = new MediaService({ stores: memoryMediaStores(), bus, jobs: repository, clock: time.clock, newId: sequentialIds('m') });
    const db = openDatabase();
    const now = (): Date => new Date(NOW);
    const plans = new SqliteFinishingPlanRepository(db, { now });
    const app = buildServer({
      archive,
      media,
      finishing: { plans, now },
      authenticate: () => ({ id: OPERATOR, role: 'admin' }),
    });
    return { app, db };
  }

  function putPlan(harness: Harness, jobId: string, body: object = { steps: STEPS }): Promise<InjectResponse> {
    return harness.app.inject({ method: 'PUT', url: `/jobs/${jobId}/finishing`, payload: body });
  }

  function getPlan(harness: Harness, jobId: string): Promise<InjectResponse> {
    return harness.app.inject({ method: 'GET', url: `/jobs/${jobId}/finishing` });
  }

  function move(harness: Harness, jobId: string, index: number, action: string, body?: object): Promise<InjectResponse> {
    const url = `/jobs/${jobId}/finishing/steps/${index}/${action}`;
    return harness.app.inject(body === undefined ? { method: 'POST', url } : { method: 'POST', url, payload: body });
  }

  async function moved(harness: Harness, jobId: string, index: number, action: string, body?: object): Promise<FinishingPlanState> {
    const response = await move(harness, jobId, index, action, body);
    expect(response.statusCode).toBe(200);
    return response.json<FinishingPlanState>();
  }

  it('creates a plan, then starts, completes and skips steps to the end', async () => {
    h = createHarness();

    const created = await putPlan(h, 'job-1');

    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      plan: {
        jobId: 'job-1',
        createdAt: NOW,
        updatedAt: NOW,
        steps: [
          { index: 0, kind: 'laminate', status: 'pending' },
          { index: 1, kind: 'cut', status: 'pending' },
          { index: 2, kind: 'other', label: 'Pack', status: 'pending' },
        ],
      },
      progress: { total: 3, pending: 3, inProgress: 0, done: 0, skipped: 0, nextStep: { index: 0, kind: 'laminate', status: 'pending' }, isComplete: false },
    });

    const started = await moved(h, 'job-1', 0, 'start');
    expect(started.plan.steps[0]).toEqual({ index: 0, kind: 'laminate', status: 'in_progress', startedBy: OPERATOR, startedAt: NOW });
    expect(started.progress).toMatchObject({ pending: 2, inProgress: 1 });

    const completed = await moved(h, 'job-1', 0, 'complete');
    expect(completed.plan.steps[0]).toMatchObject({ status: 'done', completedBy: OPERATOR, completedAt: NOW });
    expect(completed.progress.nextStep).toMatchObject({ index: 1 });

    const skipped = await moved(h, 'job-1', 1, 'skip', { reason: '  Cut on the table  ' });
    expect(skipped.plan.steps[1]).toEqual({
      index: 1,
      kind: 'cut',
      status: 'skipped',
      skippedBy: OPERATOR,
      skippedAt: NOW,
      skipReason: 'Cut on the table',
    });

    await moved(h, 'job-1', 2, 'start');
    const done = await moved(h, 'job-1', 2, 'complete');
    expect(done.progress).toEqual({ total: 3, pending: 0, inProgress: 0, done: 2, skipped: 1, isComplete: true });

    const read = await getPlan(h, 'job-1');
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(done);
  });

  it('answers 200 when a plan replaces an existing one', async () => {
    h = createHarness();
    await putPlan(h, 'job-1');
    await moved(h, 'job-1', 0, 'start');

    const replaced = await putPlan(h, 'job-1', { steps: [{ kind: 'hem' }] });

    expect(replaced.statusCode).toBe(200);
    expect(replaced.json<FinishingPlanState>().plan.steps).toEqual([{ index: 0, kind: 'hem', status: 'pending' }]);
  });

  it('lists only the incomplete plans', async () => {
    h = createHarness();
    await putPlan(h, 'job-a', { steps: [{ kind: 'mount' }] });
    await putPlan(h, 'job-b', { steps: [{ kind: 'weed' }] });
    await putPlan(h, 'job-c', { steps: [{ kind: 'grommet' }] });
    await moved(h, 'job-b', 0, 'skip', { reason: 'Customer collects unweeded' });
    await moved(h, 'job-c', 0, 'start');

    const response = await h.app.inject({ method: 'GET', url: '/finishing/incomplete' });

    expect(response.statusCode).toBe(200);
    const { items } = response.json<{ items: FinishingPlanState[] }>();
    expect(items.map((item) => item.plan.jobId)).toEqual(['job-a', 'job-c']);
    expect(items[1]?.progress).toMatchObject({ inProgress: 1, isComplete: false });
  });

  it('lists no plans as no items', async () => {
    h = createHarness();

    const response = await h.app.inject({ method: 'GET', url: '/finishing/incomplete' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it.each([
    ['completing a pending step', 0, 'complete'],
    ['starting a step before the earlier ones are resolved', 1, 'start'],
  ])('answers 409 finishing_transition_invalid for %s', async (_name, index, action) => {
    h = createHarness();
    await putPlan(h, 'job-1');

    const response = await move(h, 'job-1', index, action);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'finishing_transition_invalid', message: expect.any(String) } });
    expect((await getPlan(h, 'job-1')).json<FinishingPlanState>().progress.pending).toBe(3);
  });

  it('answers 409 finishing_transition_invalid when skipping a done step', async () => {
    h = createHarness();
    await putPlan(h, 'job-1');
    await moved(h, 'job-1', 0, 'start');
    await moved(h, 'job-1', 0, 'complete');

    const response = await move(h, 'job-1', 0, 'skip', { reason: 'Too late' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'finishing_transition_invalid' } });
  });

  it('answers 422 finishing_plan_invalid when the stored plan is malformed', async () => {
    h = createHarness();
    await putPlan(h, 'job-1');
    h.db.prepare('UPDATE finishing_plans SET plan_json = ? WHERE job_id = ?').run('{"jobId":"job-1","steps":[]}', 'job-1');

    const read = await getPlan(h, 'job-1');
    const started = await move(h, 'job-1', 0, 'start');

    expect(read.statusCode).toBe(422);
    expect(read.json()).toEqual({ error: { code: 'finishing_plan_invalid', message: expect.any(String) } });
    expect(started.statusCode).toBe(422);
    expect((await h.app.inject({ method: 'GET', url: '/finishing/incomplete' })).statusCode).toBe(422);
  });

  it.each([
    ['no steps', { steps: [] }],
    ['an unknown kind', { steps: [{ kind: 'fold' }] }],
    ['a missing steps field', {}],
  ])('answers 400 invalid_request for a plan with %s', async (_name, body) => {
    h = createHarness();

    const response = await putPlan(h, 'job-1', body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_request', message: expect.any(String) } });
    expect((await getPlan(h, 'job-1')).statusCode).toBe(404);
  });

  it('keeps the core 400 for an "other" step without a label', async () => {
    h = createHarness();

    const response = await putPlan(h, 'job-1', { steps: [{ kind: 'other' }] });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { message: 'step 0 is "other" and needs a label' } });
  });

  it('answers 400 for a skip without a reason, a blank reason or an unknown step', async () => {
    h = createHarness();
    await putPlan(h, 'job-1');

    const missing = await move(h, 'job-1', 0, 'skip', {});
    const blank = await move(h, 'job-1', 0, 'skip', { reason: '   ' });
    const unknown = await move(h, 'job-1', 7, 'start');

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ error: { message: 'skip reason must not be blank' } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { message: 'job job-1 has no finishing step 7' } });
  });

  it('answers 404 not_found for a job without a plan', async () => {
    h = createHarness();
    const notFound = { error: { code: 'not_found', message: 'Finishing plan for job no-such-job not found' } };

    const responses = [
      await getPlan(h, 'no-such-job'),
      await move(h, 'no-such-job', 0, 'start'),
      await move(h, 'no-such-job', 0, 'complete'),
      await move(h, 'no-such-job', 0, 'skip', { reason: 'Not needed' }),
      await h.app.inject({ method: 'DELETE', url: '/jobs/no-such-job/finishing' }),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(notFound);
    }
  });

  it('deletes a plan, then answers 404 for it', async () => {
    h = createHarness();
    await putPlan(h, 'job-1');

    const deleted = await h.app.inject({ method: 'DELETE', url: '/jobs/job-1/finishing' });

    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    expect((await getPlan(h, 'job-1')).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'DELETE', url: '/jobs/job-1/finishing' })).statusCode).toBe(404);
  });

  it('is not mounted without a finishing plan repository', async () => {
    const time = fakeClock(NOW);
    const outbox = new MemoryOutbox();
    const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
    const archive = new ArchiveService({
      jobs: new MemoryJobRepository(),
      index: new MemoryArchiveIndex(),
      blobs: new MemoryStorage(),
      archive: new MemoryStorage(),
      bus,
      outbox,
      colorSetups: new StaticColorSetupResolver(),
      clock: time.clock,
      newId: sequentialIds('pkg'),
    });
    const app = buildServer({ archive });

    const response = await app.inject({ method: 'GET', url: '/jobs/job-1/finishing' });
    await app.close();

    expect(response.statusCode).toBe(404);
  });

  it('documents every route and error in /openapi.json', async () => {
    h = createHarness();

    const document = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    }>();

    const plan = document.paths['/jobs/{id}/finishing'];
    const step = (action: string) => document.paths[`/jobs/{id}/finishing/steps/{index}/${action}`]?.post;
    expect(plan?.put?.operationId).toBe('putFinishingPlan');
    expect(Object.keys(plan?.put?.responses ?? {})).toEqual(expect.arrayContaining(['200', '201', '400', '422']));
    expect(plan?.get?.operationId).toBe('getFinishingPlan');
    expect(Object.keys(plan?.get?.responses ?? {})).toEqual(expect.arrayContaining(['200', '404', '422']));
    expect(plan?.delete?.operationId).toBe('deleteFinishingPlan');
    expect(Object.keys(plan?.delete?.responses ?? {})).toEqual(expect.arrayContaining(['204', '404']));
    expect(step('start')?.operationId).toBe('startFinishingStep');
    expect(step('complete')?.operationId).toBe('completeFinishingStep');
    expect(step('skip')?.operationId).toBe('skipFinishingStep');
    for (const action of ['start', 'complete', 'skip']) {
      expect(Object.keys(step(action)?.responses ?? {})).toEqual(expect.arrayContaining(['200', '400', '404', '409', '422']));
    }
    expect(document.paths['/finishing/incomplete']?.get?.operationId).toBe('listIncompleteFinishingPlans');
    for (const name of ['FinishingStep', 'FinishingPlan', 'FinishingProgress', 'FinishingPlanState', 'FinishingPlanStateList']) {
      expect(document.components.schemas).toHaveProperty(name);
    }
  });
});
