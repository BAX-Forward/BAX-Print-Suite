import { systemClock, ulid, type Clock, type Job } from "@bax-print/core";
import type { EventBus } from "@bax-print/events";
import { conflict, invalid, notFound } from "./errors.js";
import {
  COLOR_SETUP_SOURCE,
  MEDIA_SOURCE,
  MediaEventTypes,
  PROFILING_SOURCE,
  type ColorSetupPublishedData,
  type MediaSyncedData,
  type ProfilingStepCompletedData,
} from "./events.js";
import type {
  Attributes,
  ColorSetupRevision,
  MediaStores,
  Medium,
  OutputMode,
  Preset,
  ProfilingSession,
} from "./media-stores.js";
import type { JobStore } from "./stores.js";

export interface MediumInput {
  readonly id?: string;
  readonly name: string;
  readonly attributes?: Attributes;
}

export interface OutputModeInput {
  readonly id?: string;
  readonly name: string;
  readonly settings?: Attributes;
}

export interface PresetInput {
  readonly id?: string;
  readonly name: string;
  readonly mediumId: string;
  readonly outputModeId?: string;
  readonly colorSetupId: string;
}

export interface ProfilingSessionInput {
  readonly mediumId: string;
  readonly outputModeId?: string;
  readonly colorSetupId: string;
  /** Step ids in the order they must complete. */
  readonly steps: readonly string[];
}

export interface MediaServiceDeps {
  readonly stores: MediaStores;
  readonly bus: EventBus;
  /** Needed only to pin color setup revisions on jobs at render time. */
  readonly jobs?: JobStore;
  readonly clock?: Clock;
  readonly newId?: () => string;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Spec 005 server operations: the media library and its output modes, color setup revisions,
 * presets and profiling sessions. State changes other services react to are published as
 * `media.synced`, `colorsetup.published` and `profiling.step.completed`.
 */
export class MediaService {
  private readonly clock: Clock;
  private readonly newId: () => string;

  constructor(private readonly deps: MediaServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.newId = deps.newId ?? (() => ulid(this.clock().getTime()));
  }

  // --- media library ---

  listMedia(): Promise<Medium[]> {
    return this.deps.stores.media.list();
  }

  async getMedium(id: string): Promise<Medium> {
    const medium = await this.deps.stores.media.get(id);
    if (!medium) throw notFound("Medium", id);
    return medium;
  }

  async createMedium(input: MediumInput): Promise<Medium> {
    const id = input.id ?? this.newId();
    if (await this.deps.stores.media.get(id)) throw conflict(`Medium ${id} already exists`);
    const medium = this.toMedium(id, input);
    await this.deps.stores.media.put(medium);
    return medium;
  }

  async replaceMedium(id: string, input: MediumInput): Promise<Medium> {
    if (input.id !== undefined && input.id !== id) throw invalid(`Body id ${input.id} does not match path id ${id}`);
    await this.getMedium(id);
    const medium = this.toMedium(id, input);
    await this.deps.stores.media.put(medium);
    return medium;
  }

  async deleteMedium(id: string): Promise<void> {
    await this.getMedium(id);
    const users = (await this.deps.stores.presets.list()).filter((preset) => preset.mediumId === id);
    if (users.length > 0) {
      throw conflict(`Medium ${id} is used by preset(s) ${users.map((preset) => preset.id).join(", ")}`);
    }
    await this.deps.stores.media.delete(id);
  }

  /** Upserts media reported by a source (a device plugin or a library import) and publishes `media.synced`. */
  async syncMedia(source: string, entries: readonly MediumInput[]): Promise<MediaSyncedData> {
    const ids = entries.map((entry) => entry.id);
    if (ids.some((id) => id === undefined)) throw invalid("Every synced medium needs an id");
    if (new Set(ids).size !== ids.length) throw invalid("Synced media ids must be unique");

    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    for (const entry of entries) {
      const id = entry.id as string;
      const existing = await this.deps.stores.media.get(id);
      const attributes = entry.attributes ?? {};
      if (existing && existing.name === entry.name && sameJson(existing.attributes, attributes)) {
        unchanged.push(id);
        continue;
      }
      await this.deps.stores.media.put(this.toMedium(id, entry));
      (existing ? updated : created).push(id);
    }
    const data: MediaSyncedData = { source, created, updated, unchanged };
    this.deps.bus.publish({ type: MediaEventTypes.mediaSynced, source: MEDIA_SOURCE, subject: source, data });
    return data;
  }

