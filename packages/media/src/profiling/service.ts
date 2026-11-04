import {
  type ColorSetupContent,
  type ColorSetupRevisionRecord,
  ConflictError,
  LINEARIZATION_METRICS,
  type Lab,
  type MeasurementCondition,
  MeasurementConditionMismatchError,
  NotFoundError,
  PROFILING_STEP_ORDER,
  PluginUnavailableError,
  type StoredProfileRef,
  type ProfilingArtifactMeta,
  type ProfilingLevel,
  type ProfilingOptions,
  type ProfilingSession,
  type ProfilingState,
  type RenderingIntent,
  ValidationError,
  type VerificationThresholds,
  assertProfilingRewind,
  assertProfilingTransition,
  canonicalJson,
  isMeasurementCondition,
  isRenderingIntent,
} from '@bax-print/core';
import type { ColorEngineProfilingApi, MeasurementApi, ProfileData } from '@bax-print/plugin-sdk';
import type { StoredArtifact } from '@bax-print/store';
import { buildLinearization } from '../color/linearization.js';
import { type TacProposal, proposeTac } from '../color/tac.js';
import { curvesToText } from '../curves-text.js';
import type { ProfilingStepCompletedEvent } from '../events.js';
import { fromUtf8, sha256Hex, utf8 } from '../hash.js';
import type { MediaLibrary } from '../library.js';
import {
  type MeasurementSet,
  measurementsFromCgats,
  measurementsFromCxf,
  measurementsToCgats,
  resolveCondition,
} from '../measurements.js';
import { normalizeContent } from '../revisions.js';
import {
  type ChartLayout,
  buildCharacterizationChart,
  buildVerificationChart,
  chartFromCgats,
  chartToCgats,
  defaultGridLevels,
  measurementLayout,
} from '../targets/chart.js';
import { PDF_MEDIA_TYPE, chartToPdf } from '../targets/pdf.js';
import { normalizeThresholds, requireText } from '../validate.js';
import {
  type VerificationReport,
  coverageSamples,
  joinMeasurements,
  paperWhite,
  profilePatches,
  rampSamples,
  renderDeviceValues,
  selectVerificationReferences,
  verificationReport,
} from './analysis.js';

/** Plugins the workflow can use. Both are optional; steps that need a missing one fail typed. */
export interface ProfilingPlugins {
  colorEngine?: ColorEngineProfilingApi;
  measurement?: MeasurementApi;
}

/**
 * Artifact slots, each owned by the state its step leads to (or runs in). Session artifacts are
 * stored under the owning state, the key core's ProfilingArtifactSlots and rewind use.
 */
export const PROFILING_SLOTS = {
  target: 'target',
  measurements: 'measurements',
  compute: 'compute',
  verificationTarget: 'verification-target',
  verification: 'verification',
  publish: 'publish',
} as const;
type Slot = (typeof PROFILING_SLOTS)[keyof typeof PROFILING_SLOTS];

const SLOT_STATE: Record<Slot, ProfilingState> = {
  target: 'created',
  measurements: 'measured',
  compute: 'computed',
  'verification-target': 'computed',
  verification: 'verified',
  publish: 'published',
};

const CGATS_MEDIA_TYPE = 'text/plain; charset=utf-8';
const JSON_MEDIA_TYPE = 'application/json';
/** Output nodes of the linearization curves: 1 % input steps. */
export const CURVE_STEPS = 101;
export const DEFAULT_PATCH_SIZE_MM = 10;
export const DEFAULT_PAGE_WIDTH_MM = 600;
export const DEFAULT_MAX_VERIFICATION_PATCHES = 48;
/** 21 steps per channel: 5 % increments, one strip per channel (Spec 005 FR4). */
export const DEFAULT_RAMP_STEPS = 21;
const PROFILING_LEVELS: readonly ProfilingLevel[] = ['L1', 'L2', 'L3'];

export interface CreateSessionInput {
  outputModeId: string;
  level: ProfilingLevel;
  author: string;
  presetId?: string;
  measurementCondition?: MeasurementCondition;
  options?: Partial<Omit<ProfilingOptions, 'thresholds'>> & { thresholds?: Partial<VerificationThresholds> };
}

