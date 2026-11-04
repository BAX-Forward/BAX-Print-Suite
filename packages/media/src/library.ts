import {
  type ColorDefaults,
  type ColorSetup,
  type ColorSetupContent,
  type ColorSetupRevisionRecord,
  ConflictError,
  DEVICE_MEDIUM_FIELDS,
  type JobColorBinding,
  type Medium,
  type MediumForm,
  MediumInUseError,
  type MediumKind,
  type MediumSides,
  NotFoundError,
  type OutputMode,
  type Preset,
  type PresetSelection,
  type ProfileFormat,
  type ProfileProvenance,
  type ProfileRecord,
  type StoredProfileRef,
  type RenderingIntent,
  ValidationError,
  type VerificationThresholds,
  canonicalJson,
  isRenderingIntent,
} from '@bax-print/core';
import { type MediaContext, type ResolvedMediaContext, resolveContext } from './context.js';
import type { ColorSetupPublishedEvent } from './events.js';
import { sha256Hex } from './hash.js';
import { type RevisionInput, buildRevision, moveHead } from './revisions.js';
import {
  normalizeColorants,
  normalizeForm,
  normalizeKind,
  normalizeSides,
  normalizeThresholds,
  normalizeWidths,
  optionalPositive,
  requireText,
} from './validate.js';

/** ICC.1 rendering intent 0, the profile header default. */
export const DEFAULT_RENDERING_INTENT: RenderingIntent = 'perceptual';
export const ICC_MEDIA_TYPE = 'application/vnd.iccprofile';

export interface MediumInput {
  name: string;
  /** Free-text tag, or a tag with an explicit controlled term. */
  kind: string | MediumKind;
  widthsMm?: number[];
  thicknessUm?: number;
  form?: MediumForm;
  sides?: MediumSides;
}
export type MediumPatch = Partial<MediumInput>;

export interface RevisionRequest {
  content: ColorSetupContent;
  author: string;
  reason: string;
  /** Optimistic concurrency: refuse the edit when the head moved meanwhile. */
  expectedHeadRevisionId?: string;
  source?: ColorSetupRevisionRecord['source'];
}

export interface PresetInput {
  name: string;
  mediumId: string;
  outputModeId: string;
  renderingIntent?: RenderingIntent;
  pinnedRevisionId?: string;
  verification?: Partial<VerificationThresholds>;
}

export interface PresetPatch {
  name?: string;
  renderingIntent?: RenderingIntent | null;
  pinnedRevisionId?: string | null;
  verification?: Partial<VerificationThresholds>;
}

export interface ProfileInput {
  description: string;
  format: ProfileFormat;
  mediaType?: string;
  colorants: string[];
  provenance: ProfileProvenance;
}

export interface JobColor {
  binding: JobColorBinding;
  revision: ColorSetupRevisionRecord;
}

/** Content of a setup no one has characterized yet, seeded from device-suggested defaults. */
export function contentFromDefaults(defaults: ColorDefaults | undefined): ColorSetupContent {
  const content: ColorSetupContent = {
    level: 'uncharacterized',
    renderingIntent: defaults?.renderingIntent ?? DEFAULT_RENDERING_INTENT,
  };
  if (defaults?.tacLimitPercent !== undefined) content.tacLimitPercent = defaults.tacLimitPercent;
  if (defaults?.channelLimitsPercent !== undefined) content.channelLimitsPercent = { ...defaults.channelLimitsPercent };
  return content;
}

/** FR7: a preset chosen on the job (Spec 007) wins over the hot-folder ticket template (Spec 001). */
export function choosePresetId(job?: PresetSelection, hotFolder?: PresetSelection): string | undefined {
  return job?.presetId ?? hotFolder?.presetId;
}

export function mediumFields(input: MediumInput): Pick<Medium, 'name' | 'kind' | 'widthsMm' | 'form' | 'sides'> &
  Partial<Pick<Medium, 'thicknessUm'>> {
  const fields: Pick<Medium, 'name' | 'kind' | 'widthsMm' | 'form' | 'sides'> & Partial<Pick<Medium, 'thicknessUm'>> = {
    name: requireText(input.name, 'name'),
    kind: normalizeKind(input.kind),
    widthsMm: normalizeWidths(input.widthsMm),
    form: normalizeForm(input.form),
    sides: normalizeSides(input.sides),
  };
  const thickness = optionalPositive(input.thicknessUm, 'thicknessUm');
  if (thickness !== undefined) fields.thicknessUm = thickness;
  return fields;
}

