import { describe, expect, it } from 'vitest';
import type { Job } from '@bax-print/core';
import type { Contour } from '@bax-print/plugin-sdk';
import type { CutExtractor } from '../src/cut-routes.js';
import type { CutPlanDeps } from '../src/cut-service.js';
import { createRollCutExtractor, type RollCut } from '../src/roll-cut.js';
import { TICKET } from './helpers.js';

const PAGE_CONTOUR: Contour = square('page', { kind: 'spot', name: 'CutContour' });

function square(id: string, source: Contour['source']): Contour {
  return {
    id,
    tool: 'kiss',
    source,
    closed: true,
    points: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    areaSigned: 100,
  };
}

const PAGE: CutPlanDeps = {
  pageBoxes: { mediaBox: { x0: 0, y0: 0, x1: 200, y1: 100 } },
  frame: { widthPt: 200, heightPt: 100 },
  toolMap: {},
  cut: { layerNames: ['trim'] },
  extract: () => [PAGE_CONTOUR],
};

const base: CutExtractor = async () => PAGE;

function job(id: string): Job {
  return {
    id,
    name: id,
    status: 'done',
    priority: 0,
    sourceFiles: [],
    artifacts: [],
    ticket: TICKET,
    tags: [],
    metadata: {},
    createdAt: '2026-03-01T08:00:00.000Z',
    updatedAt: '2026-03-01T08:00:00.000Z',
    lifecycle: 'active',
    legalHold: false,
  };
}

/** Only what the adapter reads from a step-and-repeat job: the layout size and the contours. */
function rollOf(contours: Contour[]): RollCut {
  return { layout: { mediaWidthPt: 850, lengthUsedPt: 200 }, cutContours: contours };
}

describe('createRollCutExtractor (Spec 003v)', () => {
  it('passes a job without a roll layout through to the page extractor', async () => {
    const roll = createRollCutExtractor(base);

    expect(await roll.extractor(job('job-1'))).toBe(PAGE);
  });

  it('answers undefined when the page extractor finds no page, even after step and repeat', async () => {
    const roll = createRollCutExtractor(async () => undefined);
    roll.onJob(rollOf([square('copy-0', { kind: 'layer', name: 'trim' })]), job('job-1'));

    expect(await roll.extractor(job('job-1'))).toBeUndefined();
  });

  it('plans a stepped-and-repeated job on the roll with the copies matching the selection', async () => {
    const roll = createRollCutExtractor(base);
    const trim = [square('copy-0', { kind: 'layer', name: 'trim' }), square('copy-1', { kind: 'layer', name: 'trim' })];
    const spot = square('spot-0', { kind: 'spot', name: 'trim' });
    roll.onJob(rollOf([...trim, spot]), job('job-1'));

    const page = await roll.extractor(job('job-1'));

    expect(page?.frame).toEqual({ widthPt: 850, heightPt: 200 });
    expect(page?.pageBoxes).toBe(PAGE.pageBoxes);
    expect(await page?.extract({ layerNames: ['trim'] })).toEqual(trim);
    expect(await page?.extract({ spotNames: ['trim'] })).toEqual([spot]);
    expect(await page?.extract({})).toEqual([]);
  });

  it('keeps the rolls of different jobs apart', async () => {
    const roll = createRollCutExtractor(base);
    roll.onJob(rollOf([square('copy-0', { kind: 'layer', name: 'trim' })]), job('job-1'));

    expect(await roll.extractor(job('job-2'))).toBe(PAGE);
  });
});