export type MeasurementInput =
  | { kind: 'file'; format: 'cgats' | 'cxf'; text: string; condition?: MeasurementCondition }
  | { kind: 'instrument'; instrumentId?: string; condition?: MeasurementCondition };

export interface ComputeInput {
  author: string;
  /** The user's TAC in percent of one channel; or accept the proposal with `acceptProposedTac`. */
  tacLimitPercent?: number;
  acceptProposedTac?: boolean;
  /** L3: per-channel maximum in percent; defaults to the setup's or the device's limits. */
  channelLimitsPercent?: Record<string, number>;
  renderingIntent?: RenderingIntent;
}

export interface LimitsProposal {
  paper: Lab;
  tac?: TacProposal;
}

export interface ComputeResult {
  content: ColorSetupContent;
  paper: Lab;
  tacProposal?: TacProposal;
  profilePatchCount: number;
  droppedProfilePatches: number;
}

export interface ChartFiles {
  layout: ChartLayout;
  cgats: string;
  pdf: Uint8Array;
}

interface NewArtifact {
  kind: string;
  mediaType: string;
  bytes: Uint8Array;
}

interface StepChange {
  basis: ProfilingSession;
  author: string;
  to?: ProfilingState;
  note?: string;
  outputs?: Partial<Record<Slot, NewArtifact[]>>;
  measurementCondition?: MeasurementCondition;
  /** Runs inside the commit transaction; may add outputs. */
  within?: (session: ProfilingSession) => Partial<Record<Slot, NewArtifact[]>>;
}

function json(value: unknown): Uint8Array {
  return utf8(canonicalJson(value));
}

function integerIn(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < min || v > max) throw new ValidationError(`${field} must be an integer within ${min}..${max}`);
  return v;
}

function numberIn(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new ValidationError(`${field} must be a number within ${min}..${max}`);
  }
  return v;
}

/**
 * Spec 005 FR4: takes a (medium, mode) pair from uncharacterized to verified in resumable steps.
 * Every step's inputs and outputs are persisted as artifacts before the state moves, so a new
 * service instance on the same store continues where the last one stopped.
 */
export class ProfilingService {
  constructor(
    private readonly library: MediaLibrary,
    private readonly plugins: ProfilingPlugins = {},
  ) {}

  private get ctx() {
    return this.library.ctx;
  }

  // ---- Reads

  getSession(id: string): ProfilingSession {
    const session = this.ctx.repo.getSession(id);
    if (!session) throw new NotFoundError('profiling session', id);
    return session;
  }

  listSessions(): ProfilingSession[] {
    return this.ctx.repo.listSessions();
  }

  listArtifacts(id: string): ProfilingArtifactMeta[] {
    this.getSession(id);
    return this.ctx.repo.listArtifacts(id);
  }

  getChartFiles(id: string, which: 'target' | 'verification-target'): ChartFiles {
    const session = this.getSession(id);
    const cgats = fromUtf8(this.artifact(session, which, 'chart-layout').bytes);
    return { layout: chartFromCgats(cgats), cgats, pdf: this.artifact(session, which, 'chart-pdf').bytes };
  }

  getComputeResult(id: string): ComputeResult {
    return JSON.parse(fromUtf8(this.artifact(this.getSession(id), 'compute', 'compute-result').bytes)) as ComputeResult;
  }

  getVerificationReport(id: string): VerificationReport {
    return JSON.parse(fromUtf8(this.artifact(this.getSession(id), 'verification', 'verification-report').bytes)) as VerificationReport;
  }

  // ---- Steps