/** ICC.1 §7.2: the header declares the profile size and carries the `acsp` file signature. */
function assertIccHeader(bytes: Uint8Array): void {
  if (bytes.length < 128) throw new ValidationError('an ICC profile is at least 128 bytes');
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const signature = String.fromCharCode(...bytes.subarray(36, 40));
  if (signature !== 'acsp') throw new ValidationError('not an ICC profile: missing acsp signature');
  if (declared !== bytes.length) throw new ValidationError(`ICC header declares ${declared} bytes, got ${bytes.length}`);
}

export class MediaLibrary {
  readonly ctx: ResolvedMediaContext;

  constructor(ctx: MediaContext) {
    this.ctx = resolveContext(ctx);
  }

  private get repo() {
    return this.ctx.repo;
  }

  // ---- Media (FR1)

  getMedium(id: string): Medium {
    const medium = this.repo.getMedium(id);
    if (!medium) throw new NotFoundError('medium', id);
    return medium;
  }

  listMedia(options: { includeArchived?: boolean } = {}): Medium[] {
    return this.repo.listMedia(options);
  }

  createMedium(input: MediumInput): Medium {
    const at = this.ctx.now();
    const medium: Medium = {
      id: this.ctx.newId(),
      ...mediumFields(input),
      archived: false,
      source: 'user',
      userOverrides: [],
      createdAt: at,
      updatedAt: at,
    };
    this.repo.insertMedium(medium);
    return medium;
  }

  /** Device-fields the user changes on a device medium are remembered so a sync never overwrites them. */
  updateMedium(id: string, patch: MediumPatch): Medium {
    return this.repo.transaction(() => {
      const current = this.getMedium(id);
      const next: Medium = { ...current };
      if (patch.name !== undefined) next.name = requireText(patch.name, 'name');
      if (patch.kind !== undefined) next.kind = normalizeKind(patch.kind);
      if (patch.widthsMm !== undefined) next.widthsMm = normalizeWidths(patch.widthsMm);
      if (patch.thicknessUm !== undefined) next.thicknessUm = optionalPositive(patch.thicknessUm, 'thicknessUm');
      if (patch.form !== undefined) next.form = normalizeForm(patch.form);
      if (patch.sides !== undefined) next.sides = normalizeSides(patch.sides);
      const changed = DEVICE_MEDIUM_FIELDS.filter((f) => canonicalJson(current[f]) !== canonicalJson(next[f]));
      if (changed.length === 0) return current;
      next.userOverrides = current.deviceRef ? [...new Set([...current.userOverrides, ...changed])] : current.userOverrides;
      next.updatedAt = this.ctx.now();
      this.repo.updateMedium(next);
      return next;
    });
  }

  renameMedium(id: string, name: string): Medium {
    return this.updateMedium(id, { name });
  }

  /** Archived media are hidden from pickers but stay resolvable by id. */
  setArchived(id: string, archived: boolean): Medium {
    return this.repo.transaction(() => {
      const current = this.getMedium(id);
      if (current.archived === archived) return current;
      const next: Medium = { ...current, archived, updatedAt: this.ctx.now() };
      this.repo.updateMedium(next);
      return next;
    });
  }