  async listModes(mediumId: string): Promise<OutputMode[]> {
    await this.getMedium(mediumId);
    return this.deps.stores.modes.list(mediumId);
  }

  async createMode(mediumId: string, input: OutputModeInput): Promise<OutputMode> {
    await this.getMedium(mediumId);
    const id = input.id ?? this.newId();
    if (await this.deps.stores.modes.get(mediumId, id)) throw conflict(`Output mode ${id} already exists on medium ${mediumId}`);
    const mode: OutputMode = { id, mediumId, name: input.name, settings: input.settings ?? {} };
    await this.deps.stores.modes.put(mode);
    return mode;
  }

  // --- color setup revisions ---

  listRevisions(colorSetupId: string): Promise<ColorSetupRevision[]> {
    return this.deps.stores.revisions.list(colorSetupId);
  }

  async createRevision(colorSetupId: string, settings: Attributes): Promise<ColorSetupRevision> {
    const existing = await this.deps.stores.revisions.list(colorSetupId);
    const number = existing.reduce((max, revision) => Math.max(max, revision.number), 0) + 1;
    const revision: ColorSetupRevision = {
      id: this.newId(),
      colorSetupId,
      number,
      status: "draft",
      settings,
      createdAt: this.now(),
    };
    await this.deps.stores.revisions.put(revision);
    return revision;
  }

  /** Publishes a draft; the previously published revision becomes `superseded`. Jobs that pinned it keep it. */
  async publishRevision(colorSetupId: string, revisionId: string): Promise<ColorSetupRevision> {
    const revisions = await this.deps.stores.revisions.list(colorSetupId);
    const draft = revisions.find((revision) => revision.id === revisionId);
    if (!draft) throw notFound(`Revision of color setup ${colorSetupId}`, revisionId);
    if (draft.status !== "draft") throw conflict(`Revision ${revisionId} is ${draft.status}; only drafts can be published`);

    const previous = revisions.find((revision) => revision.status === "published");
    if (previous) await this.deps.stores.revisions.put({ ...previous, status: "superseded" });
    const published: ColorSetupRevision = { ...draft, status: "published", publishedAt: this.now() };
    await this.deps.stores.revisions.put(published);

    const data: ColorSetupPublishedData = {
      colorSetupId,
      revisionId,
      number: published.number,
      ...(previous ? { supersedes: previous.id } : {}),
    };
    this.deps.bus.publish({ type: MediaEventTypes.colorSetupPublished, source: COLOR_SETUP_SOURCE, subject: colorSetupId, data });
    return published;
  }

  async publishedRevision(colorSetupId: string): Promise<ColorSetupRevision | undefined> {
    return (await this.deps.stores.revisions.list(colorSetupId)).find((revision) => revision.status === "published");
  }

  // --- presets ---

  listPresets(): Promise<Preset[]> {
    return this.deps.stores.presets.list();
  }

  async getPreset(id: string): Promise<Preset> {
    const preset = await this.deps.stores.presets.get(id);
    if (!preset) throw notFound("Preset", id);
    return preset;
  }

  async createPreset(input: PresetInput): Promise<Preset> {
    const id = input.id ?? this.newId();
    if (await this.deps.stores.presets.get(id)) throw conflict(`Preset ${id} already exists`);
    const preset = await this.toPreset(id, input);
    await this.deps.stores.presets.put(preset);
    return preset;
  }

  async replacePreset(id: string, input: PresetInput): Promise<Preset> {
    if (input.id !== undefined && input.id !== id) throw invalid(`Body id ${input.id} does not match path id ${id}`);
    await this.getPreset(id);
    const preset = await this.toPreset(id, input);
    await this.deps.stores.presets.put(preset);
    return preset;
  }

  async deletePreset(id: string): Promise<void> {
    if (!(await this.deps.stores.presets.delete(id))) throw notFound("Preset", id);
  }

  // --- profiling sessions ---

