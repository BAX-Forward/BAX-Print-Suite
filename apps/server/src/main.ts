import { join, resolve } from 'node:path';
import { ArchiveService, parseDuration, StaticColorSetupResolver } from '@bax-print/archive';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository } from '@bax-print/store';
import { buildServer } from './app.js';
import { startArchiveScheduler } from './scheduler.js';

const dataDir = resolve(process.env.BPS_DATA_DIR ?? 'data');
const host = process.env.BPS_HOST ?? '127.0.0.1';
const port = Number(process.env.BPS_PORT ?? 8080);
const archiveAfter = process.env.BPS_ARCHIVE_AFTER;
const retention = process.env.BPS_TRASH_RETENTION;

// Job rows, the archive index and the outbox are in memory until the SQLite store (Spec 001) lands.
const outbox = new MemoryOutbox();
const bus = new EventBus(outbox);
const archive = new ArchiveService({
  jobs: new MemoryJobRepository(),
  index: new MemoryArchiveIndex(),
  blobs: new LocalDirStorage(join(dataDir, 'blobs')),
  archive: new LocalDirStorage(join(dataDir, 'archive')),
  bus,
  outbox,
  colorSetups: new StaticColorSetupResolver(),
  rules: archiveAfter ? [{ archiveAfterMs: parseDuration(archiveAfter) }] : [],
  retentionMs: retention ? parseDuration(retention) : undefined,
});

const app = buildServer({ archive, logger: true });
const scheduler = startArchiveScheduler(archive, { onError: (error) => app.log.error(error) });

const shutdown = (): void => {
  scheduler.stop();
  void app.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

app.log.warn('job rows, archive index and history are kept in memory in this build');
await app.listen({ host, port });
