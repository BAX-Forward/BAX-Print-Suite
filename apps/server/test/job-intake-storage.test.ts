import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchiveService, StaticColorSetupResolver } from '@bax-print/archive';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import { LocalDirStorage, MemoryArchiveIndex, MemoryJobRepository, MemoryStorage, sha256Hex } from '@bax-print/store';
import { buildServer } from '../src/app.js';
import { JobService } from '../src/jobs.js';
import { fakeClock, sequentialIds } from './helpers.js';

const PDF = Buffer.from('%PDF-1.7\n% intake storage test\n', 'latin1');

interface Harness {
  readonly app: FastifyInstance;
  readonly repository: MemoryJobRepository;
  readonly dataDir: string;
}

/** Every file below `dir`, as paths relative to it; none when it was never created. */
async function filesBelow(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

describe('job intake storage (Spec 052c)', () => {
  const apps: FastifyInstance[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A server whose source blobs live on disk under `dataDir/blobs`, next to `dataDir/intake`. */
  async function createHarness(maxBytes: number): Promise<Harness> {
    const dataDir = await mkdtemp(join(tmpdir(), 'bps-052c-'));
    dirs.push(dataDir);
    const time = fakeClock('2026-03-01T08:00:00.000Z');
    const outbox = new MemoryOutbox();
    const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds('evt') });
    const repository = new MemoryJobRepository();
    const blobs = new LocalDirStorage(join(dataDir, 'blobs'));
    const service = new JobService({ jobs: repository, blobs, bus, clock: time.clock, newId: sequentialIds('job') });
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
    const app = buildServer({
      archive,
      jobs: repository,
      jobIntake: {
        jobs: repository,
        service,
        intakeDir: join(dataDir, 'intake'),
        maxBytes,
        newFileId: sequentialIds('upload'),
      },
    });
    apps.push(app);
    return { app, repository, dataDir };
  }

  /** An upload without content-length: the body arrives as these chunks. */
  function uploadChunks(harness: Harness, chunks: readonly Buffer[]) {
    return harness.app.inject({
      method: 'POST',
      url: '/jobs',
      headers: { 'content-type': 'application/pdf' },
      payload: Readable.from(chunks),
    });
  }

  it('stores the upload once: the intake file becomes the source blob', async () => {
    const harness = await createHarness(1024);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/jobs',
      headers: { 'content-type': 'application/pdf' },
      payload: PDF,
    });

    expect(response.statusCode).toBe(201);
    const { job } = response.json<{ job: { id: string } }>();
    const stored = await harness.repository.get(job.id);
    const source = stored?.sourceFiles[0];
    expect(source).toMatchObject({ name: 'upload-0001.pdf', sha256: sha256Hex(PDF), sizeBytes: PDF.byteLength });
    const key = source?.storageKey ?? '';
    // One file on disk in total: no intake copy, no part file, no temp file.
    expect(await filesBelow(harness.dataDir)).toEqual([join('blobs', ...key.split('/'))]);
    expect(await readFile(join(harness.dataDir, 'blobs', ...key.split('/')))).toEqual(PDF);
  });

  it('streams a body without content-length and checks %PDF- across chunks', async () => {
    const harness = await createHarness(1024);

    const response = await uploadChunks(harness, [Buffer.from('%P'), Buffer.from('DF'), PDF.subarray(4)]);

    expect(response.statusCode).toBe(201);
    const { job } = response.json<{ job: { id: string } }>();
    expect((await harness.repository.get(job.id))?.sourceFiles[0]).toMatchObject({
      sha256: sha256Hex(PDF),
      sizeBytes: PDF.byteLength,
    });
    expect(await filesBelow(harness.dataDir)).toHaveLength(1);
  });

  it('answers 413 when a body without content-length runs past the cap, and deletes the part file', async () => {
    const harness = await createHarness(64);

    const response = await uploadChunks(harness, [PDF, Buffer.alloc(32), Buffer.alloc(32)]);

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('invalid_request');
    expect(await filesBelow(harness.dataDir)).toEqual([]);
    expect(await harness.repository.list()).toEqual([]);
  });

  it('writes nothing for a body without content-length that is not a PDF', async () => {
    const harness = await createHarness(1024);

    const response = await uploadChunks(harness, [Buffer.from('hello'), Buffer.from(', not a pdf')]);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('upload_not_pdf');
    expect(await filesBelow(harness.dataDir)).toEqual([]);
  });
});
