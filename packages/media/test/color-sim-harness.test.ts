import { describe, expect, it } from 'vitest';
import type { MeasurementLayout } from '@bax-print/plugin-sdk';
import { ColorSimHarness, type PrintedPatch } from './color-sim-harness.js';

const SEED = 42;
const CHART_ID = 'smoke-chart';

const PATCHES: readonly PrintedPatch[] = [
  { patchId: 'p1', cmyk: { c: 0, m: 0, y: 0, k: 0 } },
  { patchId: 'p2', cmyk: { c: 100, m: 0, y: 0, k: 0 } },
  { patchId: 'p3', cmyk: { c: 0, m: 100, y: 0, k: 0 } },
  { patchId: 'p4', cmyk: { c: 0, m: 0, y: 0, k: 100 } },
];

const LAYOUT: MeasurementLayout = {
  chartId: CHART_ID,
  patchSizeMm: 6,
  condition: 'M1',
  strips: [{ stripId: 's1', patchIds: PATCHES.map((patch) => patch.patchId) }],
};

async function runOnce(): Promise<{ measured: unknown; exitCode: number | null }> {
  const harness = await ColorSimHarness.start();
  try {
    await harness.configure({ seed: SEED });
    await harness.printChart(CHART_ID, PATCHES);
    const measured = await harness.measureStrip(LAYOUT);
    const { code } = await harness.close();
    return { measured, exitCode: code };
  } catch (error) {
    await harness.close().catch(() => undefined);
    throw error;
  }
}

describe('color-sim harness', () => {
  it('measures deterministically for a fixed seed and exits cleanly', async () => {
    const first = await runOnce();
    const second = await runOnce();

    expect(first.measured).toBeDefined();
    expect(second.measured).toEqual(first.measured);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
  }, 30_000);
});
