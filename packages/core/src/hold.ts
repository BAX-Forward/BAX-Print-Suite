/** Why a job is `held`. `preflight` is set by inspection; `operator` by a manual hold. */
export const HOLD_REASONS = ["preflight", "operator"] as const;

export type HoldReason = (typeof HOLD_REASONS)[number];

export interface Hold {
  reason: HoldReason;
  since: string;
  detail?: string;
}

export function isHoldReason(value: unknown): value is HoldReason {
  return typeof value === "string" && (HOLD_REASONS as readonly string[]).includes(value);
}