  /**
   * Copies the medium, its modes and each color setup head. Every cloned setup starts a fresh
   * revision chain whose first revision records where its content came from.
   */
  cloneMedium(id: string, options: { name?: string; author: string }): Medium {
    const author = requireText(options.author, 'author');
    const { medium, events } = this.repo.transaction(() => {
      const source = this.getMedium(id);
      const at = this.ctx.now();
      const { deviceRef: _deviceRef, clonedFrom: _clonedFrom, ...rest } = structuredClone(source);
      const clone: Medium = {
        ...rest,
        id: this.ctx.newId(),
        name: options.name === undefined ? `${source.name} (copy)` : requireText(options.name, 'name'),
        archived: false,
        source: 'user',
        userOverrides: [],
        clonedFrom: { mediumId: source.id },
        createdAt: at,
        updatedAt: at,
      };
      this.repo.insertMedium(clone);
      const published: ColorSetupPublishedEvent[] = [];
      for (const mode of this.repo.listOutputModes(source.id)) {
        const copy: OutputMode = { ...structuredClone(mode), id: this.ctx.newId(), mediumId: clone.id, createdAt: at, updatedAt: at };
        this.repo.insertOutputMode(copy);
        const setup = this.repo.getColorSetupByOutputMode(mode.id);
        if (!setup) continue;
        const origin = { colorSetupId: setup.id, revisionId: setup.headRevisionId };
        const created = this.createColorSetup(
          copy,
          {
            authorKind: 'user',
            author,
            reason: `cloned from ${source.name}`,
            content: structuredClone(setup.content),
            origin,
          },
          origin,
        );
        published.push(this.publishedEvent(created.revision));
      }
      return { medium: clone, events: published };
    });
    events.forEach(this.ctx.emit);
    return medium;
  }

  /** Refused with `MediumInUseError` while any job references the medium. */
  deleteMedium(id: string): void {
    this.repo.transaction(() => {
      this.getMedium(id);
      const jobCount = this.repo.countJobBindingsForMedium(id) + this.ctx.countJobReferences(id);
      if (jobCount > 0) throw new MediumInUseError(id, jobCount);
      this.repo.deleteMedium(id);
    });
  }

  // ---- Output modes (FR2). Modes only come from device reports, clones and imports.

  getOutputMode(id: string): OutputMode {
    const mode = this.repo.getOutputMode(id);
    if (!mode) throw new NotFoundError('output mode', id);
    return mode;
  }

  listModes(mediumId: string, options: { includeHidden?: boolean } = {}): OutputMode[] {
    this.getMedium(mediumId);
    const modes = this.repo.listOutputModes(mediumId);
    return options.includeHidden ? modes : modes.filter((m) => !m.hidden);
  }

  setModeHidden(modeId: string, hidden: boolean): OutputMode {
    return this.repo.transaction(() => {
      const mode = this.getOutputMode(modeId);
      if (mode.hidden === hidden) return mode;
      const next: OutputMode = { ...mode, hidden, updatedAt: this.ctx.now() };
      this.repo.updateOutputMode(next);
      return next;
    });
  }

  // ---- Color setups and revisions (FR6)

  getColorSetup(id: string): ColorSetup {
    const setup = this.repo.getColorSetup(id);
    if (!setup) throw new NotFoundError('color setup', id);
    return setup;
  }

  getColorSetupForMode(outputModeId: string): ColorSetup {
    const setup = this.repo.getColorSetupByOutputMode(outputModeId);
    if (!setup) throw new NotFoundError('color setup for output mode', outputModeId);
    return setup;
  }

  listColorSetups(mediumId: string): ColorSetup[] {
    this.getMedium(mediumId);
    return this.repo.listColorSetups(mediumId);
  }

  listRevisions(colorSetupId: string): ColorSetupRevisionRecord[] {
    this.getColorSetup(colorSetupId);
    return this.repo.listRevisions(colorSetupId);
  }

  getRevision(id: string): ColorSetupRevisionRecord {
    const revision = this.repo.getRevision(id);
    if (!revision) throw new NotFoundError('color setup revision', id);
    return revision;
  }

  /** Creates the setup for a mode with its first revision. Callers provide the transaction. */
  createColorSetup(
    mode: OutputMode,
    first: RevisionInput,
    origin?: ColorSetup['origin'],
  ): { setup: ColorSetup; revision: ColorSetupRevisionRecord } {
    const at = this.ctx.now();
    const empty: ColorSetup = {
      id: this.ctx.newId(),
      mediumId: mode.mediumId,
      outputModeId: mode.id,
      headRevisionId: null,
      content: first.content,
      revisionCount: 0,
      userRevisionCount: 0,
      createdAt: at,
      updatedAt: at,
    };
    if (origin) empty.origin = { ...origin };
    const revision = buildRevision(empty, first, this.ctx.newId(), at);
    const setup = moveHead(empty, revision);
    this.repo.insertColorSetup(setup);
    this.repo.appendRevision(revision);
    return { setup, revision };
  }

