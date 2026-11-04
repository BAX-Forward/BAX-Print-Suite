import type { MeasurementCondition } from './media-color.js';
import { IllegalProfilingTransitionError, ValidationError } from './media-errors.js';
import type { LinearizationMetric, ProfilingLevel, VerificationThresholds } from './media.js';

export const PROFILING_STATES = [
  'created',
  'target_printed',
  'measured',
  'computed',
  'verified',
  'published',
  'abandoned',
] as const;
export type ProfilingState = (typeof PROFILING_STATES)[number];

/** The forward path; `abandoned` is reachable from every non-terminal state. */
export const PROFILING_STEP_ORDER: readonly ProfilingState[] = [
  'created',
  'target_printed',
  'measured',
  'computed',
  'verified',
  'published',
];

export const PROFILING_TRANSITIONS: Readonly<Record<ProfilingState, readonly ProfilingState[]>> = Object.freeze({
  created: ['target_printed', 'abandoned'],
  target_printed: ['measured', 'abandoned'],
  measured: ['computed', 'abandoned'],
  computed: ['verified', 'abandoned'],
  verified: ['published', 'abandoned'],
  published: [],
  abandoned: [],
});

const MACHINE = 'ProfilingSession';

export function canTransitionProfiling(from: ProfilingState, to: ProfilingState): boolean {
  return PROFILING_TRANSITIONS[from].includes(to);
}

export function assertProfilingTransition(from: ProfilingState, to: ProfilingState): void {
  if (!canTransitionProfiling(from, to)) throw new IllegalProfilingTransitionError(MACHINE, from, to);
}

export function isTerminalProfilingState(state: ProfilingState): boolean {
  return PROFILING_TRANSITIONS[state].length === 0;
}

/**
 * Resuming "from any completed step": a session may go back to a step it already completed,
 * discarding the outputs of the steps after it. Terminal sessions cannot be rewound.
 */
export function canRewindProfiling(from: ProfilingState, to: ProfilingState): boolean {
  const fromIndex = PROFILING_STEP_ORDER.indexOf(from);
  const toIndex = PROFILING_STEP_ORDER.indexOf(to);
  return !isTerminalProfilingState(from) && fromIndex >= 0 && toIndex >= 0 && toIndex < fromIndex;
}

export function assertProfilingRewind(from: ProfilingState, to: ProfilingState): void {
  if (!canRewindProfiling(from, to)) throw new IllegalProfilingTransitionError(MACHINE, from, to);
}

/** Steps whose outputs are discarded when rewinding to `to`. */
export function statesAfter(to: ProfilingState): ProfilingState[] {
  const index = PROFILING_STEP_ORDER.indexOf(to);
  if (index < 0) throw new ValidationError(`not a step state: ${to}`);
  return PROFILING_STEP_ORDER.slice(index + 1);
}

export interface ProfilingOptions {
  /** Steps per single-channel ramp; 21 gives 5 % increments. */
  rampSteps: number;
  /** Levels per channel of the profile grid; derived from the channel count when absent. */
  profileGridLevels?: number;
  patchSizeMm: number;
  pageWidthMm: number;
  maxVerificationPatches: number;
  linearizationMetric: LinearizationMetric;
  thresholds: VerificationThresholds;
}

export interface ProfilingHistoryEntry {
  state: ProfilingState;
  at: string;
  author: string;
  note?: string;
}

/** Artifact ids keyed by the step that produced them; rewinding clears the slots of later steps. */
export type ProfilingArtifactSlots = Partial<Record<ProfilingState, string[]>>;

export interface ProfilingSession {
  id: string;
  mediumId: string;
  outputModeId: string;
  colorSetupId: string;
  presetId?: string;
  level: ProfilingLevel;
  state: ProfilingState;
  measurementCondition?: MeasurementCondition;
  options: ProfilingOptions;
  artifacts: ProfilingArtifactSlots;
  history: ProfilingHistoryEntry[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfilingArtifactMeta {
  id: string;
  sessionId: string;
  slot: ProfilingState;
  kind: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

function historyEntry(state: ProfilingState, at: string, author: string, note?: string): ProfilingHistoryEntry {
  return note === undefined ? { state, at, author } : { state, at, author, note };
}

/** Moves a session one step along the table; returns a new session and leaves the input unchanged. */
export function advanceProfilingSession(
  session: ProfilingSession,
  to: ProfilingState,
  at: string,
  author: string,
  note?: string,
): ProfilingSession {
  assertProfilingTransition(session.state, to);
  return {
    ...session,
    state: to,
    history: [...session.history, historyEntry(to, at, author, note)],
    updatedAt: at,
  };
}

/** Returns a new session rewound to an earlier completed step, without the artifacts of later steps. */
export function rewindProfilingSession(
  session: ProfilingSession,
  to: ProfilingState,
  at: string,
  author: string,
  note?: string,
): ProfilingSession {
  assertProfilingRewind(session.state, to);
  const discarded = new Set<ProfilingState>(statesAfter(to));
  const artifacts: ProfilingArtifactSlots = {};
  for (const step of PROFILING_STEP_ORDER) {
    const ids = session.artifacts[step];
    if (ids !== undefined && !discarded.has(step)) artifacts[step] = [...ids];
  }
  return {
    ...session,
    state: to,
    artifacts,
    history: [...session.history, historyEntry(to, at, author, note)],
    updatedAt: at,
  };
}

export interface ProfilingResumePoint {
  state: ProfilingState;
  /** Steps whose outputs are still valid, in step order. */
  completedSteps: ProfilingState[];
  /** The forward step to run next; `null` for a terminal session. */
  nextStep: ProfilingState | null;
}

/**
 * Works out where a persisted session continues. The history is replayed against the table
 * (forward transitions and rewinds); a history that the machine could not have produced, or
 * that disagrees with the stored state, is rejected rather than guessed at.
 */
export function resumeProfilingSession(session: ProfilingSession): ProfilingResumePoint {
  const { history } = session;
  const first = history[0];
  if (first === undefined || first.state !== 'created') {
    throw new ValidationError('profiling session history must start at created', { sessionId: session.id });
  }
  for (let i = 1; i < history.length; i++) {
    const from = history[i - 1]!.state;
    const to = history[i]!.state;
    if (!canTransitionProfiling(from, to) && !canRewindProfiling(from, to)) {
      throw new IllegalProfilingTransitionError(MACHINE, from, to);
    }
  }
  const last = history[history.length - 1]!;
  if (last.state !== session.state) {
    throw new ValidationError('profiling session state does not match its history', {
      sessionId: session.id,
      state: session.state,
      lastPersistedStep: last.state,
    });
  }

  // An abandoned session keeps the steps it had completed before it was abandoned.
  const lastStep = session.state === 'abandoned' ? history[history.length - 2]?.state ?? 'created' : session.state;
  const completedSteps = PROFILING_STEP_ORDER.slice(0, PROFILING_STEP_ORDER.indexOf(lastStep) + 1);
  const nextStep = isTerminalProfilingState(session.state)
    ? null
    : (PROFILING_TRANSITIONS[session.state].find((state) => state !== 'abandoned') ?? null);
  return { state: session.state, completedSteps, nextStep };
}
