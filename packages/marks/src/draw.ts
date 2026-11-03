/**
 * `marks.draw()`: the Spec 003 `opts.marks` hook entry point. Plans (and
 * validates, including the Spec 004 collision check) before touching the
 * page, then draws the marks and merges their geometry into `/BPS_Layout`.
 */
import type { MarksHook, MarksHookContext } from "./layout-types.js";
import { mergeFinishingMetadata } from "./metadata.js";
import { renderPlan } from "./pdf-writer.js";
import { planFinishing, type PlanInput } from "./plan.js";
import type { FinishingPlan } from "./plan-types.js";

export type DrawInput = Omit<PlanInput, "layout">;

export interface DrawOptions {
  /** Write geometry to `/BPS_Layout` (default true). */
  readonly metadata?: boolean;
}

function pageIndex(ctx: MarksHookContext): number {
  return ctx.page.doc.getPages().findIndex((p) => p.ref === ctx.page.ref);
}

export async function draw(ctx: MarksHookContext, input: DrawInput, options: DrawOptions = {}): Promise<FinishingPlan> {
  const plan = await planFinishing({ ...input, layout: ctx.layout });
  await renderPlan(ctx.page, ctx.frame, plan);
  if (options.metadata !== false) mergeFinishingMetadata(ctx.page.doc, plan, Math.max(0, pageIndex(ctx)));
  return plan;
}

/** A hook for `impose(…, { marks })`; `onPlan` receives each page's plan (warnings, codes). */
export function marksHook(
  input: DrawInput,
  onPlan?: (plan: FinishingPlan) => void,
  options: DrawOptions = {},
): MarksHook {
  return async (ctx) => {
    const plan = await draw(ctx, input, options);
    onPlan?.(plan);
  };
}

/** Runs hooks in order, e.g. Spec 004 registration marks, then finishing marks. */
export function composeHooks(...hooks: readonly (MarksHook | undefined)[]): MarksHook {
  return async (ctx) => {
    for (const hook of hooks) if (hook) await hook(ctx);
  };
}