  async createSession(input: ProfilingSessionInput): Promise<ProfilingSession> {
    await this.checkMediumAndMode(input.mediumId, input.outputModeId);
    if (input.steps.length === 0) throw invalid("A profiling session needs at least one step");
    if (new Set(input.steps).size !== input.steps.length) throw invalid("Profiling step ids must be unique");
    const session: ProfilingSession = {
      id: this.newId(),
      mediumId: input.mediumId,
      ...(input.outputModeId !== undefined ? { outputModeId: input.outputModeId } : {}),
      colorSetupId: input.colorSetupId,
      status: "open",
      steps: input.steps.map((id) => ({ id, status: "pending" })),
      createdAt: this.now(),
    };
    await this.deps.stores.sessions.put(session);
    return session;
  }

  async getSession(id: string): Promise<ProfilingSession> {
    const session = await this.deps.stores.sessions.get(id);
    if (!session) throw notFound("Profiling session", id);
    return session;
  }

  /** Steps complete in order; each completion publishes `profiling.step.completed`. */
  async completeStep(sessionId: string, stepId: string, result: Attributes = {}): Promise<ProfilingSession> {
    const session = await this.getSession(sessionId);
    const index = session.steps.findIndex((step) => step.id === stepId);
    if (index < 0) throw notFound(`Step of profiling session ${sessionId}`, stepId);
    const next = session.steps.findIndex((step) => step.status === "pending");
    if (next !== index) {
      throw conflict(next < 0 ? `Profiling session ${sessionId} is already completed` : `Step ${stepId} is not next; complete ${session.steps[next]?.id} first`);
    }
    const steps = session.steps.map((step, i) => (i === index ? { id: step.id, status: "completed" as const, completedAt: this.now(), result } : step));
    const sessionCompleted = steps.every((step) => step.status === "completed");
    const updated: ProfilingSession = { ...session, steps, status: sessionCompleted ? "completed" : "open" };
    await this.deps.stores.sessions.put(updated);

    const data: ProfilingStepCompletedData = { sessionId, stepId, index, sessionCompleted };
    this.deps.bus.publish({ type: MediaEventTypes.profilingStepCompleted, source: PROFILING_SOURCE, subject: sessionId, data });
    return updated;
  }

  // --- jobs ---

  /**
   * Pins the preset's published color setup revision on a job when it renders. A job that already
   * carries a revision keeps it, so a later publish never changes how an existing job reprints.
   */
  async pinColorSetupForRender(jobId: string): Promise<Job> {
    const jobs = this.deps.jobs;
    if (!jobs) throw new Error("MediaService was built without a job store");
    const job = await jobs.get(jobId);
    if (!job) throw notFound("Job", jobId);
    if (job.colorSetupRevisionId !== undefined) return job;
    if (job.presetId === undefined) throw invalid(`Job ${jobId} has no preset to resolve a color setup from`);
    const preset = await this.getPreset(job.presetId);
    const revision = await this.publishedRevision(preset.colorSetupId);
    if (!revision) throw conflict(`Color setup ${preset.colorSetupId} has no published revision`);
    const pinned: Job = { ...job, colorSetupRevisionId: revision.id, updatedAt: this.now() };
    await jobs.save(pinned);
    return pinned;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private toMedium(id: string, input: MediumInput): Medium {
    return { id, name: input.name, attributes: input.attributes ?? {}, updatedAt: this.now() };
  }

  private async toPreset(id: string, input: PresetInput): Promise<Preset> {
    await this.checkMediumAndMode(input.mediumId, input.outputModeId);
    return {
      id,
      name: input.name,
      mediumId: input.mediumId,
      ...(input.outputModeId !== undefined ? { outputModeId: input.outputModeId } : {}),
      colorSetupId: input.colorSetupId,
    };
  }

  private async checkMediumAndMode(mediumId: string, outputModeId: string | undefined): Promise<void> {
    if (!(await this.deps.stores.media.get(mediumId))) throw invalid(`Unknown medium ${mediumId}`);
    if (outputModeId !== undefined && !(await this.deps.stores.modes.get(mediumId, outputModeId))) {
      throw invalid(`Unknown output mode ${outputModeId} on medium ${mediumId}`);
    }
  }
}
