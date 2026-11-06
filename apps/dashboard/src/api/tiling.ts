import type { Job } from './types';

/**
 * Spec 050a: the tiling a job carries, as GET /jobs/:id returns it (see TilingSetting in
 * packages/core/src/tiling-setting.ts; the server drops invalid values, so a present setting is valid).
 * A local copy: the dashboard does not import core. Kept out of `types.ts` so the flag-off production
 * build, including its source maps, stays byte-identical (Spec 049c).
 */

export interface JobTilingGrid {
  /** Panels across, integer 1..500. */
  readonly columns: number;
  /** Panels down, integer 1..500. */
  readonly rows: number;
}

/** How neighbouring panels meet, as tile's `SeamTreatment`. */
export type JobTilingSeam =
  | { readonly kind: 'butt' }
  /** Without `overlapMm`, tile uses its default overlap of 25 mm. */
  | { readonly kind: 'overlap'; readonly overlapMm?: number }
  | { readonly kind: 'gap'; readonly gapMm: number };

export interface JobTiling {
  readonly grid: JobTilingGrid;
  /** Without `seam`, tile uses its default seam (an overlap of 25 mm). */
  readonly seam?: JobTilingSeam;
}

/** A job with its optional tiling setting. Absent means the job is not tiled. */
export type JobWithTiling = Job & { tiling?: JobTiling };
