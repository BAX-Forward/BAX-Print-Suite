import { describe, expect, it } from 'vitest';
import type { InkLimitSetting, ScreeningSetting, WhiteInkSetting } from '@bax-print/core';
import { sha256Hex } from '@bax-print/store';
import { JOB_PATH, MANIFEST_PATH, readZip, unpack, validateManifest, writeZip } from '../src/index.js';
import { bytesOf, createHarness, DEFAULT_ARTIFACTS, seedJob, type Harness } from './helpers.js';

const GCR: InkLimitSetting = { limitPercent: 280, method: 'gcr' };
const WHITE: WhiteInkSetting = { mode: 'flood', density: 90 };
const BAYER: ScreeningSetting = { kind: 'bayer', size: 8 };

/** Builds a package on a separate "remote" installation. */
async function remotePackage(inkLimit?: InkLimitSetting): Promise<Uint8Array> {
  const remote = createHarness({ idPrefix: 'remote' });
  await seedJob(remote, {
    id: 'remote-001',
    artifacts: DEFAULT_ARTIFACTS,
    whiteInk: WHITE,
    screening: BAYER,
    ...(inkLimit ? { inkLimit } : {}),
  });
  await remote.service.archive('remote-001');
  return remote.service.getPackage('remote-001');
}

/** Rewrites job.json with the given raw `inkLimit` and re-records its hash, as a foreign writer could. */
function withRawInkLimit(bytes: Uint8Array, inkLimit: unknown): Uint8Array {
  const entries = readZip(bytes);
  const jobData = entries.get(JOB_PATH);
  const manifestData = entries.get(MANIFEST_PATH);
  if (jobData === undefined || manifestData === undefined) throw new Error('package lacks job.json or manifest.json');
  const record: unknown = JSON.parse(Buffer.from(jobData).toString('utf8'));
  if (typeof record === 'object' && record) {
    const edited = bytesOf(`${JSON.stringify({ ...record, inkLimit })}\n`);
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

async function expectNoInkLimit(h: Harness, jobId: string): Promise<void> {
  const saved = await h.jobs.get(jobId);
  expect(saved).toBeDefined();
  expect(saved !== undefined && 'inkLimit' in saved).toBe(false);
  expect(saved?.whiteInk).toEqual(WHITE);
  expect(saved?.screening).toEqual(BAYER);
  const row = await h.index.get(jobId);
  expect(row).toBeDefined();
  expect(row !== undefined && 'inkLimit' in row).toBe(false);
  const repacked = unpack(await h.service.getPackage(jobId));
  expect('inkLimit' in repacked.job).toBe(false);
}

describe('inkLimit on archive import (spec 040b)', () => {
  it.each<unknown>([
    'yes',
    null,
    { limitPercent: 99, method: 'gcr' },
    { limitPercent: 401, method: 'gcr' },
    { limitPercent: 250.5, method: 'proportional' },
    { limitPercent: 300, method: 'gcr2' },
    { limitPercent: 300, method: 'gcr', extra: 1 },
  ])('drops an invalid inkLimit %j from job.json', async (inkLimit) => {
    const bytes = withRawInkLimit(await remotePackage(), inkLimit);
    expect(unpack(bytes).job).toHaveProperty('inkLimit', inkLimit);
    const h = createHarness({ idPrefix: 'local' });

    const { job } = await h.service.importPackage(bytes);

    expect('inkLimit' in job).toBe(false);
    expect(job.whiteInk).toEqual(WHITE);
    expect(job.screening).toEqual(BAYER);
    await expectNoInkLimit(h, job.id);
  });

  it.each<InkLimitSetting>([GCR, { limitPercent: 400, method: 'proportional' }])(
    'keeps a valid inkLimit %j through import and the re-packed package',
    async (inkLimit) => {
      const h = createHarness({ idPrefix: 'local' });

      const { job } = await h.service.importPackage(await remotePackage(inkLimit));

      expect(job.inkLimit).toEqual(inkLimit);
      expect(job.whiteInk).toEqual(WHITE);
      expect(job.screening).toEqual(BAYER);
      expect((await h.jobs.get(job.id))?.inkLimit).toEqual(inkLimit);
      expect(unpack(await h.service.getPackage(job.id)).job.inkLimit).toEqual(inkLimit);
    },
  );

  it('adds no inkLimit key when the package has none', async () => {
    const bytes = await remotePackage();
    expect('inkLimit' in unpack(bytes).job).toBe(false);
    const h = createHarness({ idPrefix: 'local' });

    const { job } = await h.service.importPackage(bytes);

    expect('inkLimit' in job).toBe(false);
    await expectNoInkLimit(h, job.id);
  });
});
