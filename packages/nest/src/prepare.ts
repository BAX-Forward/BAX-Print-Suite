import { EPS } from "./geometry.js";
import type {
  Margins,
  NestItem,
  NestOptions,
  RollMedia,
  Rotation,
  RotationPolicy,
  SortOrder,
  Unplaced,
  UnplacedReason,
} from "./types.js";

/** A distinct footprint for a piece (0/180 and 90/270 share footprints in the rect phase). */
export interface Orientation {
  readonly w: number;
  readonly h: number;
  readonly rotation: Rotation;
}

/** One copy of one item, validated and ready to pack. */
export interface Piece {
  /** Position in expanded input order (item order, then copy). */
  readonly key: number;
  readonly itemId: string;
  readonly copy: number;
  readonly group: string | undefined;
  /** Footprint area including bleed. */
  readonly area: number;
  /** 1 or 2 distinct footprints, all of which fit the media. Index 0 is upright when allowed. */
  readonly orientations: readonly Orientation[];
}

export interface Problem {
  readonly media: RollMedia;
  readonly usableWidth: number;
  readonly maxLength: number | undefined;
  readonly gutter: number;
  readonly pieces: readonly Piece[];
  readonly unplaced: readonly Unplaced[];
}

const ALL_ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Replaces non-finite or negative values with 0 so user input never throws. */
export function normalizeMedia(media: RollMedia): RollMedia {
  const margins: Partial<Margins> = media.margins ?? {};
  const nonNegative = (value: unknown): number => Math.max(0, finiteOr(value, 0));
  const normalized: RollMedia = {
    widthPt: finiteOr(media.widthPt, 0),
    margins: {
      left: nonNegative(margins.left),
      right: nonNegative(margins.right),
      lead: nonNegative(margins.lead),
      trail: nonNegative(margins.trail),
    },
  };
  return isPositiveFinite(media.maxLengthPt)
    ? { ...normalized, maxLengthPt: media.maxLengthPt }
    : normalized;
}

export function policyRotations(policy: RotationPolicy | undefined): readonly Rotation[] {
  switch (policy) {
    case "90":
      return [0, 90];
    case "any":
      return ALL_ROTATIONS;
    default:
      return [0];
  }
}

/** Allowed rotations: lock.orientation > lock.grain > rotation policy. */
export function allowedRotations(item: NestItem): readonly Rotation[] {
  const lock = item.lock;
  if (lock?.orientation !== undefined && ALL_ROTATIONS.includes(lock.orientation)) {
    return [lock.orientation];
  }
  if (lock?.grain === "along-roll") return [0, 180];
  if (lock?.grain === "across-roll") return [90, 270];
  return policyRotations(item.rotation);
}

function orientationsFor(
  base: { w: number; h: number },
  rotations: readonly Rotation[],
): Orientation[] {
  const upright = rotations.find((r) => r === 0 || r === 180);
  const turned = rotations.find((r) => r === 90 || r === 270);
  const result: Orientation[] = [];
  if (upright !== undefined) result.push({ w: base.w, h: base.h, rotation: upright });
  const sameFootprint = upright !== undefined && base.w === base.h;
  if (turned !== undefined && !sameFootprint) {
    result.push({ w: base.h, h: base.w, rotation: turned });
  }
  return result;
}

