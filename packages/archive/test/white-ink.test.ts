import { describe, expect, it } from 'vitest';
import type { WhiteInkSetting } from '@bax-print/core';
import { sha256Hex } from '@bax-print/store';
import { JOB_PATH, MANIFEST_PATH, readZip, unpack, validateManifest, writeZip } from '../src/index.js';
import { bytesOf, createHarness, DEFAULT_ARTIFACTS, seedJob, type Harness } from './helpers.js';

const WHITE: WhiteInkSetting = { mode: 'choke', chokePx: 2, shape: 'diamond', density: 80, separationName: 'White' };

/** Builds a package on a separate "remote" installation. */
async function remotePackage(whiteInk?: WhiteInkSetting): Promise<Uint8Array> {
  const remote = createHarness({ idPrefix: 'remote' });
  await seedJob(remote, { id: 'remote-001', artifacts: DEFAULT_ARTIFACTS, ...(whiteInk ? { whiteInk } : {}) });
  await remote.service.archive('remote-001');
  return remote.service.getPackage('remote-001');
}

/** Rewrites job.json with the given raw `whiteInk` and re-records its hash, as a foreign writer could. */
function withRawWhiteInk(bytes: Uint8Array, whiteInk: unknown): Uint8Array {
  const entries = readZip(bytes);
  const jobData = entries.get(JOB_PATH);
  const manifestData = entries.get(MANIFEST_PATH);
  if (jobData === undefined || manifestData === undefined) throw new Error('package lacks job.json or manifest.json');
  const record: unknown = JSON.parse(Buffer.from(jobData).toString('utf8'));
  if (typeof record === 'object' && record) {
    const edited = bytesOf(`${JSON.stringify({ ...record, whiteInk })}\n`);
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

async function expectNoWhiteInk(h: Harness, jobId: string): Promise<void> {
  const saved = await h.jobs.get(jobId);
  expect(saved).toBeDefined();
  expect(saved !== undefined && 'whiteInk' in saved).toBe(false);
  const row = await h.index.get(jobId);
  expect(row).toBeDefined();
  expect(row !== undefined && 'whiteInk' in row).toBe(false);
  const repacked = unpack(await h.service.getPackage(jobId));
  expect('whiteInk' in repacked.job).toBe(false);
}

describe('whiteInk on archive import (spec 038d)', () => {
  it.each<unknown>(['yes', 1, null, { mode: 'x' }, { mode: 'flood', extra: 1 }])(
    'drops an invalid whiteInk %j from job.json',
    async (whiteInk) => {
      const bytes = withRawWhiteInk(await remotePackage(), whiteInk);
      expect(unpack(bytes).job).toHaveProperty('whiteInk', whiteInk);
      const h = createHarness({ idPrefix: 'local' });

      const { job } = await h.service.importPackage(bytes);

      expect('whiteInk' in job).toBe(false);
      await expectNoWhiteInk(h, job.id);
    },
  );

  it('keeps a valid whiteInk through import and the re-packed package', async () => {
    const h = createHarness({ idPrefix: 'local' });

    const { job } = await h.service.importPackage(await remotePackage(WHITE));

    expect(job.whiteInk).toEqual(WHITE);
    expect((await h.jobs.get(job.id))?.whiteInk).toEqual(WHITE);
    expect(unpack(await h.service.getPackage(job.id)).job.whiteInk).toEqual(WHITE);
  });

  it('adds no whiteInk key when the package has none', async () => {
    const bytes = await remotePackage();
    expect('whiteInk' in unpack(bytes).job).toBe(false);
    const h = createHarness({ idPrefix: 'local' });

    const { job } = await h.service.importPackage(bytes);

    expect('whiteInk' in job).toBe(false);
    await expectNoWhiteInk(h, job.id);
  });
});

describe('whiteInk on export (spec 038d)', () => {
  it('exports a finished active job with its whiteInk and re-imports it', async () => {
    const remote = createHarness({ idPrefix: 'remote' });
    await seedJob(remote, { id: 'remote-002', whiteInk: WHITE });

    const bytes = await remote.service.getPackage('remote-002');
    expect(unpack(bytes).job.whiteInk).toEqual(WHITE);

    const h = createHarness({ idPrefix: 'local' });
    const { job } = await h.service.importPackage(bytes);
    expect(job.whiteInk).toEqual(WHITE);
  });

  it('archives a job with its whiteInk in the package', async () => {
    const bytes = await remotePackage(WHITE);
    expect(unpack(bytes).job.whiteInk).toEqual(WHITE);
  });
});
