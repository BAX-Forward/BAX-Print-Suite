import type { HotFolder, Job } from "@bax-print/core";
import type { PreflightProfile } from "@bax-print/inspect";
import type { PreflightReport } from "@bax-print/plugin-sdk";

/**
 * Storage seams for the Spec 007 routes. The in-memory versions serve tests and a single
 * process; the Spec 001 sqlite store implements the same interfaces.
 */

/** The job repository seam; the store package's `JobRepository` satisfies it. */
export interface JobStore {
  get(id: string): Promise<Job | undefined>;
  save(job: Job): Promise<void>;
}

export interface FindingsStore {
  get(jobId: string): Promise<PreflightReport | undefined>;
  put(jobId: string, report: PreflightReport): Promise<void>;
}

/** Custom (user-defined) profiles only; built-in profiles live in code. */
export interface ProfileStore {
  list(): Promise<PreflightProfile[]>;
  get(id: string): Promise<PreflightProfile | undefined>;
  put(profile: PreflightProfile): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export interface HotFolderStore {
  get(id: string): Promise<HotFolder | undefined>;
}

/** Values are cloned in and out, so callers can't change stored state by mutating a result. */
class MemoryMap<T> {
  protected readonly items = new Map<string, T>();

  protected read(id: string): T | undefined {
    const item = this.items.get(id);
    return item === undefined ? undefined : structuredClone(item);
  }

  protected write(id: string, item: T): void {
    this.items.set(id, structuredClone(item));
  }
}

export class MemoryJobStore extends MemoryMap<Job> implements JobStore {
  async get(id: string): Promise<Job | undefined> {
    return this.read(id);
  }

  async save(job: Job): Promise<void> {
    this.write(job.id, job);
  }
}

export class MemoryFindingsStore extends MemoryMap<PreflightReport> implements FindingsStore {
  async get(jobId: string): Promise<PreflightReport | undefined> {
    return this.read(jobId);
  }

  async put(jobId: string, report: PreflightReport): Promise<void> {
    this.write(jobId, report);
  }
}

export class MemoryProfileStore extends MemoryMap<PreflightProfile> implements ProfileStore {
  async list(): Promise<PreflightProfile[]> {
    return [...this.items.keys()].sort().map((id) => this.read(id) as PreflightProfile);
  }

  async get(id: string): Promise<PreflightProfile | undefined> {
    return this.read(id);
  }

  async put(profile: PreflightProfile): Promise<void> {
    this.write(profile.id, profile);
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
}

export class MemoryHotFolderStore extends MemoryMap<HotFolder> implements HotFolderStore {
  constructor(folders: readonly HotFolder[] = []) {
    super();
    folders.forEach((folder) => this.write(folder.id, folder));
  }

  async get(id: string): Promise<HotFolder | undefined> {
    return this.read(id);
  }
}
