import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HotFolderWatcher, type DocumentInspector, type IntakeOutcome } from '../src/index.js';
import { FAILED, PROCESSED, makeDeps, makeFolder, makeTempDir, waitFor } from './fakes.js';

const FAST = { stabilityMs: 50, pollIntervalMs: 20, rescanIntervalMs: 50 } as const;
/** Long enough for several rescans and stability windows to pass after the first ingest. */
const SETTLE_MS = 400;

describe('HotFolderWatcher', () => {
  let dir: string;
  let outside: string;
  const cleanups: Array<() => Promise<void>> = [];
  let watcher: HotFolderWatcher | undefined;

  beforeEach(async () => {
    const root = await makeTempDir();
    const other = await makeTempDir();
    dir = root.dir;
    outside = other.dir;
    cleanups.push(root.cleanup, other.cleanup);
  });

  afterEach(async () => {
    await watcher?.stop();
    watcher = undefined;
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('ignores non-matching patterns, symlinks and the _processed/_failed dirs', async () => {
    const inspected: string[] = [];
    const inspector: DocumentInspector = {
      async inspect(document) {
        inspected.push(document.name);
        return { pageCount: 1, pages: [] };
      },
    };
    const { jobs, deps } = makeDeps(inspector);
    await mkdir(join(dir, PROCESSED));
    await mkdir(join(dir, FAILED));
    await writeFile(join(dir, PROCESSED, 'old.pdf'), 'processed earlier');
    await writeFile(join(dir, FAILED, 'broken.pdf'), 'failed earlier');
    await writeFile(join(dir, 'notes.txt'), 'not a pdf pattern');
    await writeFile(join(outside, 'target.pdf'), '%PDF-1.7 outside');
    await symlink(join(outside, 'target.pdf'), join(dir, 'link.pdf'));
    await writeFile(join(dir, 'a.pdf'), '%PDF-1.7 a');

    const outcomes: Array<{ outcome: IntakeOutcome; path: string }> = [];
    watcher = new HotFolderWatcher({
      folder: makeFolder(dir),
      deps,
      ...FAST,
      onOutcome: (outcome, path) => outcomes.push({ outcome, path }),
    });
    await watcher.start();

    await waitFor(() => outcomes.length > 0);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, SETTLE_MS));

    expect(outcomes.map((entry) => entry.path)).toEqual([join(dir, 'a.pdf')]);
    expect(outcomes[0]?.outcome.kind).toBe('ready');
    expect(inspected).toEqual(['a.pdf']);
    expect(jobs.byId.size).toBe(1);
    expect((await readdir(dir)).sort()).toEqual([FAILED, PROCESSED, 'link.pdf', 'notes.txt'].sort());
    expect((await readdir(join(dir, PROCESSED))).sort()).toEqual(['a.pdf', 'old.pdf']);
    expect(await readdir(join(dir, FAILED))).toEqual(['broken.pdf']);
  });

  it('picks up a matching file written after start', async () => {
    const { deps } = makeDeps();
    const outcomes: IntakeOutcome[] = [];
    watcher = new HotFolderWatcher({
      folder: makeFolder(dir),
      deps,
      ...FAST,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    await watcher.start();
    await writeFile(join(dir, 'late.TXT'), 'ignored');
    await writeFile(join(dir, 'late.pdf'), '%PDF-1.7 late');

    await waitFor(() => outcomes.length > 0);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, SETTLE_MS));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe('ready');
    expect(await readdir(join(dir, PROCESSED))).toEqual(['late.pdf']);
  });

  async function watchVectorFiles(acceptVector: boolean | undefined): Promise<string[]> {
    const { deps } = makeDeps();
    await writeFile(join(dir, 'cut.svg'), '<svg width="1in" height="1in"/>');
    await writeFile(join(dir, 'PLAN.DXF'), '  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n');
    await writeFile(join(dir, 'a.pdf'), '%PDF-1.7 a');
    const outcomes: string[] = [];
    watcher = new HotFolderWatcher({
      folder: makeFolder(dir, acceptVector === undefined ? {} : { acceptVector }),
      deps,
      ...FAST,
      onOutcome: (outcome, path) => {
        if (outcome.kind === 'ready') outcomes.push(path);
      },
    });
    await watcher.start();
    await waitFor(() => outcomes.length > 0);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, SETTLE_MS));
    return outcomes.sort();
  }

  it('ignores SVG and DXF files unless the folder has acceptVector on (Spec 035b)', async () => {
    expect(await watchVectorFiles(undefined)).toEqual([join(dir, 'a.pdf')]);
    expect((await readdir(dir)).sort()).toEqual(['PLAN.DXF', PROCESSED, 'cut.svg'].sort());
  });

  it('ignores SVG and DXF files when acceptVector is false (Spec 035b)', async () => {
    expect(await watchVectorFiles(false)).toEqual([join(dir, 'a.pdf')]);
  });

  it('picks up SVG and DXF files, in any letter case, when acceptVector is on (Spec 035b)', async () => {
    expect(await watchVectorFiles(true)).toEqual([join(dir, 'PLAN.DXF'), join(dir, 'a.pdf'), join(dir, 'cut.svg')].sort());
    expect((await readdir(join(dir, PROCESSED))).sort()).toEqual(['PLAN.DXF', 'a.pdf', 'cut.svg'].sort());
  });
});
