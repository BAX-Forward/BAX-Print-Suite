import { nestAuto } from "./auto.js";
import { buildLayout } from "./layout.js";
import { prepare } from "./prepare.js";
import {
  initialGenes,
  packerFor,
  resolveStrategy,
  strategyLabel,
  type RectAlgorithm,
} from "./strategy.js";
import { packStrip } from "./strip.js";
import type { Algorithm, Layout, NestItem, NestOptions, Nester, RollMedia } from "./types.js";

/** One packer run with one heuristic and one sort order. */
export function nestSingle(
  media: RollMedia,
  items: readonly NestItem[],
  opts: NestOptions,
  algorithm: RectAlgorithm,
): Layout {
  const start = performance.now();
  const problem = prepare(media, items, opts);
  const strategy = resolveStrategy(algorithm, opts.heuristic, opts.sort);
  const result = packStrip(problem, initialGenes(problem, strategy.sort), packerFor(strategy));
  return buildLayout(problem, result, strategyLabel(strategy), performance.now() - start);
}

/** MaxRects (Jylänki 2010). Heuristics: bssf (default), blsf, baf, bl. */
export class MaxRectsNester implements Nester {
  readonly id = "maxrects";
  readonly supportsShapes = false;

  nest(media: RollMedia, items: readonly NestItem[], opts: NestOptions): Layout {
    return nestSingle(media, items, opts, "maxrects");
  }
}

/** Skyline with waste map (Jylänki 2010). Heuristics: bl (default), mwf. */
export class SkylineNester implements Nester {
  readonly id = "skyline";
  readonly supportsShapes = false;

  nest(media: RollMedia, items: readonly NestItem[], opts: NestOptions): Layout {
    return nestSingle(media, items, opts, "skyline");
  }
}

/** Best of all rectangle packers and sort orders, refined by seeded local search. */
export class AutoNester implements Nester {
  readonly id = "auto";
  readonly supportsShapes = false;

  nest(media: RollMedia, items: readonly NestItem[], opts: NestOptions): Layout {
    return nestAuto(media, items, opts);
  }
}

/** Unknown algorithm names fall back to `auto`. */
export function createNester(algorithm: Algorithm): Nester {
  switch (algorithm) {
    case "maxrects":
      return new MaxRectsNester();
    case "skyline":
      return new SkylineNester();
    default:
      return new AutoNester();
  }
}

export function nest(media: RollMedia, items: readonly NestItem[], opts: NestOptions): Layout {
  return createNester(opts.algorithm).nest(media, items, opts);
}