  createSession(input: CreateSessionInput): ProfilingSession {
    const author = requireText(input.author, 'author');
    if (!PROFILING_LEVELS.includes(input.level)) throw new ValidationError('level must be L1, L2 or L3');
    if (input.measurementCondition !== undefined && !isMeasurementCondition(input.measurementCondition)) {
      throw new ValidationError('measurementCondition must be M0, M1 or M2');
    }
    const session = this.ctx.repo.transaction(() => {
      const mode = this.library.getOutputMode(input.outputModeId);
      const medium = this.library.getMedium(mode.mediumId);
      const setup = this.library.getColorSetupForMode(mode.id);
      let thresholds = normalizeThresholds(input.options?.thresholds);
      if (input.presetId !== undefined) {
        const preset = this.library.getPreset(input.presetId);
        if (preset.outputModeId !== mode.id) throw new ValidationError('the preset belongs to another output mode');
        thresholds = normalizeThresholds(input.options?.thresholds, preset.verification);
      }
      const o = input.options ?? {};
      const metric = o.linearizationMetric ?? 'de2000-from-paper';
      if (!(LINEARIZATION_METRICS as readonly string[]).includes(metric)) throw new ValidationError('unknown linearization metric');
      const options: ProfilingOptions = {
        rampSteps: integerIn(o.rampSteps, DEFAULT_RAMP_STEPS, 2, 101, 'rampSteps'),
        profileGridLevels: integerIn(o.profileGridLevels, defaultGridLevels(mode.inkSet.length), 2, 17, 'profileGridLevels'),
        patchSizeMm: numberIn(o.patchSizeMm, DEFAULT_PATCH_SIZE_MM, 3, 50, 'patchSizeMm'),
        pageWidthMm: numberIn(o.pageWidthMm, medium.widthsMm[0] ?? DEFAULT_PAGE_WIDTH_MM, 50, 5000, 'pageWidthMm'),
        maxVerificationPatches: integerIn(o.maxVerificationPatches, DEFAULT_MAX_VERIFICATION_PATCHES, 1, 1000, 'maxVerificationPatches'),
        linearizationMetric: metric,
        thresholds,
      };
      const at = this.ctx.now();
      const created: ProfilingSession = {
        id: this.ctx.newId(),
        mediumId: medium.id,
        outputModeId: mode.id,
        colorSetupId: setup.id,
        level: input.level,
        state: 'created',
        options,
        artifacts: {},
        history: [{ state: 'created', at, author }],
        createdBy: author,
        createdAt: at,
        updatedAt: at,
      };
      if (input.presetId !== undefined) created.presetId = input.presetId;
      if (input.measurementCondition !== undefined) created.measurementCondition = input.measurementCondition;
      this.ctx.repo.insertSession(created);
      return created;
    });
    return session;
  }

  /** Generates (or regenerates) the characterization chart: PDF plus CGATS.17 layout. */
  generateTarget(id: string, author: string): ChartFiles {
    const session = this.requireState(id, ['created']);
    const mode = this.library.getOutputMode(session.outputModeId);
    const medium = this.library.getMedium(session.mediumId);
    const layout = buildCharacterizationChart({
      chartId: `${session.id}-target`,
      title: `${medium.name} / ${mode.name} ${session.level} characterization`,
      colorants: mode.inkSet,
      level: session.level,
      rampSteps: session.options.rampSteps,
      gridLevels: session.options.profileGridLevels ?? defaultGridLevels(mode.inkSet.length),
      patchSizeMm: session.options.patchSizeMm,
      pageWidthMm: session.options.pageWidthMm,
    });
    const files = this.chartFiles(layout);
    this.commit({ basis: session, author, outputs: { target: this.chartArtifacts(files) } });
    return files;
  }

  markTargetPrinted(id: string, author: string): ProfilingSession {
    const session = this.getSession(id);
    assertProfilingTransition(session.state, 'target_printed');
    this.artifact(session, 'target', 'chart-layout');
    return this.commit({ basis: session, author, to: 'target_printed' });
  }

  async recordMeasurements(id: string, input: MeasurementInput, author: string): Promise<ProfilingSession> {
    const session = this.getSession(id);
    assertProfilingTransition(session.state, 'measured');
    const layout = this.layout(session, 'target');
    const { set, source } = await this.readMeasurements(session, layout, input);
    joinMeasurements(layout, set);
    const artifacts: NewArtifact[] = [{ kind: 'measurements', mediaType: CGATS_MEDIA_TYPE, bytes: utf8(measurementsToCgats(set)) }];
    if (source) artifacts.push(source);
    return this.commit({
      basis: session,
      author,
      to: 'measured',
      outputs: { measurements: artifacts },
      measurementCondition: set.condition,
    });
  }

