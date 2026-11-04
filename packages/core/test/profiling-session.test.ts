import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VERIFICATION_THRESHOLDS,
  IllegalProfilingTransitionError as IllegalTransitionError,
  PROFILING_STATES,
  type ProfilingArtifactSlots,
  type ProfilingSession,
  type ProfilingState,
  ValidationError,
  advanceProfilingSession,
  assertProfilingRewind,
  assertProfilingTransition,
  canTransitionProfiling,
  isTerminalProfilingState,
  resumeProfilingSession,
  rewindProfilingSession,
  statesAfter,
} from '../src/index.js';

/** Independent statement of the expected table, so a change to either side fails the test. */
const LEGAL = new Set<string>([
  'created>target_printed',
  'target_printed>measured',
  'measured>computed',
  'computed>verified',
  'verified>published',
  'created>abandoned',
  'target_printed>abandoned',
  'measured>abandoned',
  'computed>abandoned',
  'verified>abandoned',
]);

const pairs: Array<[ProfilingState, ProfilingState]> = PROFILING_STATES.flatMap((from) =>
  PROFILING_STATES.map((to): [ProfilingState, ProfilingState] => [from, to]),
);

describe('ProfilingSession state machine', () => {
  it('covers all 49 ordered state pairs', () => {
    expect(pairs).toHaveLength(49);
  });

  it.each(pairs)('%s -> %s matches the transition table', (from, to) => {
    const legal = LEGAL.has(`${from}>${to}`);
    expect(canTransitionProfiling(from, to)).toBe(legal);
    if (legal) {
      expect(() => assertProfilingTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertProfilingTransition(from, to)).toThrow(IllegalTransitionError);
    }
  });

  it('reports machine, from and to on an illegal transition', () => {
    try {
      assertProfilingTransition('created', 'published');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      const typed = error as IllegalTransitionError;
      expect(typed.machine).toBe('ProfilingSession');
      expect(typed.from).toBe('created');
      expect(typed.to).toBe('published');
      expect(typed.code).toBe('illegal_transition');
    }
  });

  it('treats published and abandoned as terminal', () => {
    expect(PROFILING_STATES.filter(isTerminalProfilingState)).toEqual(['published', 'abandoned']);
  });

  it('allows rewinding only to an earlier completed step of a live session', () => {
    expect(() => assertProfilingRewind('computed', 'measured')).not.toThrow();
    expect(() => assertProfilingRewind('verified', 'created')).not.toThrow();
    expect(() => assertProfilingRewind('measured', 'computed')).toThrow(IllegalTransitionError);
    expect(() => assertProfilingRewind('measured', 'measured')).toThrow(IllegalTransitionError);
    expect(() => assertProfilingRewind('published', 'computed')).toThrow(IllegalTransitionError);
    expect(() => assertProfilingRewind('abandoned', 'created')).toThrow(IllegalTransitionError);
    expect(() => assertProfilingRewind('computed', 'abandoned')).toThrow(IllegalTransitionError);
  });

  it('lists the steps discarded by a rewind', () => {
    expect(statesAfter('measured')).toEqual(['computed', 'verified', 'published']);
  });
});

const T0 = '2026-01-01T00:00:00.000Z';

function newSession(): ProfilingSession {
  return {
    id: 'session-1',
    mediumId: 'medium-1',
    outputModeId: 'mode-1',
    colorSetupId: 'setup-1',
    level: 'L2',
    state: 'created',
    options: {
      rampSteps: 21,
      patchSizeMm: 6,
      pageWidthMm: 210,
      maxVerificationPatches: 50,
      linearizationMetric: 'de2000-from-paper',
      thresholds: { ...DEFAULT_VERIFICATION_THRESHOLDS },
    },
    artifacts: { created: ['chart-1'] },
    history: [{ state: 'created', at: T0, author: 'operator' }],
    createdBy: 'operator',
    createdAt: T0,
    updatedAt: T0,
  };
}

