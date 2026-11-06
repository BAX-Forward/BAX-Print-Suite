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
  SqliteSiteRepository,
} from '@bax-print/store';
import { configureApiTokens } from './api-token-config.js';
import { buildServer, isLoopbackHost, localAdminWarning, type ServerDeps } from './app.js';
import { DATABASE_URL_ENV, parseDatabaseUrl, redactDatabaseUrl } from './database-url.js';
import { IMPOSITION_ENV, parseImpositionFlag } from './imposition-routes.js';
import { JobService } from './jobs.js';
import { MediaService } from './media-service.js';
import { memoryMediaStores } from './media-stores.js';
import { createPdfCutExtractor } from './pdf-cut-extractor.js';
import { PreflightService } from './preflight-service.js';
import { parsePrintAutoRouteFlag, PRINT_AUTO_ROUTE_ENV } from './print-auto-route.js';
import { configurePrintOutput, PRINT_OUTPUT_ENV, PRINTER_PLUGIN_ENV } from './print-output.js';
import { ProfileService } from './profiles.js';
import { configureRollCut } from './roll-cut-config.js';
import { startArchiveScheduler } from './scheduler.js';
import { configureLogin, parseSessionConfig } from './session-config.js';
import { configureSiteScope } from './site-scope.js';
import { MemoryFindingsStore, MemoryProfileStore } from './stores.js';
import { INK_LIMIT_ENV, parseInkLimitFlag } from './ink-limit-routes.js';
import { parseScreeningFlag, SCREENING_ENV } from './screening-routes.js';
import { parseSwatchChartsFlag } from './swatch-chart-routes.js';
import { loadHttpsOptions } from './tls.js';
import { openWebhookPersistence } from './webhook-persistence.js';
import { ALLOW_LAN_TARGETS_ENV, parseAllowLanTargets } from './webhook-routes.js';
import { parseWhiteInkFlag, WHITE_INK_ENV } from './white-ink-routes.js';

