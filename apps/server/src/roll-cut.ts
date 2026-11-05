import type { Job } from '@bax-print/core';
import type { CutContourSelection } from '@bax-print/cut-export';
import type { Layout } from '@bax-print/nest';
import type { Contour } from '@bax-print/plugin-sdk';
import type { CutExtractor } from './cut-routes.js';

/** What a step-and-repeat job contributes to its cut job: the roll size and one contour per copy. */
export interface RollCut {
  readonly layout: Pick<Layout, 'mediaWidthPt' | 'lengthUsedPt'>;
  readonly cutContours: readonly Contour[];
}

/**
 * Connects `POST /jobs/:id/step-repeat` to `POST /jobs/:id/cut-job` (Spec 003v): pass `onJob` as
 * `stepRepeat.onJob` and `extractor` as `cutExtractor`.
 */
export interface RollCutExtractor {
  readonly onJob: (result: RollCut, job: Pick<Job, 'id'>) => void;
  readonly extractor: CutExtractor;
}

function matches(contour: Contour, selection: CutContourSelection): boolean {
  const names = contour.source.kind === 'spot' ? selection.spotNames : selection.layerNames;
  return names?.includes(contour.source.name) ?? false;
}

/**
 * Wraps a page cut extractor. Once a job is stepped and repeated, its cut job is planned on the
 * roll: the frame is the media width by the length used, and the extraction stage returns the
 * copies' contours that match the selection. Jobs without a roll layout fall through to `base`.
 */
export function createRollCutExtractor(base: CutExtractor): RollCutExtractor {
  const rolls = new Map<string, RollCut>();
  return {
    onJob: (result, job) => {
      rolls.set(job.id, result);
    },
    extractor: async (job) => {
      const page = await base(job);
      const roll = rolls.get(job.id);
      if (!page || !roll) return page;
      return {
        ...page,
        frame: { widthPt: roll.layout.mediaWidthPt, heightPt: roll.layout.lengthUsedPt },
        extract: (selection) => roll.cutContours.filter((contour) => matches(contour, selection)),
      };
    },
  };
}
