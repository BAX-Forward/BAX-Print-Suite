import { EPS } from "./geometry.js";
import { buildLayout } from "./layout.js";
import { lowerBound, prepare, type Problem } from "./prepare.js";
import { createRng, type Rng } from "./rng.js";
import {
  initialGenes,
  packerFor,
  SORT_ORDERS,
  strategyLabel,
  type RectAlgorithm,
  type Strategy,
} from "./strategy.js";
import { packStrip, type Gene, type StripResult } from "./strip.js";
import type { Layout, NestItem, NestOptions, RollMedia } from "./types.js";

export const DEFAULT_TIME_BUDGET_MS = 500;
export const DEFAULT_MAX_ITERATIONS = 5000;
export const DEFAULT_SEED = 1;

/** Share of local-search moves that reorder (the rest flip an orientation). */
const REORDER_SHARE = 0.75;

/** Packers in priority order; the grid tries every packer for each sort in turn. */
const PACKERS: readonly { algorithm: RectAlgorithm; heuristic: string }[] = [
  { algorithm: "maxrects", heuristic: "bssf" },
  { algorithm: "maxrects", heuristic: "bl" },
  { algorithm: "skyline", heuristic: "bl" },
  { algorithm: "skyline", heuristic: "mwf" },
  { algorithm: "maxrects", heuristic: "baf" },
  { algorithm: "maxrects", heuristic: "blsf" },
];

const STRATEGIES: readonly Strategy[] = SORT_ORDERS.flatMap((sort) =>
  PACKERS.map((packer) => ({ ...packer, sort })),
);

const FIRST_STRATEGY: Strategy = { algorithm: "maxrects", heuristic: "bssf", sort: "area-desc" };

interface Candidate {
  readonly strategy: Strategy;
  readonly genes: readonly Gene[];
  readonly result: StripResult;
}

/** Strictly better: fewer overflow pieces, then shorter length, then fewer rotations. */
export function isBetter(a: StripResult, b: StripResult): boolean {
  if (a.overflow.length !== b.overflow.length) return a.overflow.length < b.overflow.length;
  if (Math.abs(a.lengthUsed - b.lengthUsed) > EPS) return a.lengthUsed < b.lengthUsed;
  return a.rotations < b.rotations;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && !Number.isNaN(value) && value > 0 ? value : fallback;
}

function evaluate(problem: Problem, strategy: Strategy): Candidate {
  const genes = initialGenes(problem, strategy.sort);
  return { strategy, genes, result: packStrip(problem, genes, packerFor(strategy)) };
}

/**
 * Runs every packer × sort combination, then a seeded local search on the best
 * order. Stops early at the strip lower bound, at `maxIterations`, or when the
 * time budget runs out (at least one run always completes). The result depends
 * only on input and seed unless the time budget cuts the search short.
 */
export function nestAuto(media: RollMedia, items: readonly NestItem[], opts: NestOptions): Layout {
  const start = performance.now();
  const deadline = start + positiveOr(opts.timeBudgetMs, DEFAULT_TIME_BUDGET_MS);
  const maxIterations =
    typeof opts.maxIterations === "number" && opts.maxIterations >= 0
      ? Math.floor(opts.maxIterations)
      : DEFAULT_MAX_ITERATIONS;
  const seed = typeof opts.seed === "number" && Number.isFinite(opts.seed) ? opts.seed : DEFAULT_SEED;

  const problem = prepare(media, items, opts);
  const bound = lowerBound(problem);
  const isOptimal = (c: Candidate): boolean => c.result.lengthUsed <= bound + EPS;

  let best = evaluate(problem, FIRST_STRATEGY);
  for (const strategy of STRATEGIES) {
    if (isOptimal(best) || performance.now() >= deadline) break;
    if (strategyLabel(strategy) === strategyLabel(FIRST_STRATEGY)) continue;
    const candidate = evaluate(problem, strategy);
    if (isBetter(candidate.result, best.result)) best = candidate;
  }

  const searched = localSearch(problem, best, {
    rng: createRng(seed),
    deadline,
    maxIterations,
    isOptimal,
  });
  const suffix = searched === best ? "" : "+ls";
  return buildLayout(
    problem,
    searched.result,
    `auto:${strategyLabel(searched.strategy)}${suffix}`,
    performance.now() - start,
  );
}

interface SearchLimits {
  readonly rng: Rng;
  readonly deadline: number;
  readonly maxIterations: number;
  readonly isOptimal: (c: Candidate) => boolean;
}

/** Hill climbing with sideways moves. Groups disable reordering (keeps them adjacent). */
function localSearch(problem: Problem, start: Candidate, limits: SearchLimits): Candidate {
  const packer = packerFor(start.strategy);
  const canReorder = !problem.pieces.some((p) => p.group !== undefined);
  let current = start;
  let best = start;
  for (let i = 0; i < limits.maxIterations; i++) {
    if (limits.isOptimal(best) || performance.now() >= limits.deadline) break;
    const genes = mutate(current.genes, limits.rng, canReorder);
    if (!genes) break;
    const result = packStrip(problem, genes, packer);
    if (isBetter(current.result, result)) continue;
    current = { strategy: start.strategy, genes, result };
    if (isBetter(result, best.result)) best = current;
  }
  return best;
}

function randomIndex(rng: Rng, n: number): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}

function mutate(genes: readonly Gene[], rng: Rng, canReorder: boolean): Gene[] | undefined {
  const n = genes.length;
  const reorder = canReorder && n > 1;
  const canFlip = genes.some((g) => g.piece.orientations.length > 1);
  if (!reorder && !canFlip) return undefined;
  if (reorder && (!canFlip || rng() < REORDER_SHARE)) {
    const i = randomIndex(rng, n);
    const j = (i + 1 + randomIndex(rng, n - 1)) % n;
    return rng() < 0.5 ? swap(genes, i, j) : move(genes, i, j);
  }
  return flip(genes, randomIndex(rng, n));
}

function swap(genes: readonly Gene[], i: number, j: number): Gene[] {
  const next = [...genes];
  const a = genes[i];
  const b = genes[j];
  if (a && b) {
    next[i] = b;
    next[j] = a;
  }
  return next;
}

function move(genes: readonly Gene[], from: number, to: number): Gene[] {
  const next = [...genes];
  const [gene] = next.splice(from, 1);
  if (gene) next.splice(to, 0, gene);
  return next;
}

/** Cycles the orientation restriction of the first flippable gene at or after `start`. */
function flip(genes: readonly Gene[], start: number): Gene[] | undefined {
  const n = genes.length;
  for (let step = 0; step < n; step++) {
    const i = (start + step) % n;
    const gene = genes[i];
    if (gene && gene.piece.orientations.length > 1) {
      const next = [...genes];
      next[i] = { piece: gene.piece, force: gene.force === 0 ? 1 : gene.force === 1 ? 2 : 0 };
      return next;
    }
  }
  return undefined;
}