  /** Appends a revision and moves the head. Callers provide the transaction and emit the event. */
  commitRevision(
    colorSetupId: string,
    input: RevisionInput,
    expectedHeadRevisionId?: string,
  ): { setup: ColorSetup; revision: ColorSetupRevisionRecord } {
    const current = this.getColorSetup(colorSetupId);
    if (expectedHeadRevisionId !== undefined && current.headRevisionId !== expectedHeadRevisionId) {
      throw new ConflictError(`color setup ${colorSetupId} head moved to ${String(current.headRevisionId)}`, {
        expected: expectedHeadRevisionId,
        actual: current.headRevisionId,
      });
    }
    const revision = buildRevision(current, input, this.ctx.newId(), this.ctx.now());
    const setup = moveHead(current, revision);
    this.repo.appendRevision(revision);
    this.repo.updateColorSetup(setup);
    return { setup, revision };
  }

  /** A user edit: always a new revision, never an in-place change. */
  addRevision(colorSetupId: string, request: RevisionRequest): { setup: ColorSetup; revision: ColorSetupRevisionRecord } {
    const result = this.repo.transaction(() =>
      this.commitRevision(
        colorSetupId,
        {
          authorKind: 'user',
          author: request.author,
          reason: request.reason,
          content: request.content,
          source: request.source,
        },
        request.expectedHeadRevisionId,
      ),
    );
    this.ctx.emit(this.publishedEvent(result.revision));
    return result;
  }

  publishedEvent(revision: ColorSetupRevisionRecord): ColorSetupPublishedEvent {
    const event: ColorSetupPublishedEvent = {
      type: 'colorsetup.published',
      subject: revision.colorSetupId,
      data: {
        colorSetupId: revision.colorSetupId,
        revisionId: revision.id,
        seq: revision.seq,
        authorKind: revision.authorKind,
      },
    };
    if (revision.source?.profilingSessionId) event.data.profilingSessionId = revision.source.profilingSessionId;
    return event;
  }

  // ---- Profiles

  /** Stores profile bytes by SHA-256 (idempotent) and returns a reference for color setups. */
  addProfile(bytes: Uint8Array, input: ProfileInput): StoredProfileRef {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new ValidationError('profile bytes must not be empty');
    if (input.format !== 'icc' && input.format !== 'other') throw new ValidationError('format must be icc or other');
    if (input.format === 'icc') assertIccHeader(bytes);
    const provenance = input.provenance;
    if (!provenance || typeof provenance.redistributable !== 'boolean') {
      throw new ValidationError('provenance must state source, license and redistributable');
    }
    const ref: StoredProfileRef = {
      sha256: sha256Hex(bytes),
      description: requireText(input.description, 'description'),
      format: input.format,
      mediaType: input.mediaType === undefined ? ICC_MEDIA_TYPE : requireText(input.mediaType, 'mediaType'),
      colorants: normalizeColorants(input.colorants),
      provenance: {
        source: requireText(provenance.source, 'provenance.source'),
        license: requireText(provenance.license, 'provenance.license'),
        redistributable: provenance.redistributable,
      },
    };
    const record: ProfileRecord = { ...ref, sizeBytes: bytes.length, createdAt: this.ctx.now() };
    this.repo.putProfile(record, bytes);
    return this.toProfileRef(this.repo.getProfile(ref.sha256) ?? record);
  }

  toProfileRef(record: ProfileRecord): StoredProfileRef {
    const { sizeBytes: _size, createdAt: _created, ...ref } = record;
    return ref;
  }

  // ---- Presets (FR7)

  getPreset(id: string): Preset {
    const preset = this.repo.getPreset(id);
    if (!preset) throw new NotFoundError('preset', id);
    return preset;
  }

  listPresets(options: { mediumId?: string } = {}): Preset[] {
    const presets = this.repo.listPresets();
    return options.mediumId === undefined ? presets : presets.filter((p) => p.mediumId === options.mediumId);
  }

