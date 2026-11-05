import {
  FINISHING_STEP_KINDS,
  finishingProgress,
  type FinishingPlan,
  type FinishingStep,
  type FinishingStepKind,
  type FinishingStepStatus,
} from '@bax-print/core';
import type { Database } from './database.js';

/**
 * Spec 004c: finishing plans (spec 004b) persisted in the job database (migration 4), one plan
 * per job. Plans are checked on save and on read, so a corrupt row never reaches a caller.
 */

export interface FinishingPlanRepository {
  /** Inserts or replaces the plan for `plan.jobId`. Throws {@link InvalidFinishingPlanError}. */
  save(plan: FinishingPlan): FinishingPlan;
  /** Throws {@link InvalidFinishingPlanError} if the stored plan is malformed. */
  get(jobId: string): FinishingPlan | undefined;
  delete(jobId: string): boolean;
  /** Plans with a step that is neither done nor skipped, least recently saved first. */
  listIncomplete(): FinishingPlan[];
}

export class InvalidFinishingPlanError extends Error {
  readonly code = 'FINISHING_PLAN_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidFinishingPlanError';
  }
}

const STEP_STATUSES = ['pending', 'in_progress', 'done', 'skipped'] as const satisfies readonly FinishingStepStatus[];

/** Matches the timestamps core accepts for finishing plans. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const OPTIONAL_TEXT_FIELDS = ['label', 'startedBy', 'completedBy', 'skippedBy', 'skipReason'] as const;
const OPTIONAL_TIME_FIELDS = ['startedAt', 'completedAt', 'skippedAt'] as const;

type OptionalStepField = (typeof OPTIONAL_TEXT_FIELDS)[number] | (typeof OPTIONAL_TIME_FIELDS)[number];
type OptionalStepFields = Partial<Record<OptionalStepField, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is FinishingStepKind {
  return typeof value === 'string' && (FINISHING_STEP_KINDS as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is FinishingStepStatus {
  return typeof value === 'string' && (STEP_STATUSES as readonly string[]).includes(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function readOptionalFields(record: Record<string, unknown>, position: number): OptionalStepFields {
  const text = OPTIONAL_TEXT_FIELDS.reduce<OptionalStepFields>((fields, field) => {
    const value = record[field];
    if (value === undefined) return fields;
    if (!isNonBlank(value)) {
      throw new InvalidFinishingPlanError(`step ${position} ${field} must be a non-blank string`);
    }
    return { ...fields, [field]: value };
  }, {});
  return OPTIONAL_TIME_FIELDS.reduce<OptionalStepFields>((fields, field) => {
    const value = record[field];
    if (value === undefined) return fields;
    if (!isTimestamp(value)) {
      throw new InvalidFinishingPlanError(`step ${position} ${field} must be an ISO 8601 timestamp`);
    }
    return { ...fields, [field]: value };
  }, text);
}

function toStep(value: unknown, position: number): FinishingStep {
  if (!isRecord(value)) {
    throw new InvalidFinishingPlanError(`step ${position} must be an object`);
  }
  const { index, kind, status } = value;
  if (index !== position) {
    throw new InvalidFinishingPlanError(`step ${position} has index ${JSON.stringify(index)}`);
  }
  if (!isKind(kind)) {
    throw new InvalidFinishingPlanError(`step ${position} has unknown kind ${JSON.stringify(kind)}`);
  }
  if (!isStatus(status)) {
    throw new InvalidFinishingPlanError(`step ${position} has unknown status ${JSON.stringify(status)}`);
  }
  const optional = readOptionalFields(value, position);
  if (kind === 'other' && optional.label === undefined) {
    throw new InvalidFinishingPlanError(`step ${position} is "other" and needs a label`);
  }
  return Object.freeze({ index: position, kind, status, ...optional });
}

/**
 * Checks a parsed plan document and rebuilds it with only the known fields. With
 * `expectedJobId`, the plan must belong to that job.
 */
