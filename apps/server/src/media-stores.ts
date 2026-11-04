/**
 * Storage seams for the Spec 005 routes. The in-memory versions serve tests and a single
 * process; an adapter over the media package's repositories implements the same interfaces.
 */

export type Attributes = Readonly<Record<string, unknown>>;

export interface Medium {
  readonly id: string;
  readonly name: string;
  readonly attributes: Attributes;
  readonly updatedAt: string;
}

export interface OutputMode {
  readonly id: string;
  readonly mediumId: string;
  readonly name: string;
  readonly settings: Attributes;
}

export type RevisionStatus = "draft" | "published" | "superseded";

/** A color setup revision is immutable once published; a newer publish supersedes it. */
export interface ColorSetupRevision {
  readonly id: string;
  readonly colorSetupId: string;
  readonly number: number;
  readonly status: RevisionStatus;
  readonly settings: Attributes;
  readonly createdAt: string;
  readonly publishedAt?: string;
}

/** A preset names a color setup, not a revision: jobs pin the revision when they render. */
export interface Preset {
  readonly id: string;
  readonly name: string;
  readonly mediumId: string;
  readonly outputModeId?: string;
  readonly colorSetupId: string;
}

export interface ProfilingStep {
  readonly id: string;
  readonly status: "pending" | "completed";
  readonly completedAt?: string;
  readonly result?: Attributes;
}

export interface ProfilingSession {
  readonly id: string;
  readonly mediumId: string;
  readonly outputModeId?: string;
  readonly colorSetupId: string;
  readonly status: "open" | "completed";
  readonly steps: readonly ProfilingStep[];
  readonly createdAt: string;
}

export interface MediumStore {
  list(): Promise<Medium[]>;
  get(id: string): Promise<Medium | undefined>;
  put(medium: Medium): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export interface OutputModeStore {
  list(mediumId: string): Promise<OutputMode[]>;
  get(mediumId: string, id: string): Promise<OutputMode | undefined>;
  put(mode: OutputMode): Promise<void>;
}

export interface ColorSetupRevisionStore {
  /** Ordered by revision number, oldest first. */
  list(colorSetupId: string): Promise<ColorSetupRevision[]>;
  put(revision: ColorSetupRevision): Promise<void>;
}

export interface PresetStore {
  list(): Promise<Preset[]>;
  get(id: string): Promise<Preset | undefined>;
  put(preset: Preset): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export interface ProfilingSessionStore {
  get(id: string): Promise<ProfilingSession | undefined>;
  put(session: ProfilingSession): Promise<void>;
}

export interface MediaStores {
  readonly media: MediumStore;
  readonly modes: OutputModeStore;
  readonly revisions: ColorSetupRevisionStore;
  readonly presets: PresetStore;
  readonly sessions: ProfilingSessionStore;
}

/** Values are cloned in and out, so callers can't change stored state by mutating a result. */
class MemoryTable<T> {
  private readonly items = new Map<string, T>();

  read(key: string): T | undefined {
    const item = this.items.get(key);
    return item === undefined ? undefined : structuredClone(item);
  }

  write(key: string, item: T): void {
    this.items.set(key, structuredClone(item));
  }

  remove(key: string): boolean {
    return this.items.delete(key);
  }

  values(): T[] {
    return [...this.items.keys()].sort().map((key) => this.read(key) as T);
  }
}

export class MemoryMediumStore implements MediumStore {
  private readonly table = new MemoryTable<Medium>();
  async list(): Promise<Medium[]> {
    return this.table.values();
  }
  async get(id: string): Promise<Medium | undefined> {
    return this.table.read(id);
  }
  async put(medium: Medium): Promise<void> {
    this.table.write(medium.id, medium);
  }
  async delete(id: string): Promise<boolean> {
    return this.table.remove(id);
  }
}

const modeKey = (mediumId: string, id: string): string => JSON.stringify([mediumId, id]);

export class MemoryOutputModeStore implements OutputModeStore {
  private readonly table = new MemoryTable<OutputMode>();
  async list(mediumId: string): Promise<OutputMode[]> {
    return this.table.values().filter((mode) => mode.mediumId === mediumId);
  }
  async get(mediumId: string, id: string): Promise<OutputMode | undefined> {
    return this.table.read(modeKey(mediumId, id));
  }
  async put(mode: OutputMode): Promise<void> {
    this.table.write(modeKey(mode.mediumId, mode.id), mode);
  }
}

export class MemoryColorSetupRevisionStore implements ColorSetupRevisionStore {
  private readonly table = new MemoryTable<ColorSetupRevision>();
  async list(colorSetupId: string): Promise<ColorSetupRevision[]> {
    return this.table
      .values()
      .filter((revision) => revision.colorSetupId === colorSetupId)
      .sort((a, b) => a.number - b.number);
  }
  async put(revision: ColorSetupRevision): Promise<void> {
    this.table.write(revision.id, revision);
  }
}

export class MemoryPresetStore implements PresetStore {
  private readonly table = new MemoryTable<Preset>();
  async list(): Promise<Preset[]> {
    return this.table.values();
  }
  async get(id: string): Promise<Preset | undefined> {
    return this.table.read(id);
  }
  async put(preset: Preset): Promise<void> {
    this.table.write(preset.id, preset);
  }
  async delete(id: string): Promise<boolean> {
    return this.table.remove(id);
  }
}

export class MemoryProfilingSessionStore implements ProfilingSessionStore {
  private readonly table = new MemoryTable<ProfilingSession>();
  async get(id: string): Promise<ProfilingSession | undefined> {
    return this.table.read(id);
  }
  async put(session: ProfilingSession): Promise<void> {
    this.table.write(session.id, session);
  }
}

export function memoryMediaStores(): MediaStores {
  return {
    media: new MemoryMediumStore(),
    modes: new MemoryOutputModeStore(),
    revisions: new MemoryColorSetupRevisionStore(),
    presets: new MemoryPresetStore(),
    sessions: new MemoryProfilingSessionStore(),
  };
}
