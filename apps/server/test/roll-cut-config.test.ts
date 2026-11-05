import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository, MemoryStorage } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import type { CutExtractor, CutJobResponse } from '../src/cut-routes.js';
import { JobService } from '../src/jobs.js';
import { createPdfCutExtractor } from '../src/pdf-cut-extractor.js';
import { configureRollCut, parseRollCut, ROLL_CUT_ENV } from '../src/roll-cut-config.js';
import type { StepRepeatBody, StepRepeatResponse } from '../src/step-repeat-routes.js';
import { fakeClock, sequentialIds, TICKET } from './helpers.js';

const PT_PER_MM = 72 / 25.4;

/** The layer name the step-and-repeat job gives every copy's trim contour. */
const TRIM_LAYER = 'trim';

/**
 * A one-page PDF written in the test (ISO 32000-1 §7.5, §14.11.2) with a 220 × 120 pt MediaBox and
 * a 200 × 100 pt TrimBox. ASCII only, so string offsets are byte offsets.
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

const BODY: StepRepeatBody = {
  copies: 6,
  rollWidthMm: 300,
  marginsMm: { left: 0, right: 0, lead: 0, trail: 0 },
  gapXMm: 0,
  gapYMm: 0,
  rotate: 'none',
  sourceBox: 'trim',
};

function plannedCutJob(body: CutJobResponse): Extract<CutJobResponse, { kind: 'job' }>['job'] {
  if (body.kind !== 'job') throw new Error('expected a planned cut job');
  return body.job;
}

describe('parseRollCut (Spec 003y)', () => {
  it('is off when the variable is absent', () => {
    expect(parseRollCut(undefined)).toBe(false);
  });

  it.each(['1', 'true'])('is on for %j', (value) => {
    expect(parseRollCut(value)).toBe(true);
  });

  it.each(['', '0', 'false', 'yes', 'TRUE', ' 1'])('rejects %j', (value) => {
    expect(() => parseRollCut(value)).toThrow(ROLL_CUT_ENV);
  });

  it('throws from configureRollCut for an invalid value', () => {
    expect(() => configureRollCut({ [ROLL_CUT_ENV]: 'on' }, async () => undefined)).toThrow(ROLL_CUT_ENV);
  });

  it('returns the base extractor and no onJob when off', () => {
    const base: CutExtractor = async () => undefined;

    const config = configureRollCut({}, base);

    expect(config.cutExtractor).toBe(base);
    expect(config.stepRepeat).toEqual({});
  });
});

interface Fixture {
  readonly dataDir: string;
  readonly jobId: string;
  /** Built from `configureRollCut(env, base)` as `main.ts` builds it. */
  readonly app: FastifyInstance;
  /** The same jobs with the base extractor and no roll cut wiring. */
  readonly plain: FastifyInstance;
}

async function setup(env: Readonly<Record<string, string | undefined>>): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), 'bps-003y-'));
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
  const base = createPdfCutExtractor({ blobPath, cut: { layerNames: [TRIM_LAYER] } });
  const rollCut = configureRollCut(env, base);
  const app = buildServer({
    archive,
    jobs: repository,
    cutExtractor: rollCut.cutExtractor,
    stepRepeat: { blobPath, ...rollCut.stepRepeat },
  });
  const plain = buildServer({ archive, jobs: repository, cutExtractor: base, stepRepeat: { blobPath } });
  const job = await jobs.create({ name: 'Roll stickers', sources: [{ name: 'sticker.pdf', bytes: trimmedPagePdf() }], ticket: TICKET });
  return { dataDir, jobId: job.id, app, plain };
}

describe('configureRollCut over app.inject (Spec 003y)', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (!fixture) return;
    await Promise.all([fixture.app.close(), fixture.plain.close()]);
    await rm(fixture.dataDir, { recursive: true, force: true });
    fixture = undefined;
  });

  it('plans the cut job on the roll after step and repeat when on', async () => {
    fixture = await setup({ [ROLL_CUT_ENV]: '1' });
    const { app, jobId } = fixture;

    const stepRepeat = await app.inject({ method: 'POST', url: `/jobs/${jobId}/step-repeat`, payload: BODY });
    const cutJob = await app.inject({ method: 'POST', url: `/jobs/${jobId}/cut-job` });

    expect(stepRepeat.statusCode).toBe(200);
    expect(cutJob.statusCode).toBe(200);
    const { layout, cutContours } = stepRepeat.json<StepRepeatResponse>();
    const job = plannedCutJob(cutJob.json<CutJobResponse>());
    expect(job.contours).toEqual(cutContours);
    expect(job.frame.widthPt).toBeCloseTo(BODY.rollWidthMm * PT_PER_MM, 6);
    expect(job.frame.heightPt).toBeCloseTo(layout.lengthUsedPt, 6);
  });

  it('leaves the cut job unchanged after step and repeat when off', async () => {
    fixture = await setup({});
    const { app, plain, jobId } = fixture;

    const stepRepeat = await app.inject({ method: 'POST', url: `/jobs/${jobId}/step-repeat`, payload: BODY });
    const cutJob = await app.inject({ method: 'POST', url: `/jobs/${jobId}/cut-job` });
    const baseline = await plain.inject({ method: 'POST', url: `/jobs/${jobId}/cut-job` });

    expect(stepRepeat.statusCode).toBe(200);
    expect(cutJob.statusCode).toBe(baseline.statusCode);
    expect(cutJob.json<CutJobResponse>()).toEqual(baseline.json<CutJobResponse>());
  });
});
