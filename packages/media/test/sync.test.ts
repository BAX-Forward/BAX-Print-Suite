import { canonicalJson } from '@bax-print/core';
import type { OutputModeReport } from '@bax-print/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { resolveSyncConflict, syncFromDevice } from '../src/index.js';
import { fixtureDriver, modeReport, testLibrary } from './helpers.js';

const DEVICE = 'generic-device';

describe('device sync merge', () => {
  it('updates untouched modes and leaves the user-edited one byte-identical', async () => {
    const { library, events } = testLibrary();
    let modes: OutputModeReport[] = [modeReport('a'), modeReport('b'), modeReport('c')];
    const driver = fixtureDriver(() => modes);

    const first = await syncFromDevice(library, DEVICE, driver);
    expect(first.mediaCreated).toHaveLength(1);
    expect(first.modesCreated).toHaveLength(3);
    expect(first.conflicts).toEqual([]);

    const medium = library.getMedium(first.mediaCreated[0]!);
    const byKey = (key: string) => library.listModes(medium.id).find((m) => m.modeKey === key)!;
    const edited = byKey('b');
    const editedSetup = library.getColorSetupForMode(edited.id);
    library.addRevision(editedSetup.id, {
      content: { ...editedSetup.content, tacLimitPercent: 260 },
      author: 'operator',
      reason: 'characterized by hand',
    });
    const snapshot = () =>
      canonicalJson({
        mode: library.getOutputMode(edited.id),
        setup: library.getColorSetup(editedSetup.id),
        revisions: library.listRevisions(editedSetup.id),
      });
    const before = snapshot();

    // An unchanged report is a no-op.
    const idle = await syncFromDevice(library, DEVICE, driver);
    expect(idle.modesUpdated).toEqual([]);
    expect(idle.conflicts).toEqual([]);

    modes = ['a', 'b', 'c'].map((key) => modeReport(key, { passes: 16, colorDefaults: { tacLimitPercent: 300 } }));
    const second = await syncFromDevice(library, DEVICE, driver);

    expect(snapshot()).toBe(before);
    expect(second.modesUpdated.sort()).toEqual([byKey('a').id, byKey('c').id].sort());
    expect(second.setupsUpdated).toHaveLength(2);
    expect(second.conflicts.length).toBeGreaterThan(0);
    expect(second.conflicts.every((c) => c.outputModeId === edited.id)).toBe(true);
    expect(new Set(second.conflicts.map((c) => c.field))).toEqual(new Set(['passes', 'colorDefaults']));

    expect(byKey('a').passes).toBe(16);
    const setupA = library.getColorSetupForMode(byKey('a').id);
    expect(setupA.content.tacLimitPercent).toBe(300);
    expect(setupA.userRevisionCount).toBe(0);
    expect(events.filter((e) => e.type === 'media.synced')).toHaveLength(3);

    const passes = second.conflicts.find((c) => c.field === 'passes')!;
    expect(resolveSyncConflict(library, passes, 'keep-local', 'operator')).toEqual({ applied: false });
    expect(snapshot()).toBe(before);
    expect(resolveSyncConflict(library, passes, 'accept-device', 'operator')).toEqual({ applied: true });
    expect(library.getOutputMode(edited.id).passes).toBe(16);
  });

  it('reports a mode the device stopped listing', async () => {
    const { library } = testLibrary();
    let modes: OutputModeReport[] = [modeReport('a'), modeReport('b')];
    const driver = fixtureDriver(() => modes);
    await syncFromDevice(library, DEVICE, driver);
    modes = [modeReport('a')];
    const report = await syncFromDevice(library, DEVICE, driver);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.kind).toBe('mode-missing');
  });
});
