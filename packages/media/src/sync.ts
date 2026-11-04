import {
  type ColorDefaults,
  DEVICE_MEDIUM_FIELDS,
  DEVICE_MODE_FIELDS,
  type DeviceMediumField,
  type DeviceModeField,
  type Medium,
  type OutputMode,
  ValidationError,
  canonicalJson,
  isRenderingIntent,
} from '@bax-print/core';
import {
  type DeviceMediumReport,
  type OutputModeReport,
  type PrinterDriverMediaApi,
  checkOutputModeReport,
} from '@bax-print/plugin-sdk';
import type { ColorSetupPublishedEvent, MediaSyncedEvent } from './events.js';
import { contentHash } from './hash.js';
import { type MediaLibrary, contentFromDefaults } from './library.js';
import { normalizeContent } from './revisions.js';
import {
  isFiniteNumber,
  normalizeForm,
  normalizeKind,
  normalizeSides,
  normalizeWidths,
  optionalPositive,
  requireText,
} from './validate.js';

export type SyncConflictKind = 'medium-field' | 'mode-field' | 'color-defaults' | 'mode-missing';

/** A device change that was not applied; the user resolves it with `resolveSyncConflict`. */
export interface SyncConflict {
  kind: SyncConflictKind;
  deviceProfile: string;
  mediumId: string;
  outputModeId?: string;
  colorSetupId?: string;
  field?: string;
  localValue?: unknown;
  deviceValue?: unknown;
  reason: string;
}

export interface SyncReport {
  deviceProfile: string;
  mediaCreated: string[];
  mediaUpdated: string[];
  modesCreated: string[];
  modesUpdated: string[];
  setupsUpdated: string[];
  conflicts: SyncConflict[];
}

export type SyncResolution = 'accept-device' | 'keep-local';

type DeviceMediumFields = Partial<Pick<Medium, DeviceMediumField>>;
type DeviceModeFields = Pick<OutputMode, Exclude<DeviceModeField, 'colorDefaults'>> & { colorDefaults?: ColorDefaults };

interface DeviceSnapshot {
  medium: DeviceMediumReport;
  modes: OutputModeReport[];
}

const SYNC_AUTHOR = 'device-sync';

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function normalizeMediumField(field: DeviceMediumField, value: unknown): unknown {
  switch (field) {
    case 'name':
      return requireText(value, 'name');
    case 'kind':
      return normalizeKind(value);
    case 'widthsMm':
      return normalizeWidths(value);
    case 'thicknessUm':
      return optionalPositive(value, 'thicknessUm');
    case 'form':
      return normalizeForm(value);
    case 'sides':
      return normalizeSides(value);
  }
}

/** Only the fields the device actually reported; unreported fields keep their local value. */
function deviceMediumFields(report: DeviceMediumReport): DeviceMediumFields {
  const fields: DeviceMediumFields = { name: requireText(report.name, 'name') };
  if (report.kind !== undefined) fields.kind = normalizeKind(report.kind);
  if (report.widthsMm !== undefined) fields.widthsMm = normalizeWidths(report.widthsMm);
  if (report.thicknessUm !== undefined) fields.thicknessUm = optionalPositive(report.thicknessUm, 'thicknessUm');
  if (report.form !== undefined) fields.form = normalizeForm(report.form);
  if (report.sides !== undefined) fields.sides = normalizeSides(report.sides);
  return fields;
}

function normalizeColorDefaults(defaults: OutputModeReport['colorDefaults']): ColorDefaults | undefined {
  if (defaults === undefined) return undefined;
  const out: ColorDefaults = {};
  if (defaults.renderingIntent !== undefined) {
    if (!isRenderingIntent(defaults.renderingIntent)) throw new ValidationError('colorDefaults.renderingIntent is invalid');
    out.renderingIntent = defaults.renderingIntent;
  }
  if (defaults.tacLimitPercent !== undefined) {
    if (!isFiniteNumber(defaults.tacLimitPercent) || defaults.tacLimitPercent <= 0) {
      throw new ValidationError('colorDefaults.tacLimitPercent must be positive');
    }
    out.tacLimitPercent = defaults.tacLimitPercent;
  }
  if (defaults.channelLimitsPercent !== undefined) out.channelLimitsPercent = { ...defaults.channelLimitsPercent };
  return Object.keys(out).length === 0 ? undefined : out;
}