  /** FR5: a proposal only; `compute` uses it when the user accepts it. */
  proposeLimits(id: string): LimitsProposal {
    const session = this.getSession(id);
    const joined = joinMeasurements(this.layout(session, 'target'), this.measurementSet(session, 'measurements'));
    const proposal: LimitsProposal = { paper: paperWhite(joined) };
    if (session.level !== 'L1') proposal.tac = proposeTac(coverageSamples(joined));
    return proposal;
  }

  async compute(id: string, input: ComputeInput): Promise<ComputeResult> {
    const author = requireText(input.author, 'author');
    const session = this.getSession(id);
    assertProfilingTransition(session.state, 'computed');
    const engine = this.plugins.colorEngine;
    if (!engine?.buildProfile) throw new PluginUnavailableError('ColorEngine/1.1 buildProfile');
    const mode = this.library.getOutputMode(session.outputModeId);
    const setup = this.library.getColorSetup(session.colorSetupId);
    const colorants = mode.inkSet;
    const joined = joinMeasurements(this.layout(session, 'target'), this.measurementSet(session, 'measurements'));
    const paper = paperWhite(joined);

    let intent = setup.content.renderingIntent;
    if (session.presetId) intent = this.library.getPreset(session.presetId).renderingIntent ?? intent;
    if (input.renderingIntent !== undefined) {
      if (!isRenderingIntent(input.renderingIntent)) throw new ValidationError('renderingIntent is not an ICC rendering intent');
      intent = input.renderingIntent;
    }
    const content: ColorSetupContent = { level: session.level, renderingIntent: intent };
    let tacProposal: TacProposal | undefined;
    if (session.level !== 'L1') {
      if (session.level === 'L3') {
        const limits = input.channelLimitsPercent ?? setup.content.channelLimitsPercent ?? mode.colorDefaults?.channelLimitsPercent;
        if (!limits || Object.keys(limits).length === 0) throw new ValidationError('level L3 needs per-channel limits');
        const unknown = Object.keys(limits).filter((c) => !colorants.includes(c));
        if (unknown.length > 0) throw new ValidationError(`channel limits name colorants not in the ink set: ${unknown.join(', ')}`);
        content.channelLimitsPercent = { ...limits };
      }
      content.curves = buildLinearization(rampSamples(joined, colorants, paper, session.options.linearizationMetric), colorants, {
        steps: CURVE_STEPS,
        metric: session.options.linearizationMetric,
        channelLimitsPercent: content.channelLimitsPercent,
      });
      tacProposal = proposeTac(coverageSamples(joined));
      if (input.tacLimitPercent !== undefined) content.tacLimitPercent = input.tacLimitPercent;
      else if (input.acceptProposedTac) content.tacLimitPercent = tacProposal.proposedPercent;
      else throw new ValidationError('a TAC limit is required: pass tacLimitPercent or accept the proposal', { proposal: tacProposal });
    } else if (input.tacLimitPercent !== undefined) {
      content.tacLimitPercent = input.tacLimitPercent;
    }

    const { patches, dropped } = profilePatches(joined, colorants, content.curves);
    const condition = session.measurementCondition as MeasurementCondition;
    const profile = await engine.buildProfile({
      colorants: [...colorants],
      patches,
      measurementCondition: condition,
      options: { description: `${mode.name} ${session.level} (${session.id})`, renderingIntent: intent, tacLimitPercent: content.tacLimitPercent },
    });
    if (canonicalJson(profile.colorants) !== canonicalJson(colorants)) {
      throw new ValidationError('the color engine returned a profile for different colorants');
    }
    content.outputProfile = this.library.addProfile(profile.bytes, {
      description: profile.description,
      format: profile.format,
      mediaType: profile.mediaType,
      colorants: profile.colorants,
      provenance: { source: `profiling session ${session.id}`, license: 'generated by the shop', redistributable: true },
    });
    const normalized = normalizeContent(content);
    const result: ComputeResult = { content: normalized, paper, profilePatchCount: patches.length, droppedProfilePatches: dropped };
    if (tacProposal) result.tacProposal = tacProposal;
    const artifacts: NewArtifact[] = [
      { kind: 'compute-result', mediaType: JSON_MEDIA_TYPE, bytes: json(result) },
      { kind: 'profile', mediaType: profile.mediaType, bytes: profile.bytes },
    ];
    if (normalized.curves) {
      artifacts.push({ kind: 'curves', mediaType: CGATS_MEDIA_TYPE, bytes: utf8(curvesToText(normalized.curves, colorants)) });
    }
    this.commit({ basis: session, author, to: 'computed', outputs: { compute: artifacts } });
    return result;
  }

