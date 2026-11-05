import { BpsError, InvalidArgumentError } from './errors.js';

export const FINISHING_STEP_KINDS = ['laminate', 'mount', 'cut', 'weed', 'hem', 'grommet', 'other'] as const;
export type FinishingStepKind = (typeof FINISHING_STEP_KINDS)[number];

export type FinishingStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

/** One requested step when building a plan; `other` needs a label. */
export interface FinishingStepInput {
  readonly kind: FinishingStepKind;
  readonly label?: string;
}

export interface FinishingStep {
  /** Position in the plan, starting at 0. */
  readonly index: number;
  readonly kind: FinishingStepKind;
  readonly label?: string;
  readonly status: FinishingStepStatus;
  readonly startedBy?: string;
  readonly startedAt?: string;
  readonly completedBy?: string;
  readonly completedAt?: string;
  readonly skippedBy?: string;
  readonly skippedAt?: string;
  readonly skipReason?: string;
}

/** Ordered finishing steps for one job. */
export interface FinishingPlan {
  readonly jobId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly steps: readonly FinishingStep[];
}

export interface FinishingProgress {
  readonly total: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly done: number;
  readonly skipped: number;
  /** First step that is neither done nor skipped. */
  readonly nextStep: FinishingStep | undefined;
  readonly isComplete: boolean;
}

/** A finishing step was asked to make a move its current status does not allow. */
export class InvalidFinishingTransitionError extends BpsError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_FINISHING_TRANSITION', message, details === undefined ? undefined : { details });
  }
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function assertTimestamp(at: string, field: string): void {
  if (!ISO_TIMESTAMP.test(at) || Number.isNaN(Date.parse(at))) {
    throw new InvalidArgumentError(`${field} must be an ISO 8601 timestamp, got "${at}"`);
  }
}

function assertNonBlank(value: string, field: string): void {
  if (value.trim() === '') throw new InvalidArgumentError(`${field} must not be blank`);
}

function isResolved(step: FinishingStep): boolean {
  return step.status === 'done' || step.status === 'skipped';
}

function isKind(value: string): value is FinishingStepKind {
  return (FINISHING_STEP_KINDS as readonly string[]).includes(value);
}

function toStep(input: FinishingStepInput, index: number): FinishingStep {
  if (!isKind(input.kind)) {
    throw new InvalidArgumentError(`step ${index} has unknown kind "${String(input.kind)}"`);
  }
  if (input.label !== undefined) assertNonBlank(input.label, `step ${index} label`);
  if (input.kind === 'other' && input.label === undefined) {
    throw new InvalidArgumentError(`step ${index} is "other" and needs a label`);
  }
  const base = { index, kind: input.kind, status: 'pending' as const };
  return input.label === undefined ? base : { ...base, label: input.label.trim() };
}

export function createFinishingPlan(jobId: string, steps: readonly FinishingStepInput[], at: string): FinishingPlan {
  assertNonBlank(jobId, 'jobId');
  assertTimestamp(at, 'at');
  if (steps.length === 0) throw new InvalidArgumentError('a finishing plan needs at least one step');
  return { jobId, createdAt: at, updatedAt: at, steps: steps.map(toStep) };
}

function stepAt(plan: FinishingPlan, index: number): FinishingStep {
  const step = Number.isInteger(index) ? plan.steps[index] : undefined;
  if (step === undefined) {
    throw new InvalidArgumentError(`job ${plan.jobId} has no finishing step ${index}`);
  }
  return step;
}

function assertNotBefore(at: string, earlier: string | undefined, what: string): void {
  if (earlier !== undefined && Date.parse(at) < Date.parse(earlier)) {
    throw new InvalidArgumentError(`${what} ${at} is before ${earlier}`);
  }
}

function replaceStep(plan: FinishingPlan, next: FinishingStep, at: string): FinishingPlan {
  return { ...plan, updatedAt: at, steps: plan.steps.map((s) => (s.index === next.index ? next : s)) };
}

function validateMove(plan: FinishingPlan, actor: string, at: string): void {
  assertNonBlank(actor, 'actor');
  assertTimestamp(at, 'at');
  assertNotBefore(at, plan.updatedAt, 'timestamp');
}

/** pending -> in_progress. Every earlier step must already be done or skipped. */
export function startStep(plan: FinishingPlan, index: number, actor: string, at: string): FinishingPlan {
  validateMove(plan, actor, at);
  const step = stepAt(plan, index);
  if (step.status !== 'pending') {
    throw new InvalidFinishingTransitionError(`step ${index} of job ${plan.jobId} is ${step.status}; only pending steps can start`, {
      jobId: plan.jobId,
      index,
      status: step.status,
    });
  }
  const blocker = plan.steps.find((s) => s.index < index && !isResolved(s));
  if (blocker !== undefined) {
    throw new InvalidFinishingTransitionError(
      `step ${index} of job ${plan.jobId} cannot start while step ${blocker.index} is ${blocker.status}`,
      { jobId: plan.jobId, index, blockedBy: blocker.index },
    );
  }
  return replaceStep(plan, { ...step, status: 'in_progress', startedBy: actor, startedAt: at }, at);
}

/** in_progress -> done. */
export function completeStep(plan: FinishingPlan, index: number, actor: string, at: string): FinishingPlan {
  validateMove(plan, actor, at);
  const step = stepAt(plan, index);
  if (step.status !== 'in_progress') {
    throw new InvalidFinishingTransitionError(
      `step ${index} of job ${plan.jobId} is ${step.status}; only in-progress steps can be completed`,
      { jobId: plan.jobId, index, status: step.status },
    );
  }
  assertNotBefore(at, step.startedAt, 'completion time');
  return replaceStep(plan, { ...step, status: 'done', completedBy: actor, completedAt: at }, at);
}

/** pending | in_progress -> skipped. A reason is required. */
export function skipStep(plan: FinishingPlan, index: number, actor: string, at: string, reason: string): FinishingPlan {
  validateMove(plan, actor, at);
  assertNonBlank(reason, 'skip reason');
  const step = stepAt(plan, index);
  if (isResolved(step)) {
    throw new InvalidFinishingTransitionError(`step ${index} of job ${plan.jobId} is already ${step.status}`, {
      jobId: plan.jobId,
      index,
      status: step.status,
    });
  }
  return replaceStep(plan, { ...step, status: 'skipped', skippedBy: actor, skippedAt: at, skipReason: reason.trim() }, at);
}

export function finishingProgress(plan: FinishingPlan): FinishingProgress {
  const count = (status: FinishingStepStatus): number => plan.steps.filter((s) => s.status === status).length;
  const nextStep = plan.steps.find((s) => !isResolved(s));
  return {
    total: plan.steps.length,
    pending: count('pending'),
    inProgress: count('in_progress'),
    done: count('done'),
    skipped: count('skipped'),
    nextStep,
    isComplete: nextStep === undefined,
  };
}
