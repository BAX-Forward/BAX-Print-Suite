/**
 * Spec 027f: {@link FinishingPlanRepository} for PostgreSQL, written only against {@link DbPort}.
 *
 * Not wired into the server, and this build ships no PostgreSQL driver: nothing constructs a
 * port for it yet. The SQL uses `?` placeholders as DbPort documents; a driver adapter maps them
 * to its own form. The table is `finishing_plans` from PG_MIGRATIONS version 4.
 *
 * `plan_json` is JSONB there, so it is read back as `plan_json::text`: the same document, but
 * PostgreSQL normalizes its whitespace and key order. Rows sort with the "C" collation so
 * `listIncomplete` orders by code point, as the SQLite repository does.
 */
import { finishingProgress, type FinishingPlan } from '@bax-print/core';
import type { DbPort, DbRow } from './db-port.js';
import {
  InvalidFinishingPlanError,
  parseFinishingPlanJson,
  type FinishingPlanRepository,
} from './sqlite-finishing.js';

const PLAN_COLUMNS = 'job_id, plan_json::text AS plan_json';

const SELECT_BY_JOB_ID = `SELECT ${PLAN_COLUMNS} FROM finishing_plans WHERE job_id = ?`;

const UPSERT = `INSERT INTO finishing_plans (job_id, plan_json, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT (job_id) DO UPDATE SET
    plan_json = EXCLUDED.plan_json,
    updated_at = EXCLUDED.updated_at`;

const DELETE_BY_JOB_ID = 'DELETE FROM finishing_plans WHERE job_id = ?';

const LIST_ALL = `SELECT ${PLAN_COLUMNS} FROM finishing_plans ORDER BY updated_at COLLATE "C", job_id COLLATE "C"`;

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

/** The port returns unchecked rows, so both columns are checked before the row becomes a plan. */
function rowToPlan(row: DbRow): FinishingPlan {
  const { job_id: jobId, plan_json: planJson } = row;
  if (typeof jobId !== 'string' || typeof planJson !== 'string') {
    throw new InvalidFinishingPlanError('stored finishing plan row is malformed');
  }
  try {
    return parseFinishingPlanJson(planJson, jobId);
  } catch (error) {
    if (error instanceof InvalidFinishingPlanError) {
      throw new InvalidFinishingPlanError(`stored finishing plan for job ${jobId} is invalid: ${error.message}`);
    }
    throw error;
  }
}

export interface PgFinishingPlanRepositoryOptions {
  /** Clock for the row's `updated_at`; defaults to the system clock. */
  readonly now?: () => Date;
}

export class PgFinishingPlanRepository implements FinishingPlanRepository {
  private readonly now: () => Date;

  /** The port's database must have PG_MIGRATIONS version 4 applied. */
  constructor(
    private readonly port: DbPort,
    options: PgFinishingPlanRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  save(plan: FinishingPlan): FinishingPlan {
    const saved = roundTrip(plan);
    this.port.exec(UPSERT, [saved.jobId, JSON.stringify(saved), this.now().toISOString()]);
    return saved;
  }

  get(jobId: string): FinishingPlan | undefined {
    const row = this.port.query(SELECT_BY_JOB_ID, [jobId])[0];
    return row ? rowToPlan(row) : undefined;
  }

  delete(jobId: string): boolean {
    return this.port.exec(DELETE_BY_JOB_ID, [jobId]) > 0;
  }

  listIncomplete(): FinishingPlan[] {
    return this.port
      .query(LIST_ALL)
      .map(rowToPlan)
      .filter((plan) => !finishingProgress(plan).isComplete);
  }
}