function deviceModeFields(report: OutputModeReport, where: string): DeviceModeFields {
  const failures = checkOutputModeReport(report, where);
  if (failures.length > 0) throw new ValidationError(`device reported an invalid mode: ${failures.join('; ')}`);
  const fields: DeviceModeFields = {
    name: report.name.trim(),
    resolutionDpi: { x: report.resolutionDpi.x, y: report.resolutionDpi.y },
    passes: report.passes,
    inkSet: [...report.inkSet],
    direction: report.direction,
    params: structuredClone(report.params ?? {}),
  };
  const defaults = normalizeColorDefaults(report.colorDefaults);
  if (defaults) fields.colorDefaults = defaults;
  return fields;
}

function withModeFields(mode: OutputMode, fields: DeviceModeFields, at: string): OutputMode {
  const { colorDefaults: _previous, ...rest } = mode;
  const next: OutputMode = { ...rest, ...fields, updatedAt: at };
  return next;
}

function modeToReport(mode: OutputMode): OutputModeReport {
  const report: OutputModeReport = {
    modeKey: mode.modeKey,
    name: mode.name,
    resolutionDpi: mode.resolutionDpi,
    passes: mode.passes,
    inkSet: mode.inkSet,
    direction: mode.direction,
    params: mode.params,
  };
  if (mode.colorDefaults) report.colorDefaults = mode.colorDefaults;
  return report;
}

class SyncRun {
  readonly report: SyncReport;
  readonly events: ColorSetupPublishedEvent[] = [];

  constructor(
    private readonly library: MediaLibrary,
    private readonly deviceProfile: string,
    private readonly modesSupported: boolean,
  ) {
    this.report = {
      deviceProfile,
      mediaCreated: [],
      mediaUpdated: [],
      modesCreated: [],
      modesUpdated: [],
      setupsUpdated: [],
      conflicts: [],
    };
  }

  private get ctx() {
    return this.library.ctx;
  }

  apply(snapshot: DeviceSnapshot): void {
    const medium = this.applyMedium(snapshot.medium);
    if (!this.modesSupported) return;
    const reported = new Set<string>();
    snapshot.modes.forEach((report, i) => {
      reported.add(report.modeKey);
      this.applyMode(medium, deviceModeFields(report, `listModes(${snapshot.medium.mediumKey})[${i}]`), report.modeKey);
    });
    for (const mode of this.ctx.repo.listOutputModes(medium.id)) {
      if (mode.deviceProfile !== this.deviceProfile || mode.hidden || reported.has(mode.modeKey)) continue;
      this.report.conflicts.push({
        kind: 'mode-missing',
        deviceProfile: this.deviceProfile,
        mediumId: medium.id,
        outputModeId: mode.id,
        reason: `the device no longer reports mode ${mode.modeKey}`,
      });
    }
  }

  private applyMedium(report: DeviceMediumReport): Medium {
    const fields = deviceMediumFields(report);
    const existing = this.ctx.repo.findMediumByDeviceRef(this.deviceProfile, report.mediumKey);
    const at = this.ctx.now();
    if (!existing) {
      const medium: Medium = {
        id: this.ctx.newId(),
        name: fields.name ?? report.mediumKey,
        kind: fields.kind ?? { tag: 'unspecified' },
        widthsMm: fields.widthsMm ?? [],
        form: fields.form ?? 'roll',
        sides: fields.sides ?? 1,
        archived: false,
        source: 'device',
        deviceRef: { deviceProfile: this.deviceProfile, mediumKey: report.mediumKey },
        userOverrides: [],
        createdAt: at,
        updatedAt: at,
      };
      if (fields.thicknessUm !== undefined) medium.thicknessUm = fields.thicknessUm;
      this.ctx.repo.insertMedium(medium);
      this.report.mediaCreated.push(medium.id);
      return medium;
    }
    const next: Medium = { ...existing };
    let changed = false;
    for (const field of DEVICE_MEDIUM_FIELDS) {
      if (!(field in fields) || same(existing[field], fields[field])) continue;
      if (existing.userOverrides.includes(field)) {
        this.report.conflicts.push({
          kind: 'medium-field',
          deviceProfile: this.deviceProfile,
          mediumId: existing.id,
          field,
          localValue: existing[field],
          deviceValue: fields[field],
          reason: `the user changed ${field}`,
        });
        continue;
      }
      Object.assign(next, { [field]: fields[field] });
      changed = true;
    }
    if (changed) {
      next.updatedAt = at;
      this.ctx.repo.updateMedium(next);
      this.report.mediaUpdated.push(existing.id);
    }
    return changed ? next : existing;
  }

