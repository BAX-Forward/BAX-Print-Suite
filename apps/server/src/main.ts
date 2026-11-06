import { join, resolve } from 'node:path';
import { ArchiveService, parseDuration, StaticColorSetupResolver } from '@bax-print/archive';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { BuiltinInspector, builtinRegistry } from '@bax-print/inspect';
import {
  LocalDirStorage,
  MemoryArchiveIndex,
  MemoryJobRepository,
  SqliteApiTokenRepository,
  SqliteFinishingPlanRepository,
  SqliteLayoutTemplateRepository,
} from '@bax-print/store';
import { configureApiTokens } from './api-token-config.js';
import { buildServer, isLoopbackHost, localAdminWarning, type ServerDeps } from './app.js';
import { JobService } from './jobs.js';
import { MediaService } from './media-service.js';
import { memoryMediaStores } from './media-stores.js';
import { createPdfCutExtractor } from './pdf-cut-extractor.js';
import { PreflightService } from './preflight-service.js';
import { ProfileService } from './profiles.js';
import { configureRollCut } from './roll-cut-config.js';
import { startArchiveScheduler } from './scheduler.js';
import { configureLogin, parseSessionConfig } from './session-config.js';
import { MemoryFindingsStore, MemoryProfileStore } from './stores.js';
import { openWebhookPersistence } from './webhook-persistence.js';
import { ALLOW_LAN_TARGETS_ENV, parseAllowLanTargets } from './webhook-routes.js';

// Spec 028d: parsed first, so a bad BPS_LOGIN or BPS_COOKIE stops the server before it opens anything.
const sessionConfig = parseSessionConfig(process.env);
const dataDir = resolve(process.env.BPS_DATA_DIR ?? 'data');
const host = process.env.BPS_HOST ?? '127.0.0.1';
const port = Number(process.env.BPS_PORT ?? 8080);
const archiveAfter = process.env.BPS_ARCHIVE_AFTER;
const retention = process.env.BPS_TRASH_RETENTION;
const blobsDir = join(dataDir, 'blobs');
const allowLanTargets = parseAllowLanTargets(process.env[ALLOW_LAN_TARGETS_ENV]);
// Spec 019c: a SQLite job database (BPS_DATABASE) keeps webhook subscriptions across restarts.
// Spec 019d: the file is mode 0600 and secrets are sealed when a secrets key is configured.
const { store: webhookStore, database, warnings: persistenceWarnings } = openWebhookPersistence(process.env);

// Job rows, the archive index, the outbox, findings, profiles and media are in memory until the SQLite store (Spec 001) lands.
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

// Storage keys are validated `/`-separated paths below the blob root (Storage/1).
const blobPath = (storageKey: string): string => resolve(blobsDir, ...storageKey.split('/'));

const registry = builtinRegistry();
const profiles = new ProfileService(new MemoryProfileStore(), registry);
const preflight = new PreflightService({
  jobs: jobRepository,
  findings: new MemoryFindingsStore(),
  profiles,
  events: new JobService({ jobs: jobRepository, blobs, bus }),
  inspector: new BuiltinInspector({ registry }),
  blobPath,
  spoolDir: join(dataDir, 'spool'),
});
// Spec 007h: cut jobs are planned from the page boxes of the job's source PDF. Without a
// `cutContour` edit the `CutContour` spot colorant is cut (Spec 004 default).
// Spec 003y: with BPS_ROLL_CUT on, a stepped-and-repeated job's cut job is planned on the roll.
const rollCut = configureRollCut(process.env, createPdfCutExtractor({ blobPath, cut: { spotNames: ['CutContour'] } }));
const media = new MediaService({ stores: memoryMediaStores(), bus, jobs: jobRepository });
// Spec 029c: bearer API tokens only with BPS_DATABASE and BPS_API_TOKENS=1; an invalid flag stops startup.
const apiTokens = configureApiTokens(process.env, database ? new SqliteApiTokenRepository(database) : undefined).enabled;

// Without API tokens or BPS_LOGIN there is no `authenticate`: every caller is the local admin, which
// is safe on loopback only (Spec 024b). With BPS_LOGIN=1 every guarded route needs a session (Spec 028d).
const login = configureLogin(sessionConfig, database);
// Spec 028d: API tokens and login each bring their own actor resolver; combining them is a follow-up.
if (apiTokens && login.authenticate) {
  throw new Error('BPS_API_TOKENS=1 and BPS_LOGIN=1 cannot be combined yet; enable one of them');
}
const serverDeps: ServerDeps = {
  archive,
  preflight: { preflight, profiles, registry },
  media,
  webhooks: { bus, store: webhookStore, allowLanTargets },
  jobs: jobRepository,
  cutExtractor: rollCut.cutExtractor,
  // Spec 003u: step and repeat reads the same stored source PDF as the cut extractor.
  stepRepeat: { blobPath, ...rollCut.stepRepeat },
  // Spec 004a: the proof watermark reads the same stored source PDF.
  proof: { blobPath },
  // Spec 003x: saved layout templates live in the job database, so the routes need BPS_DATABASE.
  ...(database ? { layoutTemplates: new SqliteLayoutTemplateRepository(database) } : {}),
  // Spec 004d: finishing plans live in the job database too.
  ...(database ? { finishing: { plans: new SqliteFinishingPlanRepository(database) } } : {}),
  // Spec 023b: the production report is mounted with BPS_DATABASE too; it reads the job rows above.
  ...(database ? { productionReport: { jobs: jobRepository } } : {}),
  // Spec 017d: the accounting ID is kept on the job rows above, so it needs no BPS_DATABASE. Device
  // accounting reports are only published as history events, so `GET /reports/accounting` is not mounted.
  accounting: { jobs: jobRepository },
  ...(apiTokens ? { apiTokens: apiTokens.apiTokens, authenticate: apiTokens.authenticate } : {}),
  ...login,
  logger: true,
};
const app = buildServer(serverDeps);
const scheduler = startArchiveScheduler(archive, { onError: (error) => app.log.error(error) });

const shutdown = (): void => {
  scheduler.stop();
  void app.close().finally(() => database?.close());
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

for (const warning of persistenceWarnings) {
  app.log.warn(warning);
}
const localAdmin = localAdminWarning(serverDeps, host);
if (localAdmin !== undefined) app.log.warn(localAdmin);
if (apiTokens?.fallback === 'local-admin' && !isLoopbackHost(host)) {
  app.log.warn(`BPS_HOST ${host} is not a loopback address: callers without an API token are treated as the local admin (set BPS_AUTH_FALLBACK=deny)`);
}
app.log.warn(
  database
    ? 'job rows, archive index, history, findings, profiles and media are kept in memory in this build'
    : 'job rows, archive index, history, findings, profiles, media and webhook subscriptions are kept in memory in this build (set BPS_DATABASE to persist webhook subscriptions)',
);
await app.listen({ host, port });
