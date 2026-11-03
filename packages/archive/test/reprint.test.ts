import { beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError, InvalidArgumentError, InvalidLifecycleError } from '@bax-print/core';
import { sha256Hex } from '@bax-print/store';
import {
  ColorSetupMismatchError,
  ColorSetupNotFoundError,
  ColorSetupRequiredError,
  resolveReprintSetup,
  StaticColorSetupResolver,
} from '../src/index.js';
import {
  createHarness,
  DEFAULT_ARTIFACTS,
  DEVICE_A,
  DEVICE_B,
  MEDIUM_GLOSS,
  MEDIUM_MATTE,
  revision,
  seedJob,
  typesOf,
  type Harness,
} from './helpers.js';

const ORIGINAL_REV = 'rev-a-gloss-1';
const HEAD_REV = 'rev-a-gloss-2';
const MATTE_REV = 'rev-a-matte-1';
const DEVICE_B_REV = 'rev-b-gloss-1';
const ORIGINAL = 'orig-001';

async function archivedOriginal(h: Harness): Promise<void> {
  h.colorSetups
    .addRevision(revision(ORIGINAL_REV, DEVICE_A, MEDIUM_GLOSS))
    .addRevision(revision(HEAD_REV, DEVICE_A, MEDIUM_GLOSS))
    .addRevision(revision(MATTE_REV, DEVICE_A, MEDIUM_MATTE))
    .addRevision(revision(DEVICE_B_REV, DEVICE_B, MEDIUM_GLOSS));
  await seedJob(h, {
    id: ORIGINAL,
    customerRef: 'C-1001',
    deviceId: DEVICE_A,
    mediumId: MEDIUM_GLOSS,
    presetId: 'preset-standard',
    colorSetupRevisionId: ORIGINAL_REV,
    tags: ['returning'],
    artifacts: DEFAULT_ARTIFACTS,
  });
  await h.service.archive(ORIGINAL);
}

describe('reprint on the same device and medium', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await archivedOriginal(h);
  });

  it('creates a new linked job that reuses the original revision id, not the current head', async () => {
    const { job, warnings } = await h.service.reprint(ORIGINAL);

    expect(job.id).not.toBe(ORIGINAL);
    expect(job.reprintOf).toBe(ORIGINAL);
    expect(job.status).toBe('received');
    expect(job.lifecycle).toBe('active');
    expect(job.deviceId).toBe(DEVICE_A);
    expect(job.mediumId).toBe(MEDIUM_GLOSS);
    expect(job.colorSetupRevisionId).toBe(ORIGINAL_REV);
    expect(job.presetId).toBe('preset-standard');
    expect(job.ticket.intent.quantity).toBe(2);
    expect(warnings).toEqual([]);
    expect(typesOf(h, ['reprint.setup.changed'])).toEqual([]);

    const created = h.outbox.list({ jobId: job.id, types: ['job.created'] });
    expect(created).toHaveLength(1);
    expect(created[0].event.data).toMatchObject({ jobId: job.id, reprintOf: ORIGINAL, copies: 2 });

    // The original stays archived and untouched.
    expect((await h.service.getJob(ORIGINAL)).lifecycle).toBe('archived');
  });

  it('restores source and artifact blobs from the package, hash-identical', async () => {
    const { job } = await h.service.reprint(ORIGINAL);
    expect(job.artifacts.map((a) => a.role)).toEqual(['layout', 'cut', 'preview']);
    for (const file of [...job.sourceFiles, ...job.artifacts]) {
      expect(file.storageKey.startsWith(`jobs/${job.id}/`)).toBe(true);
      expect(sha256Hex(await h.blobs.get(file.storageKey))).toBe(file.sha256);
    }
  });

  it('uses the current head only when the user opts in, without a setup-changed warning', async () => {
    const { job } = await h.service.reprint(ORIGINAL, { useCurrentHead: true });
    expect(job.colorSetupRevisionId).toBe(HEAD_REV);
    expect(typesOf(h, ['reprint.setup.changed'])).toEqual([]);
  });

  it('applies the copies and preset options', async () => {
    const { job } = await h.service.reprint(ORIGINAL, { copies: 25, presetId: 'preset-fast' });
    expect(job.ticket.intent.quantity).toBe(25);
    expect(job.presetId).toBe('preset-fast');
    await expect(h.service.reprint(ORIGINAL, { copies: 0 })).rejects.toThrow(InvalidArgumentError);
    await expect(h.service.reprint(ORIGINAL, { copies: 1.5 })).rejects.toThrow(InvalidArgumentError);
  });
});

