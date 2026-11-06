import { describe, expect, it } from 'vitest';
import type { PlaneCurvesSetting, ScreeningSetting, TilingSetting } from '@bax-print/core';
import { sha256Hex } from '@bax-print/store';
import { JOB_PATH, MANIFEST_PATH, readZip, unpack, validateManifest, writeZip } from '../src/index.js';
import { bytesOf, createHarness, DEFAULT_ARTIFACTS, seedJob, type Harness } from './helpers.js';

const BAYER: ScreeningSetting = { kind: 'bayer', size: 8 };
const CURVES: PlaneCurvesSetting = {
  k: { points: [{ in: 0, out: 0 }, { in: 128, out: 112 }, { in: 255, out: 255 }], method: 'monotone' },
};
const GRID: TilingSetting = { grid: { columns: 3, rows: 2 } };
const GAP: TilingSetting = { grid: { columns: 500, rows: 500 }, seam: { kind: 'gap', gapMm: 20 } };
const OVERLAP: TilingSetting = { grid: { columns: 1, rows: 4 }, seam: { kind: 'overlap', overlapMm: 1000 } };

/** Builds a package on a separate "remote" installation. */
async function remotePackage(tiling?: TilingSetting): Promise<Uint8Array> {
  const remote = createHarness({ idPrefix: 'remote' });
  await seedJob(remote, {
    id: 'remote-001',
    artifacts: DEFAULT_ARTIFACTS,
    screening: BAYER,
    planeCurves: CURVES,
    ...(tiling ? { tiling } : {}),
  });
  await remote.service.archive('remote-001');
  return remote.service.getPackage('remote-001');
}

/** Rewrites job.json with the given raw `tiling` and re-records its hash, as a foreign writer could. */
function withRawTiling(bytes: Uint8Array, tiling: unknown): Uint8Array {
  const entries = readZip(bytes);
  const jobData = entries.get(JOB_PATH);
  const manifestData = entries.get(MANIFEST_PATH);
  if (jobData === undefined || manifestData === undefined) throw new Error('package lacks job.json or manifest.json');
  const record: unknown = JSON.parse(Buffer.from(jobData).toString('utf8'));
  if (typeof record === 'object' && record) {
    const edited = bytesOf(`${JSON.stringify({ ...record, tiling })}\n`);
    const manifest = validateManifest(JSON.parse(Buffer.from(manifestData).toString('utf8')));
    const members = manifest.members.map((member) =>
      member.path === JOB_PATH ? { ...member, sha256: sha256Hex(edited), size: edited.byteLength } : member,
    );
    const rewritten = new Map<string, Uint8Array>([
      ...entries,
      [JOB_PATH, edited],
      [MANIFEST_PATH, bytesOf(JSON.stringify({ ...manifest, members }))],
    ]);
    return writeZip([...rewritten].map(([name, data]) => ({ name, data })));
  }
  throw new Error('job.json is not an object');
}

async function expectNoTiling(h: Harness, jobId: string): Promise<void> {
  const saved = await h.jobs.get(jobId);
  expect(saved).toBeDefined();
  expect(saved).not.toHaveProperty('tiling');
  expect(saved?.screening).toEqual(BAYER);
  expect(saved?.planeCurves).toEqual(CURVES);
  const row = await h.index.get(jobId);
  expect(row).toBeDefined();
  expect(row).not.toHaveProperty('tiling');
  const repacked = unpack(await h.service.getPackage(jobId));
  expect('tiling' in repacked.job).toBe(false);
}

describe('tiling on archive import (spec 050a)', () => {
  it.each<unknown>([
    'yes',
    null,
    {},
    { grid: { columns: 0, rows: 1 } },
    { grid: { columns: 2, rows: 501 } },
    { grid: { columns: 2, rows: 2 }, seam: { kind: 'gap' } },
    { grid: { columns: 2, rows: 2 }, seam: { kind: 'butt', gapMm: 3 } },
    { grid: { columns: 2, rows: 2 }, seam: { kind: 'overlap', overlapMm: 1000.5 } },
    { grid: { mode: 'count', columns: 2, rows: 2 } },
    { grid: { columns: 2, rows: 2 }, naming: { rows: 'letters' } },
  ])('drops an invalid tiling %j from job.json', async (tiling) => {
    const bytes = withRawTiling(await remotePackage(), tiling);
    expect(unpack(bytes).job).toHaveProperty('tiling', tiling);
    const h = createHarness({ idPrefix: 'local' });

    const { job } = await h.service.importPackage(bytes);

    expect('tiling' in job).toBe(false);
    expect(job.screening).toEqual(BAYER);
    expect(job.planeCurves).toEqual(CURVES);
    await expectNoTiling(h, job.id);
  });

  it.each<TilingSetting>([GRID, GAP, OVERLAP])('keeps a valid tiling %j through import and the re-packed package', async (tiling) => {
    const h = createHarness({ idPrefix: 'local' });

    const { job } = await h.service.importPackage(await remotePackage(tiling));

    expect(job.tiling).toEqual(tiling);
    expect(job.screening).toEqual(BAYER);
    expect(job.planeCurves).toEqual(CURVES);
    expect((await h.jobs.get(job.id))?.tiling).toEqual(tiling);
    expect(unpack(await h.service.getPackage(job.id)).job.tiling).toEqual(tiling);
  });

  it('adds no tiling key when the package has none and stores the job byte-identical', async () => {
    const bytes = await remotePackage();
    expect('tiling' in unpack(bytes).job).toBe(false);
    const h = createHarness({ idPrefix: 'local' });

    const { job } = await h.service.importPackage(bytes);

    expect('tiling' in job).toBe(false);
    expect(JSON.stringify(await h.jobs.get(job.id))).toBe(JSON.stringify(job));
    await expectNoTiling(h, job.id);
  });
});
