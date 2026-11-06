import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { localAdminMembership, type Actor, type SiteMembership } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import {
  DEFAULT_JOB_INTAKE_MAX_BYTES,
  JOB_LIST_DEFAULT_LIMIT,
  JOB_LIST_MAX_LIMIT,
  JOB_NAME_HEADER,
  parseJobIntakeConfig,
  sanitizeJobName,
} from '../src/job-intake-routes.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import type { SiteMembershipLookup } from '../src/site-scope.js';
import { fakeClock, sequentialIds, TICKET, type FakeClock } from './helpers.js';

const ADMIN: Actor = { id: 'admin-1', role: 'admin' };
const VIEWER: Actor = { id: 'viewer-1', role: 'viewer' };
/** An operator of the north site only. */
const NORTH_OPERATOR: Actor = { id: 'north-1', role: 'operator' };
const NORTH_ONLY: SiteMembership = { userId: NORTH_OPERATOR.id, siteIds: ['north'] };
const memberships: SiteMembershipLookup = (actor) => {
  if (actor.id === ADMIN.id) return localAdminMembership(ADMIN.id);
  return actor.id === NORTH_OPERATOR.id ? NORTH_ONLY : undefined;
};

const PDF = Buffer.from('%PDF-1.7\n% intake test\n', 'latin1');

interface HarnessOptions {
  readonly intake?: boolean;
  readonly maxBytes?: number;
  readonly actor?: Actor;
  readonly siteScoped?: boolean;
  readonly authenticate?: () => Actor;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
  readonly repository: MemoryJobRepository;
  readonly intakeDir: string;
  readonly time: FakeClock;
}

interface JobBody {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly ticket: { readonly siteId?: string };
  readonly metadata: Readonly<Record<string, string>>;
  readonly sourceFiles: readonly { readonly name: string }[];
}

interface PageBody {
  readonly items: readonly JobBody[];
  readonly nextCursor: string | null;
}

/** The files in `dir`; none when it was never created. */
async function filesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

