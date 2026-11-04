import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAILED_SUBFOLDER, isTerminal, type HotFolder, type Job } from '@bax-print/core';
import { sha256Hex, type Storage } from '@bax-print/store';
import type { DocumentInspector, IntakeDeps } from '../src/index.js';

export const PROCESSED = '_processed';
export const FAILED = FAILED_SUBFOLDER;

/** In-memory JobRepository + findLiveBySha256 fake; keeps the latest saved copy of each job. */
export class FakeJobs {
  readonly byId = new Map<string, Job>();
  saves = 0;

  async save(job: Job): Promise<void> {
    this.saves++;
    this.byId.set(job.id, structuredClone(job));
  }

  async get(id: string): Promise<Job | undefined> {
    return this.byId.get(id);
  }

  async findById(id: string): Promise<Job | undefined> {
    return this.byId.get(id);
  }

  async list(): Promise<Job[]> {
    return [...this.byId.values()];
  }

  async findLiveBySha256(hotFolderId: string, sha256: string): Promise<Job | undefined> {
    return [...this.byId.values()].find(
      (job) =>
        job.hotFolderId === hotFolderId &&
        !isTerminal(job.status) &&
        job.sourceFiles.some((file) => file.sha256 === sha256),
    );
  }
}

/** In-memory Storage fake: records every put and echoes the content hash. */
export class FakeStorage {
  readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<{ key: string; sha256: string; sizeBytes: number }> {
    this.blobs.set(key, new Uint8Array(bytes));
    return { key, sha256: sha256Hex(bytes), sizeBytes: bytes.byteLength };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(key);
  }

  async has(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

export const okInspector: DocumentInspector = {
  async inspect() {
    return { pageCount: 1, pages: [] };
  },
};

export const failingInspector: DocumentInspector = {
  async inspect() {
    throw Object.assign(new Error('not a PDF'), { code: 'INSPECT_FAILED' });
  },
};

export interface Harness {
  readonly jobs: FakeJobs;
  readonly storage: FakeStorage;
  readonly deps: IntakeDeps;
}

export function makeDeps(inspector: DocumentInspector = okInspector): Harness {
  const jobs = new FakeJobs();
  const storage = new FakeStorage();
  const deps: IntakeDeps = {
    jobs: jobs as unknown as IntakeDeps['jobs'],
    storage: storage as unknown as Storage,
    inspector,
  };
  return { jobs, storage, deps };
}

export function makeFolder(path: string, overrides: Partial<HotFolder['settings']> = {}): HotFolder {
  return {
    id: 'hf-test',
    name: 'test folder',
    path,
    enabled: true,
    settings: {
      filePatterns: ['*.pdf'],
      moveProcessedTo: PROCESSED,
      dedupe: true,
      defaultPriority: 'normal',
      ...overrides,
    },
  } as unknown as HotFolder;
}

/** Fresh temp dir per test; the returned cleanup removes it. */
export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'bps-hotfolder-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function waitFor(condition: () => boolean, timeoutMs = 5_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs} ms`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, stepMs));
  }
}
