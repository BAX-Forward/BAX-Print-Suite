import { readFileSync } from "node:fs";
import { nest } from "../src/nesters.js";
import type { Algorithm, NestOptions } from "../src/types.js";
import type { BenchInstance } from "./generate.js";

export interface Thresholds {
  readonly timeBudgetMs: number;
  readonly perfectSmall: { readonly maxN: number; readonly maxMeanLengthRatio: number };
  readonly perfectLarge: {
    readonly minN: number;
    readonly maxN: number;
    readonly minMeanUtilization: number;
    readonly minWorstUtilization: number;
  };
  readonly shopMix: { readonly items: number; readonly minUtilization: number };
  readonly maxrectsBssf500: { readonly maxMs: number; readonly ciFactor: number };
}

export function loadThresholds(): Thresholds {
  return JSON.parse(readFileSync(new URL("./thresholds.json", import.meta.url), "utf8")) as Thresholds;
}

export interface Recipe {
  readonly algorithm: Algorithm;
  readonly heuristic?: string;
}

export interface RunResult {
  readonly instance: BenchInstance;
  readonly utilization: number;
  /** lengthUsed / optimum (perfect packings only). */
  readonly lengthRatio: number | undefined;
  readonly elapsedMs: number;
  readonly unplaced: number;
}

export interface Summary {
  readonly runs: number;
  readonly meanUtilization: number;
  readonly worstUtilization: number;
  readonly meanLengthRatio: number | undefined;
  readonly meanMs: number;
}

export function runInstance(instance: BenchInstance, recipe: Recipe, timeBudgetMs: number): RunResult {
  const opts: NestOptions = {
    gutterPt: 0,
    algorithm: recipe.algorithm,
    seed: instance.seed,
    timeBudgetMs,
    ...(recipe.heuristic !== undefined ? { heuristic: recipe.heuristic } : {}),
  };
  const start = performance.now();
  const layout = nest(instance.media, instance.items, opts);
  const elapsedMs = performance.now() - start;
  return {
    instance,
    utilization: layout.utilization,
    lengthRatio: instance.optimumPt ? layout.lengthUsedPt / instance.optimumPt : undefined,
    elapsedMs,
    unplaced: layout.unplaced.reduce((sum, entry) => sum + entry.copies, 0),
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function summarize(results: readonly RunResult[]): Summary {
  const ratios = results.flatMap((r) => (r.lengthRatio === undefined ? [] : [r.lengthRatio]));
  return {
    runs: results.length,
    meanUtilization: mean(results.map((r) => r.utilization)),
    worstUtilization: results.length === 0 ? 0 : Math.min(...results.map((r) => r.utilization)),
    meanLengthRatio: ratios.length === 0 ? undefined : mean(ratios),
    meanMs: mean(results.map((r) => r.elapsedMs)),
  };
}