  private applyMode(medium: Medium, fields: DeviceModeFields, modeKey: string): void {
    const repo = this.ctx.repo;
    const at = this.ctx.now();
    const existing = repo.findOutputMode(medium.id, this.deviceProfile, modeKey);
    if (!existing) {
      const mode: OutputMode = {
        id: this.ctx.newId(),
        mediumId: medium.id,
        deviceProfile: this.deviceProfile,
        modeKey,
        ...fields,
        hidden: false,
        createdAt: at,
        updatedAt: at,
      };
      repo.insertOutputMode(mode);
      const { revision } = this.library.createColorSetup(mode, {
        authorKind: 'device',
        author: SYNC_AUTHOR,
        reason: 'created from device report',
        content: contentFromDefaults(fields.colorDefaults),
      });
      this.events.push(this.library.publishedEvent(revision));
      this.report.modesCreated.push(mode.id);
      return;
    }

    const differing = DEVICE_MODE_FIELDS.filter((f) => !same(existing[f], fields[f]));
    if (differing.length === 0) return;
    const setup = repo.getColorSetupByOutputMode(existing.id);

    // FR3: a setup with a user revision is never overwritten, and neither is the mode it was characterized on.
    if (setup && setup.userRevisionCount > 0) {
      for (const field of differing) {
        this.report.conflicts.push({
          kind: field === 'colorDefaults' ? 'color-defaults' : 'mode-field',
          deviceProfile: this.deviceProfile,
          mediumId: medium.id,
          outputModeId: existing.id,
          colorSetupId: setup.id,
          field,
          localValue: existing[field],
          deviceValue: fields[field],
          reason: 'the color setup of this mode has user revisions',
        });
      }
      return;
    }

    repo.updateOutputMode(withModeFields(existing, fields, at));
    this.report.modesUpdated.push(existing.id);
    if (!differing.includes('colorDefaults')) return;
    const content = contentFromDefaults(fields.colorDefaults);
    if (setup && setup.content && contentHash(normalizeContent(content)) === contentHash(setup.content)) return;
    const result = setup
      ? this.library.commitRevision(setup.id, {
          authorKind: 'device',
          author: SYNC_AUTHOR,
          reason: 'device defaults changed',
          content,
        })
      : this.library.createColorSetup(existing, {
          authorKind: 'device',
          author: SYNC_AUTHOR,
          reason: 'created from device report',
          content,
        });
    this.events.push(this.library.publishedEvent(result.revision));
    this.report.setupsUpdated.push(result.setup.id);
  }
}

/**
 * FR3 "refresh from device": device-provided fields update; anything the user edited is kept and
 * reported as a conflict. Reads the driver first, then applies everything in one transaction.
 */
