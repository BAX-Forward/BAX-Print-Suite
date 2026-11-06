import type { FastifyInstance } from 'fastify';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import type { Actor, Clock, JobTicket, Role } from '@bax-print/core';
import { EventBus, MemoryOutbox, type Outbox } from '@bax-print/events';
import { MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';

export const DEVICE_A = 'printer-a';
export const MEDIUM_GLOSS = 'vinyl-gloss';
export const MEDIUM_MATTE = 'vinyl-matte';
export const ROLE_HEADER = 'x-test-role';

export const TICKET: JobTicket = {
  intent: { quantity: 3, finishedSize: { widthMm: 300, heightMm: 150 } },
  process: { layout: { marginMm: 5, gapMm: 3 } },
};

export interface FakeClock {
  readonly clock: Clock;
  advance(ms: number): void;
}

export function fakeClock(startIso: string): FakeClock {
  let now = Date.parse(startIso);
  return {
    clock: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
  };
}

export function sequentialIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, '0')}`;
}

export interface ServerHarness {
  readonly app: FastifyInstance;
  readonly jobs: JobService;
  readonly archive: ArchiveService;
  readonly repository: MemoryJobRepository;
  readonly index: MemoryArchiveIndex;
  readonly blobs: MemoryStorage;
  readonly packages: MemoryStorage;
  /** Typed as the interface so the append-only `update`/`delete` guards can be called. */
  readonly outbox: Outbox;
  readonly colorSetups: StaticColorSetupResolver;
  readonly time: FakeClock;
}

/** Job service, archive service and HTTP app sharing one set of in-memory stores and a fake clock. */
export function createServerHarness(start = '2026-03-01T08:00:00.000Z'): ServerHarness {
  const time = fakeClock(start);
  const outbox = new MemoryOutbox();
  const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
  const repository = new MemoryJobRepository();
  const index = new MemoryArchiveIndex();
  const blobs = new MemoryStorage();
  const packages = new MemoryStorage();
  const colorSetups = new StaticColorSetupResolver();
  const newId = sequentialIds('job');

  const jobs = new JobService({ jobs: repository, blobs, bus, clock: time.clock, newId });
  const archive = new ArchiveService({
    jobs: repository,
    index,
    blobs,
    archive: packages,
    bus,
    outbox,
    colorSetups,
    clock: time.clock,
    newId,
  });
  const app = buildServer({
    archive,
    authenticate: (request): Actor => {
      const role = request.headers[ROLE_HEADER];
      return { id: 'tester', role: typeof role === 'string' ? (role as Role) : 'admin' };
    },
  });
  return { app, jobs, archive, repository, index, blobs, packages, outbox, colorSetups, time };
}

/** Drives a job through the print status machine to `done`. */
export async function finishedJob(
  h: Pick<ServerHarness, 'jobs'>,
  fields: { name: string; customerRef?: string; deviceId?: string; mediumId?: string; colorSetupRevisionId?: string; tags?: string[] },
): Promise<string> {
  const job = await h.jobs.create({
    ...fields,
    sources: [{ name: `${fields.name}.pdf`, bytes: Buffer.from(`%PDF-1.7 ${fields.name}`) }],
    ticket: TICKET,
  });
  await finish(h.jobs, job.id);
  return job.id;
}

/** Walks a new job through every status to `done`, so it may be archived or trashed. */
export async function finish(jobs: Pick<JobService, 'setStatus'>, jobId: string): Promise<void> {
  for (const status of ['inspecting', 'ready', 'queued', 'processing', 'sent_to_device', 'printed', 'done'] as const) {
    await jobs.setStatus(jobId, status);
  }
}
