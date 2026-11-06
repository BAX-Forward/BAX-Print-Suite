import { describe, expect, it } from 'vitest';
import type { ScreeningSetting, WhiteInkSetting } from '@bax-print/core';
import { sha256Hex } from '@bax-print/store';
import { JOB_PATH, MANIFEST_PATH, readZip, unpack, validateManifest, writeZip } from '../src/index.js';
import { bytesOf, createHarness, DEFAULT_ARTIFACTS, seedJob, type Harness } from './helpers.js';

const BLUE: ScreeningSetting = { kind: 'blue-noise', size: 64, seed: 1234 };
const WHITE: WhiteInkSetting = { mode: 'flood', density: 90 };

/** Builds a package on a separate "remote" installation. */
async function remotePackage(screening?: ScreeningSetting): Promise<Uint8Array> {
  const remote = createHarness({ idPrefix: 'remote' });
  await seedJob(remote, {
    id: 'remote-001',
    artifacts: DEFAULT_ARTIFACTS,
    whiteInk: WHITE,
    ...(screening ? { screening } : {}),
  });
  await remote.service.archive('remote-001');
  return remote.service.getPackage('remote-001');
}

/** Rewrites job.json with the given raw `screening` and re-records its hash, as a foreign writer could. */
function withRawScreening(bytes: Uint8Array, screening: unknown): Uint8Array {
  const entries = readZip(bytes);
  const jobData = entries.get(JOB_PATH);
  const manifestData = entries.get(MANIFEST_PATH);
  if (jobData === undefined || manifestData === undefined) throw new Error('package lacks job.json or manifest.json');
  const record: unknown = JSON.parse(Buffer.from(jobData).toString('utf8'));
  if (typeof record === 'object' && record) {
    const edited = bytesOf(`${JSON.stringify({ ...record, screening })}\n`);
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

async function expectNoScreening(h: Harness, jobId: string): Promise<void> {
  const saved = await h.jobs.get(jobId);
  expect(saved).toBeDefined();
  expect(saved !== undefined && 'screening' in saved).toBe(false);
  expect(saved?.whiteInk).toEqual(WHITE);
  const row = await h.index.get(jobId);
  expect(row).toBeDefined();
  expect(row !== undefined && 'screening' in row).toBe(false);
  const repacked = unpack(await h.service.getPackage(jobId));
  expect('screening' in repacked.job).toBe(false);
}

describe('screening on archive import (spec 039b)', () => {
  it.each<unknown>([
    'yes',
    null,
    { kind: 'x' },
    { kind: 'bayer', size: 3 },
    { kind: 'blue-noise', size: 300, seed: 1 },
    { kind: 'bayer', size: 4, extra: 1 },
  ])('drops an invalid screening %j from job.json', async (screening) => {
    const bytes = withRawScreening(await remotePackage(), screening);
    expect(unpack(bytes).job).toHaveProperty('screening', screening);
    const h = createHarness({ idPrefix: 'local' });

    const { job } = await h.service.importPackage(bytes);

    expect('screening' in job).toBe(false);
    expect(job.whiteInk).toEqual(WHITE);
    await expectNoScreening(h, job.id);
  });

  it.each<ScreeningSetting>([BLUE, { kind: 'bayer', size: 4 }])(
    'keeps a valid screening %j through import and the re-packed package',
    async (screening) => {
      const h = createHarness({ idPrefix: 'local' });

      const { job } = await h.service.importPackage(await remotePackage(screening));

      expect(job.screening).toEqual(screening);
      expect(job.whiteInk).toEqual(WHITE);
      expect((await h.jobs.get(job.id))?.screening).toEqual(screening);
      expect(unpack(await h.service.getPackage(job.id)).job.screening).toEqual(screening);
    },
  );

  it('adds no screening key when the package has none', async () => {
    const bytes = await remotePackage();
    expect('screening' in unpack(bytes).job).toBe(false);
    const h = createHarness({ idPrefix: 'local' });

    const { job } = await h.service.importPackage(bytes);

    expect('screening' in job).toBe(false);
    await expectNoScreening(h, job.id);
  });
});