export async function syncFromDevice(
  library: MediaLibrary,
  deviceProfile: string,
  driver: PrinterDriverMediaApi,
): Promise<SyncReport> {
  const profile = requireText(deviceProfile, 'deviceProfile');
  const media = await driver.listMedia();
  if (!Array.isArray(media)) throw new ValidationError('listMedia() must return an array');
  const keys = new Set<string>();
  const snapshots: DeviceSnapshot[] = [];
  for (const medium of media) {
    const key = requireText(medium.mediumKey, 'mediumKey');
    if (keys.has(key)) throw new ValidationError(`device reported medium ${key} twice`);
    keys.add(key);
    const modes = driver.listModes ? await driver.listModes(key) : [];
    if (new Set(modes.map((m) => m.modeKey)).size !== modes.length) {
      throw new ValidationError(`device reported duplicate mode keys for medium ${key}`);
    }
    snapshots.push({ medium, modes });
  }

  const run = new SyncRun(library, profile, driver.listModes !== undefined);
  library.ctx.repo.transaction(() => snapshots.forEach((s) => run.apply(s)));

  run.events.forEach(library.ctx.emit);
  const { report } = run;
  const synced: MediaSyncedEvent = {
    type: 'media.synced',
    subject: profile,
    data: {
      deviceProfile: profile,
      mediaCreated: report.mediaCreated.length,
      mediaUpdated: report.mediaUpdated.length,
      modesCreated: report.modesCreated.length,
      modesUpdated: report.modesUpdated.length,
      setupsUpdated: report.setupsUpdated.length,
      conflicts: report.conflicts.length,
    },
  };
  library.ctx.emit(synced);
  return report;
}

/**
 * Applies the user's choice for one conflict. `keep-local` changes nothing. `accept-device`
 * writes the device value; for color defaults that is a new user revision, never an overwrite.
 * The conflict comes from a client, so every value is validated again.
 */
export function resolveSyncConflict(
  library: MediaLibrary,
  conflict: SyncConflict,
  resolution: SyncResolution,
  author: string,
): { applied: boolean } {
  if (resolution !== 'accept-device' && resolution !== 'keep-local') {
    throw new ValidationError('resolution must be accept-device or keep-local');
  }
  const who = requireText(author, 'author');
  if (resolution === 'keep-local') return { applied: false };
  const ctx = library.ctx;

  switch (conflict.kind) {
    case 'medium-field': {
      const field = conflict.field as DeviceMediumField;
      if (!(DEVICE_MEDIUM_FIELDS as readonly string[]).includes(field)) throw new ValidationError('unknown medium field');
      ctx.repo.transaction(() => {
        const medium = library.getMedium(conflict.mediumId);
        const next: Medium = {
          ...medium,
          [field]: normalizeMediumField(field, conflict.deviceValue),
          userOverrides: medium.userOverrides.filter((f) => f !== field),
          updatedAt: ctx.now(),
        };
        ctx.repo.updateMedium(next);
      });
      return { applied: true };
    }
    case 'mode-field':
    case 'color-defaults': {
      const field = conflict.field as DeviceModeField;
      if (!(DEVICE_MODE_FIELDS as readonly string[]).includes(field)) throw new ValidationError('unknown mode field');
      const outputModeId = requireText(conflict.outputModeId, 'outputModeId');
      const event = ctx.repo.transaction(() => {
        const mode = library.getOutputMode(outputModeId);
        const proposed = { ...modeToReport(mode), [field]: conflict.deviceValue } as OutputModeReport;
        const fields = deviceModeFields(proposed, 'conflict.deviceValue');
        const merged = { ...deviceModeFields(modeToReport(mode), 'local mode'), [field]: fields[field] } as DeviceModeFields;
        if (field === 'colorDefaults' && fields.colorDefaults === undefined) delete merged.colorDefaults;
        ctx.repo.updateOutputMode(withModeFields(mode, merged, ctx.now()));
        if (field !== 'colorDefaults') return undefined;
        const setup = library.getColorSetupForMode(mode.id);
        const defaults = fields.colorDefaults;
        const content = { ...setup.content };
        if (defaults?.renderingIntent !== undefined) content.renderingIntent = defaults.renderingIntent;
        if (defaults?.tacLimitPercent !== undefined) content.tacLimitPercent = defaults.tacLimitPercent;
        if (defaults?.channelLimitsPercent !== undefined) content.channelLimitsPercent = { ...defaults.channelLimitsPercent };
        const { revision } = library.commitRevision(setup.id, {
          authorKind: 'user',
          author: who,
          reason: 'accepted device color defaults',
          content,
        });
        return library.publishedEvent(revision);
      });
      if (event) ctx.emit(event);
      return { applied: true };
    }
    case 'mode-missing':
      library.setModeHidden(requireText(conflict.outputModeId, 'outputModeId'), true);
      return { applied: true };
    default:
      throw new ValidationError('unknown conflict kind');
  }
}
