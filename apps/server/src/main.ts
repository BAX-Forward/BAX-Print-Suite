import { join, resolve } from 'node:path';
import { ArchiveService, parseDuration, StaticColorSetupResolver } from '@bax-print/archive';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { BuiltinInspector, builtinRegistry } from '@bax-print/inspect';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository } from '@bax-print/store';
import { buildServer } from './app.js';
import { JobService } from './jobs.js';
import { MediaService } from './media-service.js';
import { memoryMediaStores } from './media-stores.js';
import { PreflightService } from './preflight-service.js';
import { ProfileService } from './profiles.js';
import { startArchiveScheduler } from './scheduler.js';
import { MemoryFindingsStore, MemoryProfileStore } from './stores.js';

const dataDir = resolve(process.env.BPS_DATA_DIR ?? 'data');
const host = process.env.BPS_HOST ?? '127.0.0.1';
const port = Number(process.env.BPS_PORT ?? 8080);
const archiveAfter = process.env.BPS_ARCHIVE_AFTER;
const retention = process.env.BPS_TRASH_RETENTION;
const blobsDir = join(dataDir, 'blobs');

// Job rows, the archive index, the outbox, findings, profiles, media and webhook subscriptions are in memory until the SQLite store (Spec 001) lands.
const outbox = new MemoryOutbox();
const bus = new EventBus(outbox);
const jobRepository = new MemoryJobRepository();
const blobs = new LocalDirStorage(blobsDir);
const archive = new ArchiveService({
  jobs: jobRepository,
  index: new MemoryArchiveIndex(),
  blobs,
  archive: new LocalDirStorage(join(dataDir, 'archive')),
  bus,
  outbox,
  colorSetups: new StaticColorSetupResolver(),
  rules: archiveAfter ? [{ archiveAfterMs: parseDuration(archiveAfter) }] : [],
  retentionMs: retention ? parseDuration(retention) : undefined,
});

const registry = builtinRegistry();
const profiles = new ProfileService(new MemoryProfileStore(), registry);
const preflight = new PreflightService({
  jobs: jobRepository,
  findings: new MemoryFindingsStore(),
  profiles,
  events: new JobService({ jobs: jobRepository, blobs, bus }),
  inspector: new BuiltinInspector({ registry }),
  // Storage keys are validated `/`-separated paths below the blob root (Storage/1).
  blobPath: (storageKey) => resolve(blobsDir, ...storageKey.split('/')),
  spoolDir: join(dataDir, 'spool'),
});
const media = new MediaService({ stores: memoryMediaStores(), bus, jobs: jobRepository });

const app = buildServer({ archive, preflight: { preflight, profiles, registry }, media, webhooks: { bus }, logger: true });
const scheduler = startArchiveScheduler(archive, { onError: (error) => app.log.error(error) });

const shutdown = (): void => {
  scheduler.stop();
  void app.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

app.log.warn('job rows, archive index, history, findings, profiles, media and webhook subscriptions are kept in memory in this build');
await app.listen({ host, port });