describe('job intake routes (Spec 052a)', () => {
  const apps: FastifyInstance[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A server with the media routes, so `GET /openapi.json` is mounted too. */
  async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
    const dataDir = await mkdtemp(join(tmpdir(), 'bps-052a-'));
    dirs.push(dataDir);
    const intakeDir = join(dataDir, 'intake');
    const time = fakeClock('2026-03-01T08:00:00.000Z');
    const outbox = new MemoryOutbox();
    const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
    const repository = new MemoryJobRepository();
    const blobs = new MemoryStorage();
    const jobs = new JobService({ jobs: repository, blobs, bus, clock: time.clock, newId: sequentialIds('job') });
    const archive = new ArchiveService({
      jobs: repository,
      index: new MemoryArchiveIndex(),
      blobs,
      archive: new MemoryStorage(),
      bus,
      outbox,
      colorSetups: new StaticColorSetupResolver(),
      clock: time.clock,
      newId: sequentialIds('pkg'),
    });
    const media = new MediaService({ stores: memoryMediaStores(), bus, jobs: repository, clock: time.clock, newId: sequentialIds('m') });
    const { actor, intake = true, siteScoped = false, maxBytes = DEFAULT_JOB_INTAKE_MAX_BYTES } = options;
    const authenticate = options.authenticate ?? (actor ? () => actor : undefined);
    const app = buildServer({
      archive,
      media,
      jobs: repository,
      ...(intake
        ? { jobIntake: { jobs: repository, service: jobs, intakeDir, maxBytes, newFileId: sequentialIds('upload') } }
        : {}),
      ...(siteScoped ? { siteScope: { memberships, jobs: repository } } : {}),
      ...(authenticate ? { authenticate } : {}),
    });
    apps.push(app);
    return { app, jobs, repository, intakeDir, time };
  }

  function upload(harness: Harness, payload: Buffer | string, headers: Record<string, string> = {}, query = '') {
    return harness.app.inject({
      method: 'POST',
      url: `/jobs${query}`,
      headers: { 'content-type': 'application/pdf', ...headers },
      payload,
    });
  }

  async function createJob(harness: Harness, siteId?: string): Promise<string> {
    const ticket = siteId === undefined ? TICKET : { ...TICKET, siteId };
    const job = await harness.jobs.create({ name: 'Banner', sources: [{ name: 'banner.pdf', bytes: PDF }], ticket });
    harness.time.advance(1000);
    return job.id;
  }

  describe('configuration', () => {
    it('is off without BPS_JOB_INTAKE and on with 1 at the default cap', () => {
      expect(parseJobIntakeConfig({})).toBeUndefined();
      expect(parseJobIntakeConfig({ BPS_JOB_INTAKE: '1' })).toEqual({ maxBytes: 256 * 1024 * 1024 });
    });

    it.each(['0', 'true', 'yes', '', ' 1'])('stops startup for BPS_JOB_INTAKE=%j', (value) => {
      expect(() => parseJobIntakeConfig({ BPS_JOB_INTAKE: value })).toThrow(/BPS_JOB_INTAKE must be 1 or unset/);
    });

    it('lowers the cap with BPS_JOB_INTAKE_MAX_BYTES', () => {
      expect(parseJobIntakeConfig({ BPS_JOB_INTAKE: '1', BPS_JOB_INTAKE_MAX_BYTES: '1048576' })).toEqual({ maxBytes: 1048576 });
      expect(parseJobIntakeConfig({ BPS_JOB_INTAKE: '1', BPS_JOB_INTAKE_MAX_BYTES: String(DEFAULT_JOB_INTAKE_MAX_BYTES) })).toEqual({
        maxBytes: DEFAULT_JOB_INTAKE_MAX_BYTES,
      });
    });

    it.each([String(DEFAULT_JOB_INTAKE_MAX_BYTES + 1), '0', '-1', '1e6', '12abc', '', ' 100'])(
      'stops startup for BPS_JOB_INTAKE_MAX_BYTES=%j, with the flag on or off',
      (value) => {
        expect(() => parseJobIntakeConfig({ BPS_JOB_INTAKE: '1', BPS_JOB_INTAKE_MAX_BYTES: value })).toThrow(/BPS_JOB_INTAKE_MAX_BYTES/);
        expect(() => parseJobIntakeConfig({ BPS_JOB_INTAKE_MAX_BYTES: value })).toThrow(/BPS_JOB_INTAKE_MAX_BYTES/);
      },
    );

    it('keeps only a clean last path segment of the display name', () => {
      expect(sanitizeJobName('C:\\Users\\me\\..\\Banner.pdf')).toBe('Banner.pdf');
      expect(sanitizeJobName('../../etc/passwd')).toBe('passwd');
      expect(sanitizeJobName('  Poster\u0000\u200b A1  ')).toBe('Poster A1');
      expect(sanitizeJobName('x'.repeat(500))).toHaveLength(200);
      expect(sanitizeJobName('..')).toBeUndefined();
      expect(sanitizeJobName('a/')).toBeUndefined();
      expect(sanitizeJobName(['a', 'b'])).toBeUndefined();
      expect(sanitizeJobName(undefined)).toBeUndefined();
    });
  });

  describe('with the flag off', () => {
    it('mounts none of the intake routes', async () => {
      const harness = await createHarness({ intake: false });
      const jobId = await createJob(harness);

      expect((await upload(harness, PDF)).statusCode).toBe(404);
      expect((await harness.app.inject({ method: 'GET', url: '/jobs' })).statusCode).toBe(404);
      expect((await harness.app.inject({ method: 'GET', url: `/jobs/${jobId}` })).statusCode).toBe(404);
      expect(await filesIn(harness.intakeDir)).toEqual([]);
      expect(await harness.repository.list()).toHaveLength(1);
    });

    it('leaves the existing job routes as they were', async () => {
      const harness = await createHarness({ intake: false });
      const jobId = await createJob(harness);

      const history = await harness.app.inject({ method: 'GET', url: `/jobs/${jobId}/history` });
      const trash = await harness.app.inject({ method: 'GET', url: '/trash' });

      expect(history.statusCode).toBe(200);
      expect(trash.json()).toEqual({ items: [] });
    });
  });

  describe('GET /health', () => {
    it('answers ok without a caller, with or without the intake flag', async () => {
      for (const intake of [false, true]) {
        const harness = await createHarness({
          intake,
          authenticate: () => {
            throw new Error('GET /health must not resolve a caller');
          },
        });

        const response = await harness.app.inject({ method: 'GET', url: '/health' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: 'ok' });
      }
    });
  });

  describe('POST /jobs', () => {
    it('stores the upload under a server-generated name and creates the job', async () => {
      const harness = await createHarness();

      const response = await upload(harness, PDF, { [JOB_NAME_HEADER]: 'C:\\Users\\me\\..\\Banner.pdf' });

      expect(response.statusCode).toBe(201);
      const { job } = response.json<{ job: JobBody }>();
      expect(job).toMatchObject({
        name: 'Banner.pdf',
        status: 'received',
        metadata: { intakeFile: 'upload-0001.pdf', displayName: 'Banner.pdf' },
      });
      expect(job.sourceFiles.map((file) => file.name)).toEqual(['upload-0001.pdf']);
      expect(await filesIn(harness.intakeDir)).toEqual(['upload-0001.pdf']);
      expect(await readFile(join(harness.intakeDir, 'upload-0001.pdf'))).toEqual(PDF);
      expect(await harness.repository.get(job.id)).toMatchObject({ id: job.id, status: 'received' });
    });

    it('names the job after the stored file without a display name', async () => {
      const harness = await createHarness();

      const response = await upload(harness, PDF);

      const { job } = response.json<{ job: JobBody }>();
      expect(job.name).toBe('upload-0001.pdf');
      expect(job.metadata).toEqual({ intakeFile: 'upload-0001.pdf' });
    });

    it('answers 413 for an upload above the cap and writes nothing', async () => {
      const harness = await createHarness({ maxBytes: 64 });
      const payload = Buffer.concat([PDF, Buffer.alloc(64)]);

      const response = await upload(harness, payload);

      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({
        error: { code: 'upload_too_large', message: 'The upload is larger than 64 bytes', details: { maxBytes: 64 } },
      });
      expect(await filesIn(harness.intakeDir)).toEqual([]);
      expect(await harness.repository.list()).toEqual([]);
    });

    it('takes an upload of exactly the cap', async () => {
      const harness = await createHarness({ maxBytes: PDF.byteLength });

      expect((await upload(harness, PDF)).statusCode).toBe(201);
    });

    it.each([
      ['plain text', Buffer.from('hello, not a pdf')],
      ['a lowercase header', Buffer.from('%pdf-1.7')],
      ['a truncated header', Buffer.from('%PDF')],
      ['an empty body', Buffer.alloc(0)],
    ])('answers 400 upload_not_pdf for %s and writes nothing', async (_name, payload) => {
      const harness = await createHarness();

      const response = await upload(harness, payload);

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('upload_not_pdf');
      expect(await filesIn(harness.intakeDir)).toEqual([]);
      expect(await harness.repository.list()).toEqual([]);
    });

    it('answers 415 for a body that is not application/pdf', async () => {
      const harness = await createHarness();

      const response = await harness.app.inject({
        method: 'POST',
        url: '/jobs',
        headers: { 'content-type': 'text/plain' },
        payload: PDF.toString('latin1'),
      });

      expect(response.statusCode).toBe(415);
      expect(await filesIn(harness.intakeDir)).toEqual([]);
    });

    it('answers 403 to a caller without jobs:write and writes nothing', async () => {
      const harness = await createHarness({ actor: VIEWER });

      const response = await upload(harness, PDF);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'forbidden', details: { permission: 'jobs:write' } } });
      expect(await filesIn(harness.intakeDir)).toEqual([]);
    });

    it("refuses a site the caller's membership does not grant and writes nothing", async () => {
      const harness = await createHarness({ actor: NORTH_OPERATOR, siteScoped: true });

      const denied = await upload(harness, PDF, {}, '?siteId=south');
      const allowed = await upload(harness, PDF, {}, '?siteId=north');

      expect(denied.statusCode).toBe(403);
      expect(denied.json<{ error: { code: string } }>().error.code).toBe('site_not_granted');
      expect(allowed.statusCode).toBe(201);
      expect(allowed.json<{ job: JobBody }>().job.ticket.siteId).toBe('north');
      expect(await filesIn(harness.intakeDir)).toEqual(['upload-0001.pdf']);
    });
  });

  describe('GET /jobs', () => {
    it('pages the active jobs newest first with a cursor', async () => {
      const harness = await createHarness();
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(await createJob(harness));
      const newest = [...ids].reverse();

      const first = (await harness.app.inject({ method: 'GET', url: '/jobs?limit=2' })).json<PageBody>();
      expect(first.items.map((job) => job.id)).toEqual(newest.slice(0, 2));
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = (
        await harness.app.inject({ method: 'GET', url: `/jobs?limit=2&cursor=${String(first.nextCursor)}` })
      ).json<PageBody>();
      expect(second.items.map((job) => job.id)).toEqual(newest.slice(2, 4));

      const last = (
        await harness.app.inject({ method: 'GET', url: `/jobs?limit=2&cursor=${String(second.nextCursor)}` })
      ).json<PageBody>();
      expect(last.items.map((job) => job.id)).toEqual(newest.slice(4));
      expect(last.nextCursor).toBeNull();
    });

    it('defaults to 50 jobs and caps the page at 200', async () => {
      const harness = await createHarness();
      for (let i = 0; i < JOB_LIST_MAX_LIMIT + 5; i += 1) await createJob(harness);

      const byDefault = (await harness.app.inject({ method: 'GET', url: '/jobs' })).json<PageBody>();
      const capped = (await harness.app.inject({ method: 'GET', url: '/jobs?limit=1000' })).json<PageBody>();

      expect(byDefault.items).toHaveLength(JOB_LIST_DEFAULT_LIMIT);
      expect(capped.items).toHaveLength(JOB_LIST_MAX_LIMIT);
      expect(capped.nextCursor).toEqual(expect.any(String));
    });

    it.each(['/jobs?limit=0', '/jobs?limit=-3', '/jobs?limit=abc', '/jobs?cursor=not-a-cursor'])('answers 400 for %s', async (url) => {
      const harness = await createHarness();

      expect((await harness.app.inject({ method: 'GET', url })).statusCode).toBe(400);
    });

    it("lists only the jobs of the caller's sites", async () => {
      const harness = await createHarness({ siteScoped: true, authenticate: () => NORTH_OPERATOR });
      const north = await createJob(harness, 'north');
      await createJob(harness, 'south');
      await createJob(harness);

      const page = (await harness.app.inject({ method: 'GET', url: '/jobs' })).json<PageBody>();

      expect(page.items.map((job) => job.id)).toEqual([north]);
      expect(page.nextCursor).toBeNull();
    });

    it('does not count hidden jobs towards the page', async () => {
      const harness = await createHarness({ siteScoped: true, authenticate: () => NORTH_OPERATOR });
      const north = [await createJob(harness, 'north'), await createJob(harness, 'north')];
      await createJob(harness, 'south');
      await createJob(harness, 'south');

      const first = (await harness.app.inject({ method: 'GET', url: '/jobs?limit=1' })).json<PageBody>();
      const second = (
        await harness.app.inject({ method: 'GET', url: `/jobs?limit=1&cursor=${String(first.nextCursor)}` })
      ).json<PageBody>();

      expect(first.items.map((job) => job.id)).toEqual([north[1]]);
      expect(second.items.map((job) => job.id)).toEqual([north[0]]);
      expect(second.nextCursor).toBeNull();
    });
  });

  describe('GET /jobs/:id', () => {
    it('reads one job', async () => {
      const harness = await createHarness();
      const jobId = await createJob(harness);

      const response = await harness.app.inject({ method: 'GET', url: `/jobs/${jobId}` });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ job: JobBody }>().job.id).toBe(jobId);
    });

    it("answers a missing job and another site's job with the same 404", async () => {
      const harness = await createHarness({ siteScoped: true, authenticate: () => NORTH_OPERATOR });
      const south = await createJob(harness, 'south');
      const missing = 'job-9999';
      const masked = (body: string, id: string): string => body.split(id).join('<id>');

      const outOfScope = await harness.app.inject({ method: 'GET', url: `/jobs/${south}` });
      const absent = await harness.app.inject({ method: 'GET', url: `/jobs/${missing}` });

      expect(outOfScope.statusCode).toBe(404);
      expect(absent.statusCode).toBe(outOfScope.statusCode);
      expect(absent.headers['content-type']).toBe(outOfScope.headers['content-type']);
      expect(masked(absent.body, missing)).toBe(masked(outOfScope.body, south));
      expect(outOfScope.json()).toEqual({ error: { code: 'not_found', message: `Job ${south} not found` } });
    });

    it('answers the same 404 for a missing job to an all-sites caller and without site scoping', async () => {
      const scoped = await createHarness({ siteScoped: true, authenticate: () => ADMIN });
      const unscoped = await createHarness();

      for (const harness of [scoped, unscoped]) {
        const response = await harness.app.inject({ method: 'GET', url: '/jobs/job-9999' });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Job job-9999 not found' } });
      }
    });
  });

  it('documents the intake routes and the health check in the OpenAPI document', async () => {
    const harness = await createHarness();

    const response = await harness.app.inject({ method: 'GET', url: '/openapi.json' });

    const { paths } = response.json<{ paths: Record<string, Record<string, { operationId?: string }>> }>();
    expect(paths['/jobs']?.post?.operationId).toBe('createJob');
    expect(paths['/jobs']?.get?.operationId).toBe('listJobs');
    expect(paths['/jobs/{id}']?.get?.operationId).toBe('getJob');
    expect(paths['/health']?.get?.operationId).toBe('getHealth');
  });
});
