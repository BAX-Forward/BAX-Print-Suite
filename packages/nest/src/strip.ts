import type { PackOption, Packer } from "./pack.js";
import type { Orientation, Piece, Problem } from "./prepare.js";
import type { Panel } from "./types.js";

/** A piece in packing order plus an orientation restriction used by local search. */
export interface Gene {
  readonly piece: Piece;
  /** 0 = packer chooses, 1 = first orientation only, 2 = second orientation only. */
  readonly force: 0 | 1 | 2;
}

export interface PlacedPiece {
  readonly piece: Piece;
  readonly orientation: Orientation;
  readonly x: number;
  /** Global y (panel offset included). */
  readonly y: number;
  readonly panel: number;
}

export interface StripResult {
  readonly placed: readonly PlacedPiece[];
  readonly panels: readonly Panel[];
  readonly lengthUsed: number;
  readonly rotations: number;
  /** Pieces that could not be placed even on an empty panel (should not happen). */
  readonly overflow: readonly Piece[];
}

function optionIndices(gene: Gene): readonly number[] {
  if (gene.piece.orientations.length < 2 || gene.force === 1) return [0];
  if (gene.force === 2) return [1];
  return [0, 1];
}

function packOptions(gene: Gene, gutter: number): PackOption[] {
  return optionIndices(gene).flatMap((o) => {
    const orientation = gene.piece.orientations[o];
    return orientation ? [{ w: orientation.w + gutter, h: orientation.h + gutter, o }] : [];
  });
}

/**
 * Packs genes onto the roll. Footprints are inflated by the gutter and the
 * usable width grows by one gutter, so pieces may touch the margins; output
 * positions need no correction. With a max length, pieces that do not fit
 * continue on the next panel.
 */
export function packStrip(problem: Problem, genes: readonly Gene[], packer: Packer): StripResult {
  const g = problem.gutter;
  const binW = problem.usableWidth + g;
  const binH =
    problem.maxLength !== undefined
      ? problem.maxLength + g
      : genes.reduce((sum, gene) => sum + Math.max(...gene.piece.orientations.map((o) => o.h)) + g, g);

  const placed: PlacedPiece[] = [];
  const panels: Panel[] = [];
  let remaining: readonly Gene[] = genes;
  let offset = 0;

  while (remaining.length > 0) {
    const spots = packer({ binW, binH, pieces: remaining.map((gene) => packOptions(gene, g)) });
    const index = panels.length;
    const next: Gene[] = [];
    let length = 0;
    for (const [i, gene] of remaining.entries()) {
      const spot = spots[i];
      const orientation = spot ? gene.piece.orientations[spot.o] : undefined;
      if (!spot || !orientation) {
        next.push(gene);
        continue;
      }
      placed.push({ piece: gene.piece, orientation, x: spot.x, y: offset + spot.y, panel: index });
      length = Math.max(length, spot.y + orientation.h);
    }
    if (next.length === remaining.length) {
      return summarize(placed, panels, offset, next.map((gene) => gene.piece));
    }
    panels.push({ index, offsetPt: offset, lengthPt: length });
    offset += length;
    remaining = next;
  }
  return summarize(placed, panels, offset, []);
}

function summarize(
  placed: readonly PlacedPiece[],
  panels: readonly Panel[],
  lengthUsed: number,
  overflow: readonly Piece[],
): StripResult {
  const rotations = placed.filter((p) => p.orientation.rotation !== 0).length;
  return { placed, panels, lengthUsed, rotations, overflow };
}