describe('reprint on a different medium or device', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await archivedOriginal(h);
  });

  it('requires an explicit setup and creates nothing without one', async () => {
    const jobsBefore = (await h.jobs.list()).length;
    const eventsBefore = h.outbox.list().length;

    await expect(h.service.reprint(ORIGINAL, { mediumId: MEDIUM_MATTE })).rejects.toThrow(ColorSetupRequiredError);
    await expect(h.service.reprint(ORIGINAL, { deviceId: DEVICE_B })).rejects.toThrow(ColorSetupRequiredError);

    expect(await h.jobs.list()).toHaveLength(jobsBefore);
    expect(h.outbox.list()).toHaveLength(eventsBefore);
  });

  it('uses the picked setup and records a reprint.setup.changed warning event', async () => {
    const { job, warnings } = await h.service.reprint(ORIGINAL, {
      mediumId: MEDIUM_MATTE,
      colorSetupRevisionId: MATTE_REV,
    });

    expect(job.reprintOf).toBe(ORIGINAL);
    expect(job.mediumId).toBe(MEDIUM_MATTE);
    expect(job.colorSetupRevisionId).toBe(MATTE_REV);
    // Layout and cut depend on the medium, so they are regenerated rather than copied.
    expect(job.artifacts).toEqual([]);
    expect(job.sourceFiles).toHaveLength(1);
    expect(warnings).toHaveLength(1);

    const changed = h.outbox.list({ jobId: job.id, types: ['reprint.setup.changed'] });
    expect(changed).toHaveLength(1);
    expect(changed[0].event.subject).toBe(job.id);
    expect(changed[0].event.data).toEqual({
      jobId: job.id,
      reprintOf: ORIGINAL,
      severity: 'warning',
      previous: { deviceId: DEVICE_A, mediumId: MEDIUM_GLOSS, colorSetupRevisionId: ORIGINAL_REV },
      current: { deviceId: DEVICE_A, mediumId: MEDIUM_MATTE, colorSetupRevisionId: MATTE_REV },
      actor: 'system',
    });
    expect(typesOf(h, ['job.created', 'reprint.setup.changed']).slice(-2)).toEqual(['job.created', 'reprint.setup.changed']);
  });

  it('accepts the current head of the new pair as the explicit choice', async () => {
    const { job } = await h.service.reprint(ORIGINAL, { deviceId: DEVICE_B, useCurrentHead: true });
    expect(job.deviceId).toBe(DEVICE_B);
    expect(job.colorSetupRevisionId).toBe(DEVICE_B_REV);
    expect(typesOf(h, ['reprint.setup.changed'])).toHaveLength(1);
  });

  it('rejects a setup that belongs to another device or medium', async () => {
    await expect(
      h.service.reprint(ORIGINAL, { mediumId: MEDIUM_MATTE, colorSetupRevisionId: ORIGINAL_REV }),
    ).rejects.toThrow(ColorSetupMismatchError);
    await expect(
      h.service.reprint(ORIGINAL, { mediumId: MEDIUM_MATTE, colorSetupRevisionId: 'rev-missing' }),
    ).rejects.toThrow(ColorSetupNotFoundError);
    expect(typesOf(h, ['reprint.setup.changed'])).toEqual([]);
  });
});

describe('reprint guards', () => {
  it('reprints a finished job that is still active, reading its live blobs', async () => {
    const h = createHarness();
    h.colorSetups.addRevision(revision(ORIGINAL_REV, DEVICE_A, MEDIUM_GLOSS));
    await seedJob(h, { id: 'live', deviceId: DEVICE_A, mediumId: MEDIUM_GLOSS, colorSetupRevisionId: ORIGINAL_REV });
    const { job } = await h.service.reprint('live');
    expect(job.reprintOf).toBe('live');
    expect(job.colorSetupRevisionId).toBe(ORIGINAL_REV);
  });

  it('refuses jobs in the trash, jobs still in production, and viewers', async () => {
    const h = createHarness();
    await seedJob(h, { id: 'binned' });
    await seedJob(h, { id: 'running', status: 'processing', doneAt: undefined });
    await seedJob(h, { id: 'ok' });
    await h.service.trash('binned');

    await expect(h.service.reprint('binned')).rejects.toThrow(InvalidLifecycleError);
    await expect(h.service.reprint('running')).rejects.toThrow(InvalidLifecycleError);
    await expect(h.service.reprint('ok', {}, { id: 'guest', role: 'viewer' })).rejects.toThrow(ForbiddenError);
  });
});

describe('resolveReprintSetup', () => {
  const resolver = new StaticColorSetupResolver()
    .addRevision(revision(ORIGINAL_REV, DEVICE_A, MEDIUM_GLOSS))
    .addRevision(revision(HEAD_REV, DEVICE_A, MEDIUM_GLOSS));
  const original = { deviceId: DEVICE_A, mediumId: MEDIUM_GLOSS, colorSetupRevisionId: ORIGINAL_REV };

  it('keeps the original revision for the same pair', async () => {
    expect(await resolveReprintSetup(original, {}, resolver)).toEqual({
      deviceId: DEVICE_A,
      mediumId: MEDIUM_GLOSS,
      colorSetupRevisionId: ORIGINAL_REV,
      changed: false,
      source: 'original',
    });
    expect(await resolveReprintSetup(original, { deviceId: DEVICE_A, mediumId: MEDIUM_GLOSS }, resolver)).toMatchObject({
      changed: false,
      source: 'original',
    });
  });

  it('marks an explicit pick on the same pair as not changed', async () => {
    expect(await resolveReprintSetup(original, { colorSetupRevisionId: HEAD_REV }, resolver)).toMatchObject({
      colorSetupRevisionId: HEAD_REV,
      changed: false,
      source: 'explicit',
    });
  });

  it('needs a device and medium to use the current head', async () => {
    await expect(resolveReprintSetup({}, { useCurrentHead: true }, resolver)).rejects.toThrow(ColorSetupRequiredError);
  });
});