  /**
   * Verification chart: each reference Lab is evaluated through the new profile, then the curves
   * and limits. Defaults to an even pick of the measured characterization patches.
   */
  async createVerificationTarget(id: string, input: { author: string; references?: Lab[] }): Promise<ChartFiles> {
    const author = requireText(input.author, 'author');
    const session = this.requireState(id, ['computed']);
    const engine = this.plugins.colorEngine;
    if (!engine?.evaluate) throw new PluginUnavailableError('ColorEngine/1.1 evaluate');
    const { content } = this.getComputeResult(id);
    const mode = this.library.getOutputMode(session.outputModeId);
    const max = session.options.maxVerificationPatches;
    let references = input.references;
    if (references === undefined) {
      const joined = joinMeasurements(this.layout(session, 'target'), this.measurementSet(session, 'measurements'));
      references = selectVerificationReferences(profilePatches(joined, mode.inkSet, content.curves).patches, max);
    }
    if (!Array.isArray(references) || references.length === 0 || references.length > max) {
      throw new ValidationError(`between 1 and ${max} verification references are required`);
    }
    if (references.some((r) => ![r?.L, r?.a, r?.b].every((v) => typeof v === 'number' && Number.isFinite(v)))) {
      throw new ValidationError('verification references must be finite Lab values');
    }
    const evaluated = await engine.evaluate(this.profileData(content.outputProfile), references, { intent: content.renderingIntent });
    if (evaluated.device.length !== references.length) throw new ValidationError('the color engine returned the wrong number of values');
    const layout = buildVerificationChart({
      chartId: `${session.id}-verify`,
      title: `${this.library.getMedium(session.mediumId).name} / ${mode.name} verification`,
      colorants: mode.inkSet,
      patchSizeMm: session.options.patchSizeMm,
      pageWidthMm: session.options.pageWidthMm,
      patches: references.map((reference, i) => ({
        reference: { L: reference.L, a: reference.a, b: reference.b },
        device: renderDeviceValues(content, mode.inkSet, evaluated.device[i]!),
      })),
    });
    const files = this.chartFiles(layout);
    this.commit({ basis: session, author, outputs: { 'verification-target': this.chartArtifacts(files) } });
    return files;
  }

  /** Measures the verification chart. The session moves to `verified` only when the thresholds pass. */
  async verify(id: string, input: MeasurementInput, author: string): Promise<VerificationReport> {
    const session = this.requireState(id, ['computed']);
    const layout = this.layout(session, 'verification-target');
    const { set } = await this.readMeasurements(session, layout, input);
    const report = verificationReport(layout, set, session.options.thresholds);
    this.commit({
      basis: session,
      author,
      to: report.passed ? 'verified' : undefined,
      note: `mean ΔE2000 ${report.summary.mean.toFixed(2)}, p95 ${report.summary.p95.toFixed(2)}`,
      outputs: {
        verification: [
          { kind: 'measurements', mediaType: CGATS_MEDIA_TYPE, bytes: utf8(measurementsToCgats(set, 'Verification measurements')) },
          { kind: 'verification-report', mediaType: JSON_MEDIA_TYPE, bytes: json(report) },
        ],
      },
    });
    return report;
  }

  /** Creates a new ColorSetupRevisionRecord from the computed content and moves the head. */
  publish(id: string, input: { author: string; reason?: string }): ColorSetupRevisionRecord {
    const author = requireText(input.author, 'author');
    const session = this.getSession(id);
    assertProfilingTransition(session.state, 'published');
    const { content } = this.getComputeResult(id);
    let revision: ColorSetupRevisionRecord | undefined;
    this.commit({
      basis: session,
      author,
      to: 'published',
      within: () => {
        revision = this.library.commitRevision(session.colorSetupId, {
          authorKind: 'user',
          author,
          reason: input.reason ?? `profiling session ${session.id} (${session.level})`,
          content,
          source: { profilingSessionId: session.id },
        }).revision;
        return { publish: [{ kind: 'publish-result', mediaType: JSON_MEDIA_TYPE, bytes: json({ revisionId: revision.id }) }] };
      },
    });
    const published = revision as ColorSetupRevisionRecord;
    this.ctx.emit(this.library.publishedEvent(published));
    return published;
  }

