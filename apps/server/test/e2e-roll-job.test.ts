import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import {
  CUTTER_DRIVER_INTERFACE,
  CUTTER_DRIVER_VERSION,
  createCutterDriverClient,
  launchPlugin,
  readManifest,
  satisfiesRange,
  sha256Hex,
  type BppClient,
  type CutJob,
  type PluginManifest,
} from '@bax-print/plugin-sdk';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import type { CutJobResponse } from '../src/cut-routes.js';
import { JobService } from '../src/jobs.js';
import { MediaService } from '../src/media-service.js';
import { memoryMediaStores } from '../src/media-stores.js';
import { createPdfCutExtractor } from '../src/pdf-cut-extractor.js';
import { createRollCutExtractor } from '../src/roll-cut.js';
import type { StepRepeatBody, StepRepeatResponse } from '../src/step-repeat-routes.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

/**
 * Spec 003v: one roll job end to end over `app.inject` — submit a PDF, step and repeat it on the
 * roll, plan its cut job, and export that cut job through every cutter plugin over BPP.
 */

const PLUGINS_DIR = fileURLToPath(new URL('../../../plugins/', import.meta.url));
const MANIFEST_FILE = 'bps-plugin.json';
const PT_PER_MM = 72 / 25.4;
const PLUGIN_TIMEOUT_MS = 60_000;

/** The layer name the step-and-repeat job gives every copy's trim contour. */
const TRIM_LAYER = 'trim';

/** Trim box of the source page: 200 × 100 pt inside a 220 × 120 pt MediaBox. */
const TRIM = { widthPt: 200, heightPt: 100 };

/**
 * A one-page PDF written in the test (ISO 32000-1 §7.5, §14.11.2): catalog, page tree, one page
 * with a MediaBox and a TrimBox, and its content stream, with a cross-reference table. ASCII only,
 * so string offsets are byte offsets.
 */