  createPreset(input: PresetInput): Preset {
    return this.repo.transaction(() => {
      this.getMedium(input.mediumId);
      const mode = this.getOutputMode(input.outputModeId);
      if (mode.mediumId !== input.mediumId) throw new ValidationError('the output mode belongs to another medium');
      const setup = this.getColorSetupForMode(mode.id);
      const at = this.ctx.now();
      const preset: Preset = {
        id: this.ctx.newId(),
        name: requireText(input.name, 'name'),
        mediumId: input.mediumId,
        outputModeId: mode.id,
        colorSetupId: setup.id,
        verification: normalizeThresholds(input.verification),
        createdAt: at,
        updatedAt: at,
      };
      if (input.renderingIntent !== undefined) preset.renderingIntent = this.intent(input.renderingIntent);
      if (input.pinnedRevisionId !== undefined) preset.pinnedRevisionId = this.pinnable(setup.id, input.pinnedRevisionId);
      this.repo.insertPreset(preset);
      return preset;
    });
  }

  updatePreset(id: string, patch: PresetPatch): Preset {
    return this.repo.transaction(() => {
      const current = this.getPreset(id);
      const next: Preset = { ...current, updatedAt: this.ctx.now() };
      if (patch.name !== undefined) next.name = requireText(patch.name, 'name');
      if (patch.renderingIntent === null) delete next.renderingIntent;
      else if (patch.renderingIntent !== undefined) next.renderingIntent = this.intent(patch.renderingIntent);
      if (patch.pinnedRevisionId === null) delete next.pinnedRevisionId;
      else if (patch.pinnedRevisionId !== undefined) next.pinnedRevisionId = this.pinnable(current.colorSetupId, patch.pinnedRevisionId);
      if (patch.verification !== undefined) next.verification = normalizeThresholds(patch.verification, current.verification);
      this.repo.updatePreset(next);
      return next;
    });
  }

  deletePreset(id: string): void {
    this.getPreset(id);
    this.repo.deletePreset(id);
  }

  private intent(value: unknown): RenderingIntent {
    if (!isRenderingIntent(value)) throw new ValidationError('renderingIntent is not an ICC rendering intent');
    return value;
  }

  private pinnable(colorSetupId: string, revisionId: string): string {
    const revision = this.getRevision(revisionId);
    if (revision.colorSetupId !== colorSetupId) throw new ValidationError('the pinned revision belongs to another color setup');
    return revision.id;
  }

  // ---- Job binding (FR6). Recorded once at the render step; later revisions never change it.

  bindJobColor(input: { jobId: string; presetId: string }): JobColorBinding {
    const jobId = requireText(input.jobId, 'jobId');
    return this.repo.transaction(() => {
      const existing = this.repo.getJobBinding(jobId);
      if (existing) {
        if (existing.presetId !== input.presetId) {
          throw new ConflictError(`job ${jobId} is already bound to preset ${existing.presetId}`);
        }
        return existing;
      }
      const preset = this.getPreset(input.presetId);
      const setup = this.getColorSetup(preset.colorSetupId);
      const revisionId = preset.pinnedRevisionId ?? setup.headRevisionId;
      if (revisionId === null) throw new ValidationError(`color setup ${setup.id} has no revision`);
      const revision = this.getRevision(revisionId);
      const binding: JobColorBinding = {
        jobId,
        presetId: preset.id,
        mediumId: preset.mediumId,
        outputModeId: preset.outputModeId,
        colorSetupId: setup.id,
        colorSetupRevisionId: revision.id,
        renderingIntent: preset.renderingIntent ?? revision.content.renderingIntent,
        boundAt: this.ctx.now(),
      };
      this.repo.insertJobBinding(binding);
      return binding;
    });
  }

  /** What the render step's ColorEngine consumes: the bound revision, not the current head. */
  getJobColor(jobId: string): JobColor {
    const binding = this.repo.getJobBinding(jobId);
    if (!binding) throw new NotFoundError('job color binding', jobId);
    return { binding, revision: this.getRevision(binding.colorSetupRevisionId) };
  }
}
