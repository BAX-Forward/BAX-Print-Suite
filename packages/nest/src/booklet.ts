import { EPS } from "./geometry.js";
import {
  ceilDiv,
  MAX_PAGES,
  MAX_SHEETS,
  NestInputError,
  requireCount,
  requireNonNegative,
  type PageSlot,
} from "./n-up.js";
import { POINTS_PER } from "./units.js";

/** Pages per folded signature, or "single": every sheet nested in one saddle-stitched signature. */
export type SignaturePages = 4 | 8 | 16 | "single";
export type BookletBinding = "left" | "right";

/** Largest creep (points) on the innermost sheet of a signature: 10 mm. */
export const MAX_CREEP_PT = 10 * POINTS_PER.mm;

export interface BookletOptions {
  /** 1..MAX_PAGES. */
  pageCount: number;
  signaturePages: SignaturePages;
  /**
   * Creep per sheet in points: each sheet's offset grows by this much from the
   * outermost sheet of its signature inward. Default 0. The innermost offset
   * (creep x (sheets per signature - 1)) and creep itself must not exceed MAX_CREEP_PT.
   */
  creep?: number;
  binding: BookletBinding;
}

/** Pages on one side of the flat sheet, left then right as seen looking at that side. */
export type BookletSide = readonly [PageSlot, PageSlot];

export interface BookletSheet {
  /** Print order across the whole booklet, 0-based. */
  readonly index: number;
  /** Signature this sheet belongs to, 0-based. */
  readonly signature: number;
  /** Nesting position in the signature: 0 is the outermost sheet. */
  readonly position: number;
  readonly front: BookletSide;
  readonly back: BookletSide;
  /** Offset (points) toward the spine for this sheet's pages: 0 outermost, growing inward. */
  readonly creep: number;
}

export interface BookletPlan {
  readonly pageCount: number;
  /** pageCount rounded up to a multiple of 4 ("single") or of the signature size. */
  readonly paddedPageCount: number;
  readonly blankCount: number;
  readonly pagesPerSignature: number;
  readonly sheetsPerSignature: number;
  readonly signatureCount: number;
  readonly binding: BookletBinding;
  readonly sheets: readonly BookletSheet[];
}

const FN = "planBooklet";
const SIGNATURES: readonly SignaturePages[] = [4, 8, 16, "single"];
const BINDINGS: readonly BookletBinding[] = ["left", "right"];
const PAGES_PER_SHEET = 4;

function validate(opts: BookletOptions): void {
  requireCount(FN, "pageCount", opts.pageCount, MAX_PAGES);
  if (!SIGNATURES.includes(opts.signaturePages)) {
    throw new NestInputError(`${FN}: signaturePages must be 4, 8, 16 or "single", got ${opts.signaturePages}`);
  }
  if (!BINDINGS.includes(opts.binding)) {
    throw new NestInputError(`${FN}: binding must be "left" or "right", got ${opts.binding}`);
  }
  const creep = opts.creep ?? 0;
  requireNonNegative(FN, "creep", creep);
  if (creep > MAX_CREEP_PT + EPS) {
    throw new NestInputError(`${FN}: creep must be at most ${MAX_CREEP_PT} pt (10 mm), got ${creep}`);
  }
}

/** Left binding reads [left, right] as planned; right binding mirrors every side. */
function orient(side: BookletSide, binding: BookletBinding): BookletSide {
  return binding === "left" ? side : [side[1], side[0]];
}

/**
 * Plans saddle-stitch page order for a booklet. Pages are padded with blanks at
 * the end to a multiple of 4 ("single") or of the signature size; each signature
 * nests its sheets, and signatures follow one another. Sheet `position` p of a
 * signature of n pages starting after page b carries, for left binding,
 * front [b+n-2p, b+1+2p] and back [b+2+2p, b+n-1-2p]. Index math is exact integer
 * arithmetic. Pure: no rendering, no I/O. Throws a NestInputError for invalid input.
 */
export function planBooklet(opts: BookletOptions): BookletPlan {
  validate(opts);
  const { pageCount, binding } = opts;
  const creep = opts.creep ?? 0;
  const padTo = opts.signaturePages === "single" ? PAGES_PER_SHEET : opts.signaturePages;
  const paddedPageCount = ceilDiv(pageCount, padTo) * padTo;
  const pagesPerSignature = opts.signaturePages === "single" ? paddedPageCount : opts.signaturePages;
  const sheetsPerSignature = pagesPerSignature / PAGES_PER_SHEET;
  const signatureCount = paddedPageCount / pagesPerSignature;
  const sheetCount = paddedPageCount / PAGES_PER_SHEET;
  if (sheetCount > MAX_SHEETS) {
    throw new NestInputError(`${FN}: ${pageCount} pages need ${sheetCount} sheets, more than the limit of ${MAX_SHEETS}`);
  }
  const innermost = creep * (sheetsPerSignature - 1);
  if (innermost > MAX_CREEP_PT + EPS) {
    throw new NestInputError(
      `${FN}: creep ${creep} pt over ${sheetsPerSignature} nested sheets reaches ${innermost} pt, ` +
        `more than the limit of ${MAX_CREEP_PT} pt (10 mm)`,
    );
  }

  const slot = (page: number): PageSlot => (page <= pageCount ? page : "blank");
  const sheets = Array.from({ length: sheetCount }, (_, index): BookletSheet => {
    const position = index % sheetsPerSignature;
    const signature = (index - position) / sheetsPerSignature;
    const base = signature * pagesPerSignature;
    const n = pagesPerSignature;
    const front: BookletSide = [slot(base + n - 2 * position), slot(base + 1 + 2 * position)];
    const back: BookletSide = [slot(base + 2 + 2 * position), slot(base + n - 1 - 2 * position)];
    return {
      index,
      signature,
      position,
      front: orient(front, binding),
      back: orient(back, binding),
      creep: creep * position,
    };
  });

  return {
    pageCount,
    paddedPageCount,
    blankCount: paddedPageCount - pageCount,
    pagesPerSignature,
    sheetsPerSignature,
    signatureCount,
    binding,
    sheets,
  };
}