/** Simulates a store round trip: only what survives JSON is available on resume. */
function persisted(session: ProfilingSession): ProfilingSession {
  return JSON.parse(JSON.stringify(session)) as ProfilingSession;
}

describe('ProfilingSession transitions and resume', () => {
  it('advances without mutating the input session', () => {
    const start = newSession();
    const printed = advanceProfilingSession(start, 'target_printed', '2026-01-01T01:00:00.000Z', 'operator', 'ok');
    expect(start.state).toBe('created');
    expect(start.history).toHaveLength(1);
    expect(printed.state).toBe('target_printed');
    expect(printed.updatedAt).toBe('2026-01-01T01:00:00.000Z');
    expect(printed.history[printed.history.length - 1]).toEqual({
      state: 'target_printed',
      at: '2026-01-01T01:00:00.000Z',
      author: 'operator',
      note: 'ok',
    });
  });

  it('rejects an illegal advance with a typed error', () => {
    expect(() => advanceProfilingSession(newSession(), 'computed', T0, 'operator')).toThrow(IllegalTransitionError);
  });

  it('resumes a fresh session at target printing', () => {
    expect(resumeProfilingSession(persisted(newSession()))).toEqual({
      state: 'created',
      completedSteps: ['created'],
      nextStep: 'target_printed',
    });
  });

  it('resumes from the last persisted step', () => {
    let session = newSession();
    session = advanceProfilingSession(session, 'target_printed', T0, 'operator');
    session = { ...session, artifacts: { ...session.artifacts, target_printed: ['print-1'] } };
    session = advanceProfilingSession(session, 'measured', T0, 'operator');
    expect(resumeProfilingSession(persisted(session))).toEqual({
      state: 'measured',
      completedSteps: ['created', 'target_printed', 'measured'],
      nextStep: 'computed',
    });
  });

  it('resumes after a rewind and drops the artifacts of later steps', () => {
    let session = newSession();
    for (const step of ['target_printed', 'measured', 'computed'] as const) {
      session = advanceProfilingSession(session, step, T0, 'operator');
      const artifacts: ProfilingArtifactSlots = { ...session.artifacts };
      artifacts[step] = [`${step}-1`];
      session = { ...session, artifacts };
    }
    const rewound = rewindProfilingSession(session, 'target_printed', T0, 'operator', 'remeasure');
    expect(rewound.artifacts).toEqual({ created: ['chart-1'], target_printed: ['target_printed-1'] });
    expect(session.artifacts.computed).toEqual(['computed-1']);
    expect(resumeProfilingSession(persisted(rewound))).toEqual({
      state: 'target_printed',
      completedSteps: ['created', 'target_printed'],
      nextStep: 'measured',
    });
  });

  it('rejects an illegal rewind with a typed error', () => {
    expect(() => rewindProfilingSession(newSession(), 'measured', T0, 'operator')).toThrow(IllegalTransitionError);
  });

  it('reports no next step for terminal sessions', () => {
    const abandoned = advanceProfilingSession(
      advanceProfilingSession(newSession(), 'target_printed', T0, 'operator'),
      'abandoned',
      T0,
      'operator',
    );
    expect(resumeProfilingSession(persisted(abandoned))).toEqual({
      state: 'abandoned',
      completedSteps: ['created', 'target_printed'],
      nextStep: null,
    });
  });

  it('rejects a persisted history the machine could not have produced', () => {
    const forged: ProfilingSession = {
      ...newSession(),
      state: 'computed',
      history: [
        { state: 'created', at: T0, author: 'operator' },
        { state: 'computed', at: T0, author: 'operator' },
      ],
    };
    expect(() => resumeProfilingSession(forged)).toThrow(IllegalTransitionError);
  });

  it('rejects a stored state that disagrees with the history', () => {
    expect(() => resumeProfilingSession({ ...newSession(), state: 'measured' })).toThrow(ValidationError);
    expect(() => resumeProfilingSession({ ...newSession(), history: [] })).toThrow(ValidationError);
  });
});
