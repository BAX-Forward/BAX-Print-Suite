import { type ColorSetupContent, ValidationError } from '@bax-print/core';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { exportMedium, importMedium, syncFromDevice } from '../src/index.js';
import { fakeIcc, fixtureDriver, modeReport, profileInput, testLibrary } from './helpers.js';

const DEVICE = 'generic-device';

async function preparedLibrary() {
  const t = testLibrary();
  await syncFromDevice(t.library, DEVICE, fixtureDriver(() => [modeReport('a'), modeReport('b'), modeReport('c')]));
  const { library } = t;
  const medium = library.listMedia()[0]!;
  const shared = library.addProfile(fakeIcc(1), profileInput(true));
  const licensed = library.addProfile(fakeIcc(2), profileInput(false));
  const byKey = (key: string) => library.listModes(medium.id).find((m) => m.modeKey === key)!;
  const edit = (key: string, patch: Partial<ColorSetupContent>) => {
    const setup = library.getColorSetupForMode(byKey(key).id);
    library.addRevision(setup.id, { content: { ...setup.content, ...patch }, author: 'operator', reason: 'test setup' });
  };
  edit('a', { level: 'L1', outputProfile: shared });
  edit('b', { level: 'L1', outputProfile: licensed });
  edit('c', {
    curves: {
      metric: 'de2000-from-paper',
      inputs: [0, 0.5, 1],
      channels: { cyan: [0, 0.4, 1], magenta: [0, 0.45, 1], yellow: [0, 0.5, 1], black: [0, 0.375, 1] },
    },
  });
  return { ...t, medium, shared, licensed };
}

describe('.bpsmedia exchange', () => {
  it('excludes a non-redistributable profile and reports it', async () => {
    const { library, medium, shared, licensed } = await preparedLibrary();
    const result = exportMedium(library, medium.id);
    const paths = result.manifest.members.map((m) => m.path);
    expect(paths).toContain(`profiles/${shared.sha256}.icc`);
    expect(paths).not.toContain(`profiles/${licensed.sha256}.icc`);
    expect(paths).toContain('medium.json');
    expect(paths.some((p) => p.startsWith('curves/'))).toBe(true);
    expect(result.manifest.omittedProfiles).toEqual([
      { sha256: licensed.sha256, description: licensed.description, license: licensed.provenance.license, reason: 'not-redistributable' },
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/not redistributable/);
    const archived = unzipSync(result.bytes);
    expect(Object.keys(archived).some((p) => p.includes(licensed.sha256))).toBe(false);
  });

  it('round-trips: export → import → export gives the same medium.json and archive', async () => {
    const { library, medium, licensed } = await preparedLibrary();
    const exported = exportMedium(library, medium.id);

    const target = testLibrary(undefined, 'imp');
    const imported = importMedium(target.library, exported.bytes, { author: 'operator' });
    expect(imported.mediumJson).toBe(exported.mediumJson);
    expect(imported.modes).toHaveLength(3);
    expect(imported.missingProfiles.map((p) => p.sha256)).toEqual([licensed.sha256]);
    for (const mode of imported.modes) {
      const setup = target.library.getColorSetupForMode(mode.id);
      const revisions = target.library.listRevisions(setup.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.source).toEqual({ importedFrom: 'bpsmedia' });
    }

    const again = exportMedium(target.library, imported.medium.id);
    expect(again.mediumJson).toBe(exported.mediumJson);
    expect(again.manifest).toEqual(exported.manifest);
    expect(Buffer.from(again.bytes).equals(Buffer.from(exported.bytes))).toBe(true);
  });

  it('rejects an archive whose member does not match the manifest digest', async () => {
    const { library, medium } = await preparedLibrary();
    const entries = unzipSync(exportMedium(library, medium.id).bytes);
    const json = JSON.parse(new TextDecoder().decode(entries['medium.json']));
    json.medium.name = 'Tampered';
    entries['medium.json'] = new TextEncoder().encode(JSON.stringify(json));
    const tampered = zipSync(entries);
    const target = testLibrary(undefined, 'imp');
    expect(() => importMedium(target.library, tampered, { author: 'operator' })).toThrow(ValidationError);
    expect(() => importMedium(target.library, tampered, { author: 'operator' })).toThrow(/digest/);
  });

  it('rejects bytes that are not an archive', () => {
    const { library } = testLibrary();
    expect(() => importMedium(library, new Uint8Array([1, 2, 3]), { author: 'operator' })).toThrow(ValidationError);
  });
});