// Spec 028d: parsed first, so a bad BPS_LOGIN or BPS_COOKIE stops the server before it opens anything.
const sessionConfig = parseSessionConfig(process.env);
// Spec 027d: BPS_DATABASE_URL is parsed only; a bad value stops startup, a good one is not connected to.
const databaseUrl = parseDatabaseUrl(process.env);
const dataDir = resolve(process.env.BPS_DATA_DIR ?? 'data');
const host = process.env.BPS_HOST ?? '127.0.0.1';
const port = Number(process.env.BPS_PORT ?? 8080);
const archiveAfter = process.env.BPS_ARCHIVE_AFTER;
const retention = process.env.BPS_TRASH_RETENTION;
const blobsDir = join(dataDir, 'blobs');
const allowLanTargets = parseAllowLanTargets(process.env[ALLOW_LAN_TARGETS_ENV]);
// Spec 029d: BPS_TLS_CERT with BPS_TLS_KEY serves HTTPS; a lone one or an unreadable file stops startup.
const https = loadHttpsOptions(process.env);
// Spec 032b: POST /swatch-charts only with BPS_SWATCH_CHARTS=1; any other value stops startup.
const swatchCharts = parseSwatchChartsFlag(process.env);
// Spec 036b: POST /imposition/n-up and /imposition/booklet only with BPS_IMPOSITION=1; any other value stops startup.
const imposition = parseImpositionFlag(process.env);
// Spec 038c: PUT and DELETE /jobs/:id/white-ink only with BPS_WHITE_INK=1; any other value stops startup.
const whiteInk = parseWhiteInkFlag(process.env);
// Spec 039c: PUT and DELETE /jobs/:id/screening only with BPS_SCREENING=1; any other value stops startup.
const screening = parseScreeningFlag(process.env);
// Spec 040c: PUT and DELETE /jobs/:id/ink-limit only with BPS_INK_LIMIT=1; any other value stops startup.
const inkLimit = parseInkLimitFlag(process.env);
// Spec 034a: print output only with BPS_PRINT_OUTPUT=1 and BPS_PRINTER_PLUGIN; any other flag value, a missing,
// relative or absent manifest or a bad BPS_PRINTER_SETTINGS stops startup. The plugin is started on first use, never here.
const printOutput = configurePrintOutput(process.env, { spoolDir: join(dataDir, 'spool', 'print-output') });
// Spec 034b: ready jobs are sent to the print output only with BPS_PRINT_AUTO_ROUTE=1, which needs BPS_PRINT_OUTPUT=1;
// any other value stops startup.
const printAutoRoute = parsePrintAutoRouteFlag(process.env);
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
const jobService = new JobService({ jobs: jobRepository, blobs, bus });
const preflight = new PreflightService({
  jobs: jobRepository,
  findings: new MemoryFindingsStore(),
  profiles,
  events: jobService,
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
// Spec 030c: site scoping only with BPS_DATABASE and BPS_SITE_SCOPE=1; an invalid flag stops startup.
const siteScope = configureSiteScope(process.env, database ? new SqliteSiteRepository(database) : undefined, jobRepository);

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
  // Spec 034a: the print output reads the same stored source PDF.
  // Spec 034b: automatic routing records a failed submission as a failed step in the job history.
  ...(printOutput
    ? {
        printOutput: {
          output: printOutput.output,
          blobPath,
          ...(printAutoRoute ? { autoRoute: { bus, history: jobService } } : {}),
        },
      }
    : {}),
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
  ...(siteScope ? { siteScope } : {}),
  ...(swatchCharts ? { swatchCharts } : {}),
  ...(imposition ? { imposition } : {}),
  ...(whiteInk ? { whiteInk: { jobs: jobRepository } } : {}),
  ...(screening ? { screening: { jobs: jobRepository } } : {}),
  ...(inkLimit ? { inkLimit: { jobs: jobRepository } } : {}),
  logger: true,
  ...(https === undefined ? {} : { https }),
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
const databaseUrlValue = process.env[DATABASE_URL_ENV];
if (databaseUrl && databaseUrlValue) {
  app.log.warn(`${DATABASE_URL_ENV} ${redactDatabaseUrl(databaseUrlValue)} is parsed but not used in this build: no Postgres connection is made`);
}
if (printOutput) {
  // The settings may hold secrets, so only the manifest path is logged.
  app.log.info(`print output is on (${PRINT_OUTPUT_ENV}=1): ${PRINTER_PLUGIN_ENV} ${printOutput.config.manifestPath}`);
  app.log.info(
    printAutoRoute
      ? `print auto-route is on (${PRINT_AUTO_ROUTE_ENV}=1): jobs that become ready are sent to the printer plugin once`
      : `print auto-route is off (set ${PRINT_AUTO_ROUTE_ENV}=1 to send jobs that become ready automatically)`,
  );
} else {
  app.log.info(`print output is off (set ${PRINT_OUTPUT_ENV}=1 and ${PRINTER_PLUGIN_ENV} to send jobs to a printer plugin)`);
}
app.log.info(
  imposition
    ? `imposition plans are on (${IMPOSITION_ENV}=1): POST /imposition/n-up and POST /imposition/booklet`
    : `imposition plans are off (set ${IMPOSITION_ENV}=1 to plan n-up and booklet impositions)`,
);
app.log.info(
  whiteInk
    ? `white ink settings are on (${WHITE_INK_ENV}=1): PUT and DELETE /jobs/:id/white-ink`
    : `white ink settings are off (set ${WHITE_INK_ENV}=1 to set a job's white ink setting)`,
);
app.log.info(
  screening
    ? `screening settings are on (${SCREENING_ENV}=1): PUT and DELETE /jobs/:id/screening`
    : `screening settings are off (set ${SCREENING_ENV}=1 to set a job's screening setting)`,
);
app.log.info(
  inkLimit
    ? `ink-limit settings are on (${INK_LIMIT_ENV}=1): PUT and DELETE /jobs/:id/ink-limit`
    : `ink-limit settings are off (set ${INK_LIMIT_ENV}=1 to set a job's ink-limit setting)`,
);
if (https === undefined) {
  app.log.info('TLS is off: serving plain HTTP (set BPS_TLS_CERT and BPS_TLS_KEY to serve HTTPS)');
} else {
  app.log.info(`TLS is on: serving HTTPS with minimum version ${https.minVersion}`);
}
await app.listen({ host, port });
