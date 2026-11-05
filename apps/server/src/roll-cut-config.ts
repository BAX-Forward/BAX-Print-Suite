import type { CutExtractor } from './cut-routes.js';
import { createRollCutExtractor } from './roll-cut.js';
import type { StepRepeatRouteOptions } from './step-repeat-routes.js';

/** Spec 003y: plans a stepped-and-repeated job's cut job on the roll (Spec 003v) when set. */
export const ROLL_CUT_ENV = 'BPS_ROLL_CUT';

const ENABLED_VALUES: readonly string[] = ['1', 'true'];

/** `"1"` or `"true"` turns roll cut on, an absent variable leaves it off and any other value is a startup error. */
export function parseRollCut(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (ENABLED_VALUES.includes(value)) return true;
  throw new Error(`${ROLL_CUT_ENV} must be "1" or "true" when set, got ${JSON.stringify(value)}`);
}

export interface RollCutConfig {
  /** Pass as `cutExtractor`. */
  readonly cutExtractor: CutExtractor;
  /** Spread into `stepRepeat`; empty when roll cut is off. */
  readonly stepRepeat: Pick<StepRepeatRouteOptions, 'onJob'>;
}

/**
 * Wires `POST /jobs/:id/step-repeat` to `POST /jobs/:id/cut-job` when `BPS_ROLL_CUT` is on. When
 * it is off the base extractor is returned unchanged and step and repeat records nothing.
 */
export function configureRollCut(env: Readonly<Record<string, string | undefined>>, base: CutExtractor): RollCutConfig {
  if (!parseRollCut(env[ROLL_CUT_ENV])) return { cutExtractor: base, stepRepeat: {} };
  const roll = createRollCutExtractor(base);
  return { cutExtractor: roll.extractor, stepRepeat: { onJob: roll.onJob } };
}
