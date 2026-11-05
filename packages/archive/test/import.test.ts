import { describe, expect, it } from 'vitest';
import { EventTypes } from '@bax-print/events';
import { sha256Hex } from '@bax-print/store';
import {
  IMPORTED_FROM_KEY,
  PackageIntegrityError,
  readZip,
  RemapRequiredError,
  unpack,
  writeZip,
  type DeviceMediaCatalog,
} from '../src/index.js';
import {
  bytesOf,
  createHarness,
  DEFAULT_ARTIFACTS,
  DEVICE_A,
  MEDIUM_GLOSS,
  revision,
  seedJob,
  typesOf,
  type Harness,
} from './helpers.js';

const LOCAL_DEVICE = 'local-printer';
const LOCAL_MEDIUM = 'local-gloss';
const REV = 'rev-remote-1';
const OPEN_PROFILE = bytesOf('open profile');

function catalog(devices: readonly string[], media: readonly string[]): DeviceMediaCatalog {
  return {
    hasDevice: async (id) => devices.includes(id),
    hasMedium: async (id) => media.includes(id),
  };
}

/** Builds a package on a separate "remote" installation. */
async function remotePackage(): Promise<Uint8Array> {
  const remote = createHarness({ idPrefix: 'remote' });
  remote.colorSetups
    .addRevision(
      revision(REV, DEVICE_A, MEDIUM_GLOSS, [
        { id: 'prof-open', fileName: 'open.icc', sha256: sha256Hex(OPEN_PROFILE), redistributable: true },
      ]),
    )
    .addProfile('prof-open', OPEN_PROFILE);
  await seedJob(remote, {
    id: 'remote-001',
    name: 'Shop window',
    customerRef: 'C-500',
    deviceId: DEVICE_A,
    mediumId: MEDIUM_GLOSS,
    colorSetupRevisionId: REV,
    tags: ['window'],
    artifacts: DEFAULT_ARTIFACTS,
  });
  remote.bus.publish({
    type: EventTypes.jobCreated,
    source: '/bps/jobs',
    subject: 'remote-001',
    data: { jobId: 'remote-001', name: 'Shop window', status: 'received' },
  });
  await remote.service.archive('remote-001');
  return remote.service.getPackage('remote-001');
}

async function expectNothingImported(h: Harness): Promise<void> {
  expect(await h.jobs.list()).toEqual([]);
  expect(await h.archive.list()).toEqual([]);
  expect((await h.index.search({})).items).toEqual([]);
  expect(typesOf(h, ['job.imported'])).toEqual([]);
}

