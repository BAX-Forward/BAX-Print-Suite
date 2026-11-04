import type { RenderingIntent, StoredProfileRef } from './media-color.js';

/** Optional controlled vocabulary for `Medium.kind`. The free-text tag is always kept. */
export const MEDIUM_KIND_VOCABULARY = ['film', 'paper', 'textile', 'rigid', 'adhesive'] as const;
export type MediumKindTerm = (typeof MEDIUM_KIND_VOCABULARY)[number];

export function isMediumKindTerm(value: unknown): value is MediumKindTerm {
  return typeof value === 'string' && (MEDIUM_KIND_VOCABULARY as readonly string[]).includes(value);
}

export interface MediumKind {
  tag: string;
  term?: MediumKindTerm;
}

export type MediumForm = 'roll' | 'sheet';
export type MediumSides = 1 | 2;

/** Fields a device sync may update on a medium unless the user overrode them. */
export const DEVICE_MEDIUM_FIELDS = ['name', 'kind', 'widthsMm', 'thicknessUm', 'form', 'sides'] as const;
export type DeviceMediumField = (typeof DEVICE_MEDIUM_FIELDS)[number];

export interface DeviceRef {
  /** Opaque capability-profile identifier reported by the PrinterDriver. */
  deviceProfile: string;
  mediumKey: string;
}

export interface Medium {
  id: string;
  name: string;
  kind: MediumKind;
  widthsMm: number[];
  thicknessUm?: number;
  form: MediumForm;
  sides: MediumSides;
  archived: boolean;
  source: 'user' | 'device' | 'import';
  /** Set for media that came from a device sync. */
  deviceRef?: DeviceRef;
  /** Device fields the user changed; a device sync reports a conflict instead of overwriting them. */
  userOverrides: DeviceMediumField[];
  clonedFrom?: { mediumId: string };
  createdAt: string;
  updatedAt: string;
}

export type PrintDirection = 'unidirectional' | 'bidirectional';

/** Device-suggested color defaults for a mode; applied only to setups the user never edited. */
export interface ColorDefaults {
  renderingIntent?: RenderingIntent;
  tacLimitPercent?: number;
  channelLimitsPercent?: Record<string, number>;
}

/** Fields of an output mode that come from the device and are compared on sync. */
export const DEVICE_MODE_FIELDS = [
  'name',
  'resolutionDpi',
  'passes',
  'inkSet',
  'direction',
  'params',
  'colorDefaults',
] as const;
export type DeviceModeField = (typeof DEVICE_MODE_FIELDS)[number];

/**
 * A device-declared way of printing a medium. Core never interprets `params`.
 * Modes are only created from device reports (or copied by clone/import), never invented.
 */
export interface OutputMode {
  id: string;
  mediumId: string;
  deviceProfile: string;
  modeKey: string;
  name: string;
  resolutionDpi: { x: number; y: number };
  passes: number;
  inkSet: string[];
  direction: PrintDirection;
  params: Record<string, unknown>;
  colorDefaults?: ColorDefaults;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export const CHARACTERIZATION_LEVELS = ['uncharacterized', 'L1', 'L2', 'L3'] as const;
export type CharacterizationLevel = (typeof CHARACTERIZATION_LEVELS)[number];
export type ProfilingLevel = Exclude<CharacterizationLevel, 'uncharacterized'>;

export const LINEARIZATION_METRICS = ['de2000-from-paper', 'de76-from-paper'] as const;
export type LinearizationMetric = (typeof LINEARIZATION_METRICS)[number];

/** Per-channel 1-D tone curves sampled on a common input grid (0..1 → 0..1 device value). */
export interface LinearizationCurves {
  metric: LinearizationMetric;
  inputs: number[];
  channels: Record<string, number[]>;
}

export interface ColorSetupContent {
  level: CharacterizationLevel;
  renderingIntent: RenderingIntent;
  curves?: LinearizationCurves;
  /** Per-channel maximum in percent (L3). */
  channelLimitsPercent?: Record<string, number>;
  /** Total area coverage limit in percent of one full channel (300 = three channels at 100 %). */
  tacLimitPercent?: number;
  outputProfile?: StoredProfileRef;
}

/** The mutable head for one (medium, mode) pair. Jobs never reference it directly. */
export interface ColorSetup {
  id: string;
  mediumId: string;
  outputModeId: string;
  headRevisionId: string | null;
  /** Copy of the head revision content, for reads. */
  content: ColorSetupContent;
  revisionCount: number;
  userRevisionCount: number;
  origin?: { colorSetupId: string; revisionId: string | null };
  createdAt: string;
  updatedAt: string;
}

export type RevisionAuthorKind = 'user' | 'device' | 'system';

/**
 * Immutable, append-only snapshot of a ColorSetup as the media library stores it.
 * The archive's reprint view ({@link ColorSetupRevision}) is derived from it with the same id.
 */
export interface ColorSetupRevisionRecord {
  id: string;
  colorSetupId: string;
  seq: number;
  parentRevisionId: string | null;
  authorKind: RevisionAuthorKind;
  author: string;
  createdAt: string;
  reason: string;
  contentHash: string;
  content: ColorSetupContent;
  /** For the first revision of a cloned setup: where its content came from. */
  origin?: { colorSetupId: string; revisionId: string | null };
  source?: { profilingSessionId?: string; importedFrom?: string };
}

export interface VerificationThresholds {
  maxMeanDeltaE2000: number;
  maxP95DeltaE2000: number;
}

/** In line with commonly used ISO 12647-based proofing tolerances (Spec 005 FR4). */
export const DEFAULT_VERIFICATION_THRESHOLDS: VerificationThresholds = Object.freeze({
  maxMeanDeltaE2000: 2.0,
  maxP95DeltaE2000: 4.0,
});

export interface Preset {
  id: string;
  name: string;
  mediumId: string;
  outputModeId: string;
  colorSetupId: string;
  renderingIntent?: RenderingIntent;
  /** When set, jobs bind to this revision instead of the current head. */
  pinnedRevisionId?: string;
  verification: VerificationThresholds;
  createdAt: string;
  updatedAt: string;
}

/** Recorded once at a job's render step; later revisions never change it. */
export interface JobColorBinding {
  jobId: string;
  presetId: string;
  mediumId: string;
  outputModeId: string;
  colorSetupId: string;
  colorSetupRevisionId: string;
  renderingIntent: RenderingIntent;
  boundAt: string;
}

/** Preset selection carried by a hot-folder ticket template (Spec 001) or a job (Spec 007). */
export interface PresetSelection {
  presetId?: string;
}
