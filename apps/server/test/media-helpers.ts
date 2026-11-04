import type { FastifyInstance } from 'fastify';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { vi } from 'vitest';
import { JobService } from '../src/jobs.js';
import { buildMediaServer } from '../src/media-routes.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { fakeClock, sequentialIds, type FakeClock } from './helpers.js';

export interface MediaHarness {
  readonly app: FastifyInstance;
  readonly media: MediaService;
  readonly jobs: JobService;
  readonly repository: MemoryJobRepository;
  readonly time: FakeClock;
  /** The events published on the shared bus, in order. */
  published(type?: string): { type: string; subject: string; data: unknown }[];
}

/** Media service, job service and the in-process Spec 005 app sharing one bus and one job store. */
export function createMediaHarness(start = '2026-11-04T09:00:00.000Z'): MediaHarness {
  const time = fakeClock(start);
  const bus = new EventBus(new MemoryOutbox(), { clock: time.clock, newId: sequentialIds('evt') });
  const publish = vi.spyOn(bus, 'publish');
  const repository = new MemoryJobRepository();
  const jobs = new JobService({ jobs: repository, blobs: new MemoryStorage(), bus, clock: time.clock, newId: sequentialIds('job') });
  const media = new MediaService({ stores: memoryMediaStores(), bus, jobs: repository, clock: time.clock, newId: sequentialIds('m') });
  const app = buildMediaServer({ media });
  return {
    app,
    media,
    jobs,
    repository,
    time,
    published: (type) =>
      publish.mock.calls
        .map(([event]) => event as { type: string; subject: string; data: unknown })
        .filter((event) => type === undefined || event.type === type),
  };
}