export function prepare(media: RollMedia, items: readonly NestItem[], opts: NestOptions): Problem {
  const normalized = normalizeMedia(media);
  const { margins } = normalized;
  const usableWidth = normalized.widthPt - margins.left - margins.right;
  const maxLength = normalized.maxLengthPt;
  const gutter = Math.max(0, finiteOr(opts.gutterPt, 0));
  const fitsWidth = (o: Orientation): boolean => o.w <= usableWidth + EPS;
  const fits = (o: Orientation): boolean =>
    fitsWidth(o) && (maxLength === undefined || o.h <= maxLength + EPS);

  const pieces: Piece[] = [];
  const unplaced: Unplaced[] = [];

  for (const item of items) {
    const itemId = String(item.id);
    const copies = Math.max(0, Math.floor(finiteOr(item.quantity, 0)));
    if (copies === 0) continue;

    const bleed = item.bleedPt === undefined ? 0 : item.bleedPt;
    const validBleed = typeof bleed === "number" && Number.isFinite(bleed) && bleed >= 0;
    if (!isPositiveFinite(item.widthPt) || !isPositiveFinite(item.heightPt) || !validBleed) {
      unplaced.push({ itemId, reason: "invalid-size", copies });
      continue;
    }

    const base = { w: item.widthPt + 2 * bleed, h: item.heightPt + 2 * bleed };
    const candidates = orientationsFor(base, allowedRotations(item));
    const fitting = candidates.filter(fits);
    if (fitting.length === 0) {
      unplaced.push({ itemId, reason: classify(item, base, candidates, fitsWidth, fits), copies });
      continue;
    }
    for (let copy = 0; copy < copies; copy++) {
      pieces.push({
        key: pieces.length,
        itemId,
        copy,
        group: typeof item.group === "string" ? item.group : undefined,
        area: base.w * base.h,
        orientations: fitting,
      });
    }
  }

  return { media: normalized, usableWidth, maxLength, gutter, pieces, unplaced };
}

function classify(
  item: NestItem,
  base: { w: number; h: number },
  candidates: readonly Orientation[],
  fitsWidth: (o: Orientation) => boolean,
  fits: (o: Orientation) => boolean,
): UnplacedReason {
  if (candidates.some(fitsWidth)) return "max-length";
  if (item.lock !== undefined) {
    const unlocked = orientationsFor(base, policyRotations(item.rotation));
    if (unlocked.some(fits)) return "locked-orientation";
  }
  return "too-wide";
}

/** Strip-length lower bound (area bound and tallest piece), in actual points. */
export function lowerBound(problem: Problem): number {
  if (problem.pieces.length === 0) return 0;
  const g = problem.gutter;
  const binW = problem.usableWidth + g;
  let area = 0;
  let tallest = 0;
  for (const piece of problem.pieces) {
    const first = piece.orientations[0];
    if (!first) continue;
    area += (first.w + g) * (first.h + g);
    const shortest = Math.min(...piece.orientations.map((o) => o.h));
    tallest = Math.max(tallest, shortest + g);
  }
  return Math.max(area / binW, tallest) - g;
}

function sortKey(sort: SortOrder): ((piece: Piece) => number) | undefined {
  const dims = (piece: Piece): { w: number; h: number } => piece.orientations[0] ?? { w: 0, h: 0 };
  switch (sort) {
    case "area-desc":
      return (p) => p.area;
    case "height-desc":
      return (p) => dims(p).h;
    case "width-desc":
      return (p) => dims(p).w;
    case "perimeter-desc":
      return (p) => dims(p).w + dims(p).h;
    case "maxside-desc":
      return (p) => Math.max(dims(p).w, dims(p).h);
    default:
      return undefined;
  }
}

/** Stable sort (ties keep input order), then pull group members together. */
export function orderPieces(pieces: readonly Piece[], sort: SortOrder): Piece[] {
  const key = sortKey(sort);
  const sorted = key ? [...pieces].sort((a, b) => key(b) - key(a) || a.key - b.key) : [...pieces];
  return groupAdjacent(sorted);
}

function groupAdjacent(sorted: readonly Piece[]): Piece[] {
  if (!sorted.some((p) => p.group !== undefined)) return [...sorted];
  const members = new Map<string, Piece[]>();
  for (const piece of sorted) {
    if (piece.group === undefined) continue;
    members.set(piece.group, [...(members.get(piece.group) ?? []), piece]);
  }
  const result: Piece[] = [];
  const emitted = new Set<string>();
  for (const piece of sorted) {
    if (piece.group === undefined) {
      result.push(piece);
    } else if (!emitted.has(piece.group)) {
      emitted.add(piece.group);
      result.push(...(members.get(piece.group) ?? []));
    }
  }
  return result;
}