  abandon(id: string, author: string, note?: string): ProfilingSession {
    const session = this.getSession(id);
    assertProfilingTransition(session.state, 'abandoned');
    return this.commit({ basis: session, author, to: 'abandoned', note });
  }

  /** Resume from an earlier completed step; the outputs of later steps are detached (kept for audit). */
  rewind(id: string, to: ProfilingState, author: string): ProfilingSession {
    const who = requireText(author, 'author');
    return this.ctx.repo.transaction(() => {
      const current = this.getSession(id);
      assertProfilingRewind(current.state, to);
      const keepUpTo = PROFILING_STEP_ORDER.indexOf(to);
      const artifacts: ProfilingSession['artifacts'] = {};
      for (const step of PROFILING_STEP_ORDER.slice(0, keepUpTo + 1)) {
        const ids = current.artifacts[step];
        if (ids !== undefined) artifacts[step] = ids;
      }
      const at = this.ctx.now();
      const next: ProfilingSession = {
        ...current,
        state: to,
        artifacts,
        history: [...current.history, { state: to, at, author: who, note: `rewound from ${current.state}` }],
        updatedAt: at,
      };
      this.ctx.repo.updateSession(next);
      return next;
    });
  }

  // ---- Internals

  private requireState(id: string, states: readonly ProfilingState[]): ProfilingSession {
    const session = this.getSession(id);
    if (!states.includes(session.state)) {
      throw new ConflictError(`profiling session ${id} is ${session.state}; this step needs ${states.join(' or ')}`, {
        state: session.state,
        required: states,
      });
    }
    return session;
  }

  private artifact(session: ProfilingSession, slot: Slot, kind: string): StoredArtifact {
    for (const artifactId of session.artifacts[SLOT_STATE[slot]] ?? []) {
      const stored = this.ctx.repo.getArtifact(artifactId);
      if (stored?.meta.kind === kind) return stored;
    }
    throw new ConflictError(`profiling session ${session.id} has no ${kind} in step ${slot}`, { slot, kind });
  }

  private layout(session: ProfilingSession, slot: 'target' | 'verification-target'): ChartLayout {
    return chartFromCgats(fromUtf8(this.artifact(session, slot, 'chart-layout').bytes));
  }

  private measurementSet(session: ProfilingSession, slot: 'measurements' | 'verification'): MeasurementSet {
    return measurementsFromCgats(fromUtf8(this.artifact(session, slot, 'measurements').bytes));
  }

  private profileData(ref: StoredProfileRef | undefined): ProfileData {
    if (!ref) throw new ValidationError('the computed setup has no output profile');
    const bytes = this.ctx.repo.getProfileBytes(ref.sha256);
    if (!bytes) throw new NotFoundError('profile', ref.sha256);
    return { format: ref.format, mediaType: ref.mediaType, description: ref.description, colorants: [...ref.colorants], bytes };
  }

  private chartFiles(layout: ChartLayout): ChartFiles {
    return { layout, cgats: chartToCgats(layout), pdf: chartToPdf(layout) };
  }

  private chartArtifacts(files: ChartFiles): NewArtifact[] {
    return [
      { kind: 'chart-layout', mediaType: CGATS_MEDIA_TYPE, bytes: utf8(files.cgats) },
      { kind: 'chart-pdf', mediaType: PDF_MEDIA_TYPE, bytes: files.pdf },
    ];
  }

