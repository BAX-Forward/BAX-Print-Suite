import { packMaxRects } from "./maxrects.js";
import type { Packer } from "./pack.js";
import { orderPieces, type Problem } from "./prepare.js";
import { packSkyline } from "./skyline.js";
import type { Gene } from "./strip.js";
import type { MaxRectsHeuristic, SkylineHeuristic, SortOrder } from "./types.js";

export type RectAlgorithm = "maxrects" | "skyline";

/** One deterministic packing recipe: packer, heuristic and initial order. */
export interface Strategy {
  readonly algorithm: RectAlgorithm;
  readonly heuristic: string;
  readonly sort: SortOrder;
}

export const MAXRECTS_HEURISTICS: readonly MaxRectsHeuristic[] = ["bssf", "blsf", "baf", "bl"];
export const SKYLINE_HEURISTICS: readonly SkylineHeuristic[] = ["bl", "mwf"];
export const SORT_ORDERS: readonly SortOrder[] = [
  "area-desc",
  "height-desc",
  "maxside-desc",
  "perimeter-desc",
  "width-desc",
  "input",
];
export const DEFAULT_SORT: SortOrder = "area-desc";

/** Returns `value` if it is one of `allowed`, else undefined. */
export function pick<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

/** Unknown heuristic or sort names fall back to the defaults (never throws). */
export function resolveStrategy(
  algorithm: RectAlgorithm,
  heuristic: string | undefined,
  sort: SortOrder | undefined,
): Strategy {
  const requested = typeof heuristic === "string" ? heuristic.toLowerCase() : undefined;
  const resolvedHeuristic =
    algorithm === "maxrects"
      ? (pick(MAXRECTS_HEURISTICS, requested) ?? "bssf")
      : (pick(SKYLINE_HEURISTICS, requested) ?? "bl");
  return { algorithm, heuristic: resolvedHeuristic, sort: pick(SORT_ORDERS, sort) ?? DEFAULT_SORT };
}

export function packerFor(strategy: Strategy): Packer {
  if (strategy.algorithm === "maxrects") {
    const heuristic = pick(MAXRECTS_HEURISTICS, strategy.heuristic) ?? "bssf";
    return (input) => packMaxRects(input, heuristic);
  }
  const heuristic = pick(SKYLINE_HEURISTICS, strategy.heuristic) ?? "bl";
  return (input) => packSkyline(input, heuristic);
}

export function strategyLabel(strategy: Strategy): string {
  return `${strategy.algorithm}/${strategy.heuristic}/${strategy.sort}`;
}

export function initialGenes(problem: Problem, sort: SortOrder): Gene[] {
  return orderPieces(problem.pieces, sort).map((piece): Gene => ({ piece, force: 0 }));
}
