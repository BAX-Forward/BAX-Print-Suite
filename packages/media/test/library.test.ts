import { MediumInUseError, NotFoundError, canonicalJson } from '@bax-print/core';
import { describe, expect, it } from 'vitest';
import { MediaLibrary, syncFromDevice } from '../src/index.js';
import { fixtureDriver, modeReport, testLibrary } from './helpers.js';

const DEVICE = 'generic-device';
const threeModes = () => [modeReport('a'), modeReport('b'), modeReport('c')];

async function syncedLibrary() {
  const t = testLibrary();
  await syncFromDevice(t.library, DEVICE, fixtureDriver(threeModes));
  const medium = t.library.listMedia()[0]!;
  return { ...t, medium };
}

describe('media library CRUD', () => {
  it('creates, renames, archives and deletes a medium', () => {
    const { library } = testLibrary();
    const medium = library.createMedium({ name: 'Matte paper', kind: 'paper', widthsMm: [610] });
    expect(library.renameMedium(medium.id, 'Matte paper 2').name).toBe('Matte paper 2');
    library.setArchived(medium.id, true);
    expect(library.listMedia().map((m) => m.id)).not.toContain(medium.id);
    expect(library.listMedia({ includeArchived: true }).map((m) => m.id)).toContain(medium.id);
    expect(library.getMedium(medium.id).archived).toBe(true);
    library.deleteMedium(medium.id);
    expect(() => library.getMedium(medium.id)).toThrow(NotFoundError);
  });
});

describe('clone', () => {
  it('copies modes and setup heads into fresh revision chains', async () => {
    const { library, medium } = await syncedLibrary();
    const modeA = library.listModes(medium.id).find((m) => m.modeKey === 'a')!;
    const setupA = library.getColorSetupForMode(modeA.id);
    library.addRevision(setupA.id, {
      content: { ...setupA.content, tacLimitPercent: 280 },
      author: 'operator',
      reason: 'tuned TAC',
    });
    const sourceHead = library.getColorSetup(setupA.id);
    expect(library.listRevisions(setupA.id)).toHaveLength(2);

    const clone = library.cloneMedium(medium.id, { author: 'operator' });
    expect(clone.id).not.toBe(medium.id);
    expect(clone.clonedFrom).toEqual({ mediumId: medium.id });
    expect(clone.deviceRef).toBeUndefined();

    const cloneModes = library.listModes(clone.id);
    expect(cloneModes.map((m) => m.modeKey).sort()).toEqual(['a', 'b', 'c']);
    for (const mode of cloneModes) {
      const setup = library.getColorSetupForMode(mode.id);
      const revisions = library.listRevisions(setup.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.seq).toBe(1);
      expect(revisions[0]?.parentRevisionId).toBeNull();
      expect(setup.origin).toBeDefined();
      expect(revisions[0]?.origin).toEqual(setup.origin);
    }
    const clonedA = library.getColorSetupForMode(cloneModes.find((m) => m.modeKey === 'a')!.id);
    expect(clonedA.origin).toEqual({ colorSetupId: setupA.id, revisionId: sourceHead.headRevisionId });
    expect(canonicalJson(clonedA.content)).toBe(canonicalJson(sourceHead.content));
    expect(clonedA.headRevisionId).not.toBe(sourceHead.headRevisionId);
    expect(library.listRevisions(setupA.id)).toHaveLength(2);
  });
});

describe('delete guard', () => {
  it('refuses to delete a medium a job is bound to', async () => {
    const { library, medium } = await syncedLibrary();
    const mode = library.listModes(medium.id)[0]!;
    const preset = library.createPreset({ name: 'Default', mediumId: medium.id, outputModeId: mode.id });
    library.bindJobColor({ jobId: 'job-1', presetId: preset.id });
    expect(() => library.deleteMedium(medium.id)).toThrow(MediumInUseError);
    expect(library.getMedium(medium.id).id).toBe(medium.id);
  });

  it('counts references reported by the job store', () => {
    const { repo } = testLibrary();
    const library = new MediaLibrary({ repo, countJobReferences: () => 2 });
    const medium = library.createMedium({ name: 'Film', kind: 'film' });
    expect(() => library.deleteMedium(medium.id)).toThrow(MediumInUseError);
  });

  it('keeps the bound revision when the setup moves on', async () => {
    const { library, medium } = await syncedLibrary();
    const mode = library.listModes(medium.id)[0]!;
    const preset = library.createPreset({ name: 'Default', mediumId: medium.id, outputModeId: mode.id });
    const binding = library.bindJobColor({ jobId: 'job-2', presetId: preset.id });
    const setup = library.getColorSetup(preset.colorSetupId);
    library.addRevision(setup.id, { content: { ...setup.content, tacLimitPercent: 250 }, author: 'operator', reason: 'edit' });
    expect(library.getJobColor('job-2').revision.id).toBe(binding.colorSetupRevisionId);
  });
});