  /** Reads measurements from a file or the Measurement/1 plugin and checks the session condition. */
  private async readMeasurements(
    session: ProfilingSession,
    layout: ChartLayout,
    input: MeasurementInput,
  ): Promise<{ set: MeasurementSet; source?: NewArtifact }> {
    if (input === null || typeof input !== 'object') throw new ValidationError('measurement input must be an object');
    const stated = input.condition ?? session.measurementCondition;
    let set: MeasurementSet;
    let source: NewArtifact | undefined;
    if (input.kind === 'file') {
      if (typeof input.text !== 'string' || input.text.length === 0) throw new ValidationError('measurement text is required');
      if (input.format === 'cgats') {
        set = measurementsFromCgats(input.text, { condition: stated });
        source = { kind: 'measurement-source', mediaType: CGATS_MEDIA_TYPE, bytes: utf8(input.text) };
      } else if (input.format === 'cxf') {
        set = measurementsFromCxf(input.text, { condition: stated });
        source = { kind: 'measurement-source', mediaType: 'application/xml', bytes: utf8(input.text) };
      } else {
        throw new ValidationError('format must be cgats or cxf');
      }
    } else if (input.kind === 'instrument') {
      const plugin = this.plugins.measurement;
      if (!plugin) throw new PluginUnavailableError('Measurement/1');
      const result = await plugin.measureStrip(measurementLayout(layout, stated), input.instrumentId ? { instrumentId: input.instrumentId } : undefined);
      set = {
        condition: resolveCondition(result.condition, stated),
        source: 'instrument',
        instrument: result.instrumentId,
        patches: result.patches.map((p) => ({ id: p.patchId, lab: { L: p.lab.L, a: p.lab.a, b: p.lab.b } })),
      };
    } else {
      throw new ValidationError('measurement input kind must be file or instrument');
    }
    if (session.measurementCondition !== undefined && set.condition !== session.measurementCondition) {
      throw new MeasurementConditionMismatchError(session.measurementCondition, set.condition);
    }
    return source ? { set, source } : { set };
  }

  /**
   * Persists outputs and the transition atomically. Refuses when the session changed since
   * `basis` was read (another step ran while plugins were working).
   */
  private commit(change: StepChange): ProfilingSession {
    const author = requireText(change.author, 'author');
    const session = this.ctx.repo.transaction(() => {
      const current = this.getSession(change.basis.id);
      if (current.state !== change.basis.state || canonicalJson(current.artifacts) !== canonicalJson(change.basis.artifacts)) {
        throw new ConflictError(`profiling session ${current.id} changed while the step ran`);
      }
      if (change.to) assertProfilingTransition(current.state, change.to);
      const at = this.ctx.now();
      const outputs = { ...(change.outputs ?? {}), ...(change.within?.(current) ?? {}) };
      const artifacts = { ...current.artifacts };
      for (const [slot, list] of Object.entries(outputs) as Array<[Slot, NewArtifact[]]>) {
        // Slots sharing an owning state (compute, verification-target) keep each other's kinds.
        const state = SLOT_STATE[slot];
        const kinds = new Set(list.map((artifact) => artifact.kind));
        const kept = (artifacts[state] ?? []).filter((artifactId) => {
          const kind = this.ctx.repo.getArtifact(artifactId)?.meta.kind;
          return kind !== undefined && !kinds.has(kind);
        });
        artifacts[state] = [...kept, ...list.map((artifact) => this.putArtifact(current.id, state, artifact, at))];
      }
      const next: ProfilingSession = { ...current, artifacts, updatedAt: at };
      if (change.measurementCondition !== undefined) next.measurementCondition = change.measurementCondition;
      if (change.to) {
        next.state = change.to;
        const entry: ProfilingSession['history'][number] = { state: change.to, at, author };
        if (change.note !== undefined) entry.note = change.note;
        next.history = [...current.history, entry];
      }
      this.ctx.repo.updateSession(next);
      return next;
    });
    if (change.to) {
      const event: ProfilingStepCompletedEvent = {
        type: 'profiling.step.completed',
        subject: session.id,
        data: { sessionId: session.id, state: session.state, mediumId: session.mediumId, outputModeId: session.outputModeId },
      };
      this.ctx.emit(event);
    }
    return session;
  }

  private putArtifact(sessionId: string, slot: ProfilingState, artifact: NewArtifact, at: string): string {
    const meta: ProfilingArtifactMeta = {
      id: this.ctx.newId(),
      sessionId,
      slot,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      sha256: sha256Hex(artifact.bytes),
      sizeBytes: artifact.bytes.length,
      createdAt: at,
    };
    this.ctx.repo.appendArtifact(meta, artifact.bytes);
    return meta.id;
  }
}