function trimmedPagePdf(): Uint8Array {
  const content = '0 0 0 rg 10 10 200 100 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << >> /MediaBox [0 0 220 120] /TrimBox [10 10 210 110] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let text = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

/** About 70.6 × 35.3 mm per copy: four columns across a 300 mm roll, so 6 copies take two rows. */
const BODY: StepRepeatBody = {
  copies: 6,
  rollWidthMm: 300,
  marginsMm: { left: 0, right: 0, lead: 0, trail: 0 },
  gapXMm: 0,
  gapYMm: 0,
  rotate: 'none',
  sourceBox: 'trim',
};

interface CutterPlugin {
  readonly manifestPath: string;
  readonly manifest: PluginManifest;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isCutter(manifest: PluginManifest): boolean {
  return manifest.provides.some((p) => p.interface === CUTTER_DRIVER_INTERFACE && satisfiesRange(CUTTER_DRIVER_VERSION, p.versions));
}

/** Every plugin under `plugins/` whose manifest provides CutterDriver/2, by directory name. */
async function discoverCutters(): Promise<CutterPlugin[]> {
  const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const cutters: CutterPlugin[] = [];
  for (const directory of [...directories].sort()) {
    const manifestPath = join(PLUGINS_DIR, directory, MANIFEST_FILE);
    try {
      const manifest = await readManifest(manifestPath);
      if (isCutter(manifest)) cutters.push({ manifestPath, manifest });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return cutters;
}

/** The formats a manifest declares in `capabilities.formats`. */
function declaredFormats(manifest: PluginManifest): string[] {
  const formats = manifest.capabilities?.formats;
  return Array.isArray(formats) ? formats.filter((format): format is string => typeof format === 'string') : [];
}

const CUTTERS = await discoverCutters();

interface InjectResponse {
  readonly statusCode: number;
  json<T = unknown>(): T;
}

interface Roll {
  readonly app: FastifyInstance;
  readonly dataDir: string;
  readonly jobId: string;
  readonly stepRepeat: InjectResponse;
  readonly cutJob: InjectResponse;
}

/** A server whose blobs are files in a temp dir, wired as `main.ts` wires the production routes. */
async function runRollJob(): Promise<Roll> {
  const dataDir = await mkdtemp(join(tmpdir(), 'bps-003v-'));
  const blobsDir = join(dataDir, 'blobs');
  const blobPath = (storageKey: string): string => resolve(blobsDir, ...storageKey.split('/'));
  const time = fakeClock('2026-03-01T08:00:00.000Z');
  const outbox = new MemoryOutbox();
  const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
  const repository = new MemoryJobRepository();
  const blobs = new LocalDirStorage(blobsDir);
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
  const roll = createRollCutExtractor(createPdfCutExtractor({ blobPath, cut: { layerNames: [TRIM_LAYER] } }));
  const app = buildServer({ archive, media, jobs: repository, cutExtractor: roll.extractor, stepRepeat: { blobPath, onJob: roll.onJob } });

  const job = await jobs.create({ name: 'Roll stickers', sources: [{ name: 'sticker.pdf', bytes: trimmedPagePdf() }], ticket: TICKET });
  const stepRepeat = await app.inject({ method: 'POST', url: `/jobs/${job.id}/step-repeat`, payload: BODY });
  const cutJob = await app.inject({ method: 'POST', url: `/jobs/${job.id}/cut-job` });
  return { app, dataDir, jobId: job.id, stepRepeat, cutJob };
}

function plannedCutJob(response: InjectResponse): CutJob {
  const body = response.json<CutJobResponse>();
  if (body.kind !== 'job') throw new Error('expected a planned cut job');
  return body.job;
}

describe('roll job end to end (Spec 003v)', () => {
  let roll: Roll | undefined;
  const clients = new Set<BppClient>();

  function current(): Roll {
    if (!roll) throw new Error('the roll job did not run');
    return roll;
  }

  beforeAll(async () => {
    roll = await runRollJob();
  });

  afterAll(async () => {
    await Promise.all([...clients].map((client) => client.close()));
    clients.clear();
    await roll?.app.close();
    if (roll) await rm(roll.dataDir, { recursive: true, force: true });
    roll = undefined;
  });

  it('steps and repeats the trim box into one trim contour per copy', () => {
    const { stepRepeat } = current();

    expect(stepRepeat.statusCode).toBe(200);
    const body = stepRepeat.json<StepRepeatResponse>();
    expect(body.layout.placements).toHaveLength(BODY.copies);
    expect(body.cutContours).toHaveLength(BODY.copies);
    for (const contour of body.cutContours) {
      expect(contour).toMatchObject({ closed: true, source: { kind: 'layer', name: TRIM_LAYER } });
      expect(contour.areaSigned).toBeCloseTo(TRIM.widthPt * TRIM.heightPt, 3);
    }
  });

  it('plans the cut job on the roll from the stepped-and-repeated contours', () => {
    const { stepRepeat, cutJob, jobId } = current();

    expect(cutJob.statusCode).toBe(200);
    const job = plannedCutJob(cutJob);
    const { layout, cutContours } = stepRepeat.json<StepRepeatResponse>();
    expect(job.jobId).toBe(jobId);
    expect(job.contours).toEqual(cutContours);
    expect(job.frame.widthPt).toBeCloseTo(BODY.rollWidthMm * PT_PER_MM, 6);
    expect(job.frame.heightPt).toBeCloseTo(layout.lengthUsedPt, 6);
    for (const contour of job.contours) {
      expect(contour.bbox.minX).toBeGreaterThanOrEqual(-1e-6);
      expect(contour.bbox.minY).toBeGreaterThanOrEqual(-1e-6);
      expect(contour.bbox.maxX).toBeLessThanOrEqual(job.frame.widthPt + 1e-6);
      expect(contour.bbox.maxY).toBeLessThanOrEqual(job.frame.heightPt + 1e-6);
    }
  });

  it('finds at least two cutter plugins by their manifests', () => {
    expect(CUTTERS.length).toBeGreaterThanOrEqual(2);
  });

  it.each(CUTTERS.map((cutter): [string, CutterPlugin] => [cutter.manifest.id, cutter]))(
    'exports the cut job through %s over BPP',
    async (_id, cutter) => {
      const job = plannedCutJob(current().cutJob);
      expect(job.contours).toHaveLength(BODY.copies);

      const launched = await launchPlugin(cutter.manifestPath, { initializeTimeoutMs: PLUGIN_TIMEOUT_MS });
      clients.add(launched.client);
      expect(launched.client.pid).not.toBe(process.pid);
      const driver = createCutterDriverClient(launched.client);
      await driver.configure({});

      const declared = declaredFormats(cutter.manifest);
      const format = (await driver.formats()).find((candidate) => declared.includes(candidate.id));
      if (!format) throw new Error(`${cutter.manifest.id} serves none of its declared formats ${JSON.stringify(declared)}`);

      const result = await driver.export(job, format.id);

      expect(result.handle).toEqual({ kind: 'inline' });
      expect(result.bytes.byteLength).toBeGreaterThan(0);
      expect(result.sha256).toBe(sha256Hex(result.bytes));
      expect(result.fileName.length).toBeGreaterThan(0);
    },
    PLUGIN_TIMEOUT_MS,
  );
});
