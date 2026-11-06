import { describe, expect, it } from 'vitest';
import type { InkLimitSetting, PlaneCurvesSetting, ScreeningSetting } from '@bax-print/core';
import { sha256Hex } from '@bax-print/store';
import { JOB_PATH, MANIFEST_PATH, readZip, unpack, validateManifest, writeZip } from '../src/index.js';
import { bytesOf, createHarness, DEFAULT_ARTIFACTS, seedJob, type Harness } from './helpers.js';

const GCR: InkLimitSetting = { limitPercent: 280, method: 'gcr' };
const BAYER: ScreeningSetting = { kind: 'bayer', size: 8 };
const CYAN: PlaneCurvesSetting = {
  c: { points: [{ in: 0, out: 0 }, { in: 128, out: 112 }, { in: 255, out: 255 }], method: 'monotone' },
};
const ALL: PlaneCurvesSetting = {
  c: { points: [{ in: 0, out: 0 }, { in: 255, out: 240 }], method: 'linear' },
  m: { points: [{ in: 0, out: 4 }, { in: 255, out: 255 }], method: 'monotone' },
  y: { points: [{ in: 0, out: 0 }, { in: 255, out: 255 }], method: 'linear' },
  k: { points: [{ in: 0, out: 0 }, { in: 64, out: 64 }, { in: 255, out: 250 }], method: 'monotone' },
};

/** Builds a package on a separate "remote" installation. */
async function remotePackage(planeCurves?: PlaneCurvesSetting): Promise<Uint8Array> {
  const remote = createHarness({ idPrefix: 'remote' });
  await seedJob(remote, {
    id: 'remote-001',
    artifacts: DEFAULT_ARTIFACTS,
    screening: BAYER,
    inkLimit: GCR,
    ...(planeCurves ? { planeCurves } : {}),
  });
  await remote.service.archive('remote-001');
  return remote.service.getPackage('remote-001');
}

/** Rewrites job.json with the given raw `planeCurves` and re-records its hash, as a foreign writer could. */
function withRawPlaneCurves(bytes: Uint8Array, planeCurves: unknown): Uint8Array {
  const entries = readZip(bytes);
  const jobData = entries.get(JOB_PATH);
  const manifestData = entries.get(MANIFEST_PATH);
  if (jobData === undefined || manifestData === undefined) throw new Error('package lacks job.json or manifest.json');
  const record: unknown = JSON.parse(Buffer.from(jobData).toString('utf8'));
  if (typeof record === 'object' && record) {
    const edited = bytesOf(`${JSON.stringify({ ...record, planeCurves })}\n`);
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

async function expectNoPlaneCurves(h: Harness, jobId: string): Promise<void> {
  const saved = await h.jobs.get(jobId);
  expect(saved).toBeDefined();
  expect(saved).not.toHaveProperty('planeCurves');
  expect(saved?.screening).toEqual(BAYER);
  expect(saved?.inkLimit).toEqual(GCR);
  const row = await h.index.get(jobId);
  expect(row).toBeDefined();
  expect(row).not.toHaveProperty('planeCurves');
  const repacked = unpack(await h.service.getPackage(jobId));
  expect('planeCurves' in repacked.job).toBe(false);
}

describe('planeCurves on archive import (spec 044b)', () => {
  it.each<unknown>([
    'yes',
    null,
    {},
    { c: { points: [{ in: 0, out: 0 }], method: 'linear' } },
    { c: { points: [{ in: 0, out: 0 }, { in: 254, out: 255 }], method: 'linear' } },
    { c: { points: [{ in: 0, out: 0 }, { in: 128, out: 0 }, { in: 128, out: 9 }, { in: 255, out: 255 }], method: 'linear' } },
    { k: { points: [{ in: 0, out: 50 }, { in: 255, out: 40 }], method: 'monotone' } },
    { c: { points: [{ in: 0, out: 0 }, { in: 255, out: 255 }], method: 'spline' } },
    { c: { points: [{ in: 0, out: 0 }, { in: 255, out: 255 }], method: 'linear' }, w: 1 },
  ])('drops an invalid planeCurves %j from job.json', async (planeCurves) => {
    const bytes = withRawPlaneCurves(await remotePackage(), planeCurves);
    expect(unpack(bytes).job).toHaveProperty('planeCurves', planeCurves);
    const h = createHarness({ idPrefix: 'local' });

    const { job } = await h.service.importPackage(bytes);

    expect('planeCurves' in job).toBe(false);
    expect(job.screening).toEqual(BAYER);
    expect(job.inkLimit).toEqual(GCR);
    await expectNoPlaneCurves(h, job.id);
  });

  it.each<PlaneCurvesSetting>([CYAN, ALL])(
    'keeps a valid planeCurves %j through import and the re-packed package',
    async (planeCurves) => {
      const h = createHarness({ idPrefix: 'local' });

      const { job } = await h.service.importPackage(await remotePackage(planeCurves));

      expect(job.planeCurves).toEqual(planeCurves);
      expect(job.screening).toEqual(BAYER);
      expect(job.inkLimit).toEqual(GCR);
      expect((await h.jobs.get(job.id))?.planeCurves).toEqual(planeCurves);
      expect(unpack(await h.service.getPackage(job.id)).job.planeCurves).toEqual(planeCurves);
    },
  );

  it('adds no planeCurves key when the package has none', async () => {
    const bytes = await remotePackage();
    expect('planeCurves' in unpack(bytes).job).toBe(false);
    const h = createHarness({ idPrefix: 'local' });

    const { job } = await h.service.importPackage(bytes);

    expect('planeCurves' in job).toBe(false);
    await expectNoPlaneCurves(h, job.id);
  });
});
