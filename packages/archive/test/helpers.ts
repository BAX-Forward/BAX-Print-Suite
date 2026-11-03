import type { ArtifactRole, Clock, ColorSetupRevision, Job, JobArtifact, JobTicket, ProfileRef, SourceFile } from '@bax-print/core';
import { EventBus, MemoryOutbox } from '@bax-print/events';
import {
  artifactKey,
  MemoryArchiveIndex,
  MemoryJobRepository,
  MemoryStorage,
  sha256Hex,
  sourceKey,
} from '@bax-print/store';
import { ArchiveService, StaticColorSetupResolver, type ArchiveRule, type DeviceMediaCatalog } from '../src/index.js';

export const DEVICE_A = 'printer-a';
export const DEVICE_B = 'printer-b';
export const MEDIUM_GLOSS = 'vinyl-gloss';
export const MEDIUM_MATTE = 'vinyl-matte';

export interface FakeClock {
  readonly clock: Clock;
  advance(ms: number): void;
  nowIso(): string;
}

/** Test clock that only moves when told to. */
export function fakeClock(startIso: string): FakeClock {
  let now = Date.parse(startIso);
  return {
    clock: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
    nowIso: () => new Date(now).toISOString(),
  };
}

export function sequentialIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, '0')}`;
}

export const bytesOf = (text: string): Uint8Array => Buffer.from(text, 'utf8');

export const DEFAULT_TICKET: JobTicket = {
  intent: { quantity: 2, finishedSize: { widthMm: 200, heightMm: 100 }, mediaIntent: 'self-adhesive vinyl' },
  process: { layout: { marginMm: 10, gapMm: 5 } },
  edits: [{ kind: 'rotate', degrees: 90 }],
  marks: [{ kind: 'regmark', diameterMm: 5 }],
};

export function revision(
  id: string,
  deviceId: string,
  mediumId: string,
  profiles: readonly ProfileRef[] = [],
): ColorSetupRevision {
  return {
    id,
    colorSetupId: `setup-${deviceId}-${mediumId}`,
    deviceId,
    mediumId,
    createdAt: '2026-01-05T09:00:00.000Z',
    profiles,
  };
}

export function fileRecord(name: string, bytes: Uint8Array, storageKey: string): SourceFile {
  return { name, sha256: sha256Hex(bytes), sizeBytes: bytes.byteLength, storageKey };
}

export type JobOverrides = Partial<Job> & { readonly id: string };

/** A finished, active job with sensible defaults; no blobs are written. */
export function makeJob(overrides: JobOverrides): Job {
  return {
    name: `Job ${overrides.id}`,
    status: 'done',
    priority: 50,
    sourceFiles: [],
    artifacts: [],
    ticket: DEFAULT_TICKET,
    tags: [],
    metadata: {},
    createdAt: '2026-02-01T08:00:00.000Z',
    updatedAt: '2026-02-01T10:00:00.000Z',
    doneAt: '2026-02-01T10:00:00.000Z',
    lifecycle: 'active',
    legalHold: false,
    ...overrides,
  };
}

export interface Harness {
  readonly service: ArchiveService;
  readonly jobs: MemoryJobRepository;
  readonly index: MemoryArchiveIndex;
  readonly blobs: MemoryStorage;
  readonly archive: MemoryStorage;
  readonly outbox: MemoryOutbox;
  readonly bus: EventBus;
  readonly colorSetups: StaticColorSetupResolver;
  readonly time: FakeClock;
}

export interface HarnessOptions {
  readonly start?: string;
  readonly idPrefix?: string;
  readonly rules?: readonly ArchiveRule[];
  readonly retentionMs?: number;
  readonly catalog?: DeviceMediaCatalog;
}

/** Archive service wired to in-memory stores, a fake clock and deterministic ids. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const prefix = options.idPrefix ?? 'test';
  const time = fakeClock(options.start ?? '2026-03-01T08:00:00.000Z');
  const outbox = new MemoryOutbox();
  const bus = new EventBus(outbox, { clock: time.clock, newId: sequentialIds(`${prefix}-evt`) });
  const jobs = new MemoryJobRepository();
  const index = new MemoryArchiveIndex();
  const blobs = new MemoryStorage();
  const archive = new MemoryStorage();
  const colorSetups = new StaticColorSetupResolver();
  const service = new ArchiveService({
    jobs,
    index,
    blobs,
    archive,
    bus,
    outbox,
    colorSetups,
    catalog: options.catalog,
    clock: time.clock,
    newId: sequentialIds(`${prefix}-job`),
    rules: options.rules,
    retentionMs: options.retentionMs,
  });
  return { service, jobs, index, blobs, archive, outbox, bus, colorSetups, time };
}

export interface SeedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface SeedArtifact extends SeedFile {
  readonly role: ArtifactRole;
}

export type SeedOptions = Omit<JobOverrides, 'sourceFiles' | 'artifacts'> & {
  readonly sources?: readonly SeedFile[];
  readonly artifacts?: readonly SeedArtifact[];
};

/** Writes the job's blobs to active storage and saves the job row. */
export async function seedJob(h: Pick<Harness, 'jobs' | 'blobs'>, options: SeedOptions): Promise<Job> {
  const {
    sources = [{ name: 'artwork.pdf', bytes: bytesOf(`%PDF-1.7 artwork of ${options.id}`) }],
    artifacts = [],
    ...fields
  } = options;
  const sourceFiles: SourceFile[] = [];
  for (const [index, file] of sources.entries()) {
    const key = sourceKey(fields.id, index, file.name);
    await h.blobs.put(key, file.bytes);
    sourceFiles.push(fileRecord(file.name, file.bytes, key));
  }
  const jobArtifacts: JobArtifact[] = [];
  for (const [index, artifact] of artifacts.entries()) {
    const key = artifactKey(fields.id, artifact.role, index, artifact.name);
    await h.blobs.put(key, artifact.bytes);
    jobArtifacts.push({ ...fileRecord(artifact.name, artifact.bytes, key), role: artifact.role });
  }
  const job = makeJob({ ...fields, sourceFiles, artifacts: jobArtifacts });
  await h.jobs.save(job);
  return job;
}

export const DEFAULT_ARTIFACTS: readonly SeedArtifact[] = [
  { role: 'layout', name: 'imposed.pdf', bytes: bytesOf('%PDF-1.7 imposed sheet') },
  { role: 'cut', name: 'cut.svg', bytes: bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L 10 0 Z"/></svg>') },
  { role: 'preview', name: 'preview.png', bytes: bytesOf('preview-thumbnail') },
];

export function typesOf(h: Pick<Harness, 'outbox'>, types: readonly string[]): string[] {
  return h.outbox.list({ types }).map((record) => record.event.type);
}