describe('import of a .bpsjob from another installation', () => {
  it('asks for a remap when the device or medium is unknown here', async () => {
    const bytes = await remotePackage();
    const h = createHarness({ idPrefix: 'local', catalog: catalog([LOCAL_DEVICE], [LOCAL_MEDIUM]) });

    const error = await h.service.importPackage(bytes).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemapRequiredError);
    expect((error as RemapRequiredError).unknownDevices).toEqual([DEVICE_A]);
    expect((error as RemapRequiredError).unknownMedia).toEqual([MEDIUM_GLOSS]);
    await expectNothingImported(h);
  });

  it('imports with user-chosen device and medium as a new archived job, dropping the foreign color setup', async () => {
    const bytes = await remotePackage();
    const h = createHarness({ idPrefix: 'local', catalog: catalog([LOCAL_DEVICE], [LOCAL_MEDIUM]) });

    const { job, warnings } = await h.service.importPackage(bytes, {
      deviceMap: { [DEVICE_A]: LOCAL_DEVICE },
      mediumMap: { [MEDIUM_GLOSS]: LOCAL_MEDIUM },
    });

    expect(job.id).toBe('local-job-0001');
    expect(job.lifecycle).toBe('archived');
    expect(job.deviceId).toBe(LOCAL_DEVICE);
    expect(job.mediumId).toBe(LOCAL_MEDIUM);
    expect(job.colorSetupRevisionId).toBeUndefined();
    expect(job.metadata[IMPORTED_FROM_KEY]).toBe('remote-001');
    expect(job.customerRef).toBe('C-500');
    expect(warnings.some((w) => w.includes(REV))).toBe(true);

    const stored = unpack(await h.service.getPackage(job.id));
    expect(stored.manifest.jobId).toBe(job.id);
    const original = unpack(bytes);
    expect(stored.history.length).toBeGreaterThan(0);
    expect(stored.history).toEqual(original.history);
    expect(sha256Hex(stored.profiles.get('prof-open') as Uint8Array)).toBe(sha256Hex(OPEN_PROFILE));
    expect(stored.sources.map(sha256Hex)).toEqual(original.sources.map(sha256Hex));
    expect(stored.artifacts.map(sha256Hex)).toEqual(original.artifacts.map(sha256Hex));

    expect(await h.index.get(job.id)).toMatchObject({ jobId: job.id, deviceId: LOCAL_DEVICE, customerRef: 'C-500' });
    const imported = h.outbox.list({ types: ['job.imported'] });
    expect(imported).toHaveLength(1);
    expect(imported[0]!.event.data).toMatchObject({ jobId: job.id, importedFrom: 'remote-001', deviceId: LOCAL_DEVICE });

    // The imported job can be restored with hash-identical blobs.
    const restored = await h.service.restore(job.id);
    for (const file of [...restored.sourceFiles, ...restored.artifacts]) {
      expect(sha256Hex(await h.blobs.get(file.storageKey))).toBe(file.sha256);
    }
  });

  it('keeps the color setup revision when the same device, medium and revision exist here', async () => {
    const bytes = await remotePackage();
    const h = createHarness({ idPrefix: 'local' });
    h.colorSetups.addRevision(revision(REV, DEVICE_A, MEDIUM_GLOSS));

    const { job, warnings } = await h.service.importPackage(bytes);
    expect(job.colorSetupRevisionId).toBe(REV);
    expect(warnings).toEqual([]);

    const { job: reprint } = await h.service.reprint(job.id);
    expect(reprint.colorSetupRevisionId).toBe(REV);
    expect(reprint.reprintOf).toBe(job.id);
  });

  it('validates hashes and rejects a tampered package without importing anything', async () => {
    const bytes = await remotePackage();
    const entries = readZip(bytes);
    entries.set('ticket.json', bytesOf('{"intent":{"quantity":999},"process":{}}'));
    const tampered = writeZip([...entries].map(([name, data]) => ({ name, data })));

    const h = createHarness({ idPrefix: 'local' });
    await expect(h.service.importPackage(tampered)).rejects.toThrow(PackageIntegrityError);
    await expectNothingImported(h);
  });

  it('rejects viewers', async () => {
    const bytes = await remotePackage();
    const h = createHarness({ idPrefix: 'local' });
    await expect(h.service.importPackage(bytes, {}, { id: 'guest', role: 'viewer' })).rejects.toThrow(/operator role/);
  });
});

describe('XJDF export of the ticket', () => {
  it('writes product intent, ids and an audit entry', async () => {
    const h = createHarness({ start: '2026-05-01T12:00:00.000Z' });
    await seedJob(h, { id: 'x-1', name: 'Cafe & Bar <menu>', customerRef: 'C-1', deviceId: DEVICE_A, tags: ['menu'] });

    const xml = await h.service.exportXjdf('x-1');
    expect(xml).toContain('<XJDF xmlns="http://www.CIP4.org/JDFSchema_2_0" JobID="x-1" Types="Product" Version="2.0">');
    expect(xml).toContain('IDValue="Cafe &amp; Bar &lt;menu&gt;"');
    expect(xml).toContain('<GeneralID IDUsage="bps.customerRef" IDValue="C-1"/>');
    expect(xml).toContain('<GeneralID IDUsage="bps.tag" IDValue="menu"/>');
    expect(xml).toContain('Time="2026-05-01T12:00:00.000Z"');
    expect(xml).toContain('<Product Amount="2">');
    // 200 × 100 mm in points.
    expect(xml).toContain('FinishedDimensions="566.929 283.465 0"');
    expect(xml).not.toContain('bps.mediumId');
  });
});