function toPlan(value: unknown, expectedJobId?: string): FinishingPlan {
  if (!isRecord(value)) {
    throw new InvalidFinishingPlanError('finishing plan must be an object');
  }
  const { jobId, createdAt, updatedAt, steps } = value;
  if (!isNonBlank(jobId)) {
    throw new InvalidFinishingPlanError('finishing plan jobId must be a non-blank string');
  }
  if (expectedJobId !== undefined && jobId !== expectedJobId) {
    throw new InvalidFinishingPlanError(`finishing plan is for job ${jobId}, expected job ${expectedJobId}`);
  }
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) {
    throw new InvalidFinishingPlanError(`finishing plan for job ${jobId} needs ISO 8601 createdAt and updatedAt`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new InvalidFinishingPlanError(`finishing plan for job ${jobId} needs at least one step`);
  }
  return Object.freeze({
    jobId,
    createdAt,
    updatedAt,
    steps: Object.freeze(steps.map((step: unknown, position) => toStep(step, position))),
  });
}

/**
 * Parses stored plan JSON, throwing {@link InvalidFinishingPlanError} unless it is a well-formed
 * finishing plan (for `expectedJobId`, when given).
 */
export function parseFinishingPlanJson(text: string, expectedJobId?: string): FinishingPlan {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidFinishingPlanError('finishing plan JSON does not parse');
  }
  return toPlan(value, expectedJobId);
}

/** The plan as it reads back from its JSON, so `save` stores and returns only what `get` accepts. */
function roundTrip(plan: FinishingPlan): FinishingPlan {
  let text: string;
  try {
    text = JSON.stringify(plan);
  } catch {
    throw new InvalidFinishingPlanError('finishing plan cannot be serialized as JSON');
  }
  return parseFinishingPlanJson(text, plan.jobId);
}

interface PlanRow {
  readonly jobId: string;
  readonly planJson: string;
}

function toRow(value: unknown): PlanRow {
  if (!isRecord(value)) {
    throw new InvalidFinishingPlanError('stored finishing plan row is malformed');
  }
  const { job_id: jobId, plan_json: planJson } = value;
  if (typeof jobId !== 'string' || typeof planJson !== 'string') {
    throw new InvalidFinishingPlanError('stored finishing plan row is malformed');
  }
  return { jobId, planJson };
}

function rowToPlan(row: PlanRow): FinishingPlan {
  try {
    return parseFinishingPlanJson(row.planJson, row.jobId);
  } catch (error) {
    if (error instanceof InvalidFinishingPlanError) {
      throw new InvalidFinishingPlanError(`stored finishing plan for job ${row.jobId} is invalid: ${error.message}`);
    }
    throw error;
  }
}

export interface SqliteFinishingPlanRepositoryOptions {
  /** Clock for the row's `updated_at`; defaults to the system clock. */
  readonly now?: () => Date;
}

export class SqliteFinishingPlanRepository implements FinishingPlanRepository {
  private readonly now: () => Date;

  /** `db` must come from `openDatabase`, which applies the migrations. */
  constructor(
    private readonly db: Database,
    options: SqliteFinishingPlanRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  save(plan: FinishingPlan): FinishingPlan {
    const saved = roundTrip(plan);
    this.db
      .prepare(
        `INSERT INTO finishing_plans (job_id, plan_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET plan_json = excluded.plan_json, updated_at = excluded.updated_at`,
      )
      .run(saved.jobId, JSON.stringify(saved), this.now().toISOString());
    return saved;
  }

  get(jobId: string): FinishingPlan | undefined {
    const row: unknown = this.db.prepare('SELECT job_id, plan_json FROM finishing_plans WHERE job_id = ?').get(jobId);
    return row === undefined ? undefined : rowToPlan(toRow(row));
  }

  delete(jobId: string): boolean {
    const result = this.db.prepare('DELETE FROM finishing_plans WHERE job_id = ?').run(jobId);
    return Number(result.changes) > 0;
  }

  listIncomplete(): FinishingPlan[] {
    const rows: unknown[] = this.db
      .prepare('SELECT job_id, plan_json FROM finishing_plans ORDER BY updated_at, job_id')
      .all();
    return rows.map((row) => rowToPlan(toRow(row))).filter((plan) => !finishingProgress(plan).isComplete);
  }
}
