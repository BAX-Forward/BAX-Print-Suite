import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { effectiveFilePatterns, withHotFolderDefaults } from '@bax-print/core';
import {
  HotFolderWatcher,
  ingestJdfTicket,
  plainFileRefName,
  type DocumentInspector,
  type IntakeOutcome,
} from '../src/index.js';
import { FAILED, PROCESSED, makeDeps, makeFolder, makeTempDir, waitFor } from './fakes.js';

const FAST = { stabilityMs: 50, pollIntervalMs: 20, rescanIntervalMs: 50 } as const;
/** Long enough for several rescans and stability windows to pass after the first ingest. */
const SETTLE_MS = 400;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** A JDF 1.x ticket with one RunList (and so one FileSpec) per URL. */
function ticketXml(urls: readonly string[]): string {
  const runLists = urls
    .map((url) => `<RunList><LayoutElement><FileSpec URL="${escapeAttribute(url)}"/></LayoutElement></RunList>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<JDF xmlns="http://www.CIP4.org/JDFSchema_1_1" ID="n1" JobID="J-100" JobPartID="P-1" Type="Product" Version="1.4">',
    '<ResourcePool><Component Amount="250"/><Media DescriptiveName="Gloss 170"/>',
    runLists,
    '</ResourcePool></JDF>',
  ].join('\n');
}

function recordingInspector(names: string[]): DocumentInspector {
  return {
    async inspect(document) {
      names.push(document.name);
      return { pageCount: 1, pages: [] };
    },
  };
}

describe('JDF pairing (Spec 037b)', () => {
  let dir: string;
  let outside: string;
  const cleanups: Array<() => Promise<void>> = [];
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(async () => {
    const root = await makeTempDir();
    const other = await makeTempDir();
    dir = root.dir;
    outside = other.dir;
    cleanups.push(root.cleanup, other.cleanup);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network is disabled in tests'));
  });

  afterEach(async () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('adds *.jdf to the effective patterns only when acceptJdf is on', () => {
    expect(effectiveFilePatterns({ filePatterns: ['*.pdf'] })).toEqual(['*.pdf']);
    expect(effectiveFilePatterns({ filePatterns: ['*.pdf'], acceptJdf: true })).toEqual(['*.pdf', '*.jdf']);
    expect(effectiveFilePatterns({ filePatterns: ['*.PDF', '*.JDF'], acceptJdf: true })).toEqual(['*.PDF', '*.JDF']);
    expect('acceptJdf' in withHotFolderDefaults({})).toBe(false);
    expect(withHotFolderDefaults({ acceptJdf: true }).acceptJdf).toBe(true);
  });

  it('pairs a ticket with the one file it names and carries the ticket facts as job metadata', async () => {
    const inspected: string[] = [];
    const { jobs, storage, deps } = makeDeps(recordingInspector(inspected));
    const folder = makeFolder(dir, { acceptJdf: true });
    await writeFile(join(dir, 'art.pdf'), '%PDF-1.7 art');
    await writeFile(join(dir, 'order.JDF'), ticketXml(['art.pdf']));

    const outcome = await ingestJdfTicket(join(dir, 'order.JDF'), folder, deps);

    expect(outcome.kind).toBe('ready');
    if (outcome.kind === 'ready') {
      expect(outcome.job.name).toBe('art.pdf');
      expect(outcome.job.metadata).toEqual({
        'jdf.jobId': 'J-100',
        'jdf.jobPartId': 'P-1',
        'jdf.quantity': '250',
        'jdf.mediaName': 'Gloss 170',
      });
      expect(jobs.byId.get(outcome.job.id)?.metadata['jdf.jobId']).toBe('J-100');
    }
    expect(inspected).toEqual(['art.pdf']);
    expect(jobs.byId.size).toBe(1);
    expect(storage.blobs.size).toBe(1);
    expect(outcome.movedTo).toBe(join(dir, PROCESSED, 'order.JDF'));
    expect(outcome.pairedFile).toEqual({ path: join(dir, 'art.pdf'), movedTo: join(dir, PROCESSED, 'art.pdf') });
    expect(await readdir(dir)).toEqual([PROCESSED]);
  });

  it('decodes a percent-escaped plain name', async () => {
    const { deps } = makeDeps();
    await writeFile(join(dir, 'my art.pdf'), '%PDF-1.7 spaced');
    await writeFile(join(dir, 'order.jdf'), ticketXml(['my%20art.pdf']));

    const outcome = await ingestJdfTicket(join(dir, 'order.jdf'), makeFolder(dir, { acceptJdf: true }), deps);

    expect(outcome.kind).toBe('ready');
    expect(outcome.pairedFile?.path).toBe(join(dir, 'my art.pdf'));
  });

  const unsafeRefs = [
    '../x.pdf',
    '/abs/x.pdf',
    'sub/x.pdf',
    'C:\\x.pdf',
    'C:x.pdf',
    '%2e%2e%2fx.pdf',
    '%2Fx.pdf',
    'x%00.pdf',
    'x%252e.pdf',
    'x%zz.pdf',
    'http://example.test/x.pdf',
    'https://example.test/x.pdf',
    'file:///tmp/x.pdf',
    'file:x.pdf',
    'ftp://example.test/x.pdf',
    'data:application/pdf;base64,JVBERi0xLjc=',
    'urn:x.pdf',
    'x.jdf',
    'notes.txt',
  ];

  it.each(unsafeRefs)('refuses the file reference %s with JDF_UNSAFE_FILE_REF and touches no file', async (url) => {
    const inspected: string[] = [];
    const { jobs, deps } = makeDeps(recordingInspector(inspected));
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'x.pdf'), '%PDF-1.7 nested');
    await writeFile(join(dir, 'x.pdf'), '%PDF-1.7 local');
    await writeFile(join(dir, 'notes.txt'), 'not a pattern');
    await writeFile(join(dir, 'order.jdf'), ticketXml([url]));

    const outcome = await ingestJdfTicket(join(dir, 'order.jdf'), makeFolder(dir, { acceptJdf: true }), deps);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('JDF_UNSAFE_FILE_REF');
      expect(outcome.job).toBeUndefined();
    }
    expect(outcome.movedTo).toBe(join(dir, FAILED, 'order.jdf'));
    expect(jobs.byId.size).toBe(0);
    expect(inspected).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual([FAILED, 'notes.txt', 'sub', 'x.pdf'].sort());
  });

  it('refuses a symbolic link in the folder that points outside it', async () => {
    const { jobs, deps } = makeDeps();
    await writeFile(join(outside, 'target.pdf'), '%PDF-1.7 outside');
    await symlink(join(outside, 'target.pdf'), join(dir, 'link.pdf'));
    await writeFile(join(dir, 'order.jdf'), ticketXml(['link.pdf']));

    const outcome = await ingestJdfTicket(join(dir, 'order.jdf'), makeFolder(dir, { acceptJdf: true }), deps);

    expect(outcome.kind === 'failed' ? outcome.error.code : outcome.kind).toBe('JDF_UNSAFE_FILE_REF');
    expect(jobs.byId.size).toBe(0);
    expect(await readdir(outside)).toEqual(['target.pdf']);
  });

  it.each([
    ['JDF_FILE_MISSING', ticketXml(['absent.pdf'])],
    ['JDF_MULTIPLE_FILE_REFS', ticketXml(['a.pdf', 'b.pdf'])],
    ['JDF_NO_FILE_REF', ticketXml([])],
    ['JDF_INVALID', 'this is not a job ticket'],
    ['JDF_TRUNCATED', '<JDF xmlns="http://www.CIP4.org/JDFSchema_1_1" ID="n1"'],
  ])('fails the ticket with %s and guesses no file', async (code, xml) => {
    const inspected: string[] = [];
    const { jobs, deps } = makeDeps(recordingInspector(inspected));
    await writeFile(join(dir, 'a.pdf'), '%PDF-1.7 a');
    await writeFile(join(dir, 'b.pdf'), '%PDF-1.7 b');
    await writeFile(join(dir, 'order.jdf'), xml);

    const outcome = await ingestJdfTicket(join(dir, 'order.jdf'), makeFolder(dir, { acceptJdf: true }), deps);

    expect(outcome.kind === 'failed' ? outcome.error.code : outcome.kind).toBe(code);
    expect(outcome.movedTo).toBe(join(dir, FAILED, 'order.jdf'));
    expect(jobs.byId.size).toBe(0);
    expect(inspected).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual([FAILED, 'a.pdf', 'b.pdf'].sort());
  });

  it('moves the ticket to _failed with its file when the paired intake fails', async () => {
    const { deps } = makeDeps({
      async inspect() {
        throw Object.assign(new Error('not a PDF'), { code: 'INSPECT_FAILED' });
      },
    });
    await writeFile(join(dir, 'bad.pdf'), 'broken');
    await writeFile(join(dir, 'order.jdf'), ticketXml(['bad.pdf']));

    const outcome = await ingestJdfTicket(join(dir, 'order.jdf'), makeFolder(dir, { acceptJdf: true }), deps);

    expect(outcome.kind === 'failed' ? outcome.error.code : outcome.kind).toBe('INSPECT_FAILED');
    expect((await readdir(join(dir, FAILED))).sort()).toEqual(['bad.pdf', 'order.jdf']);
  });

  describe('plainFileRefName', () => {
    it('accepts plain names and refuses anything else', () => {
      expect(plainFileRefName('x.pdf')).toBe('x.pdf');
      expect(plainFileRefName('my%20x.pdf')).toBe('my x.pdf');
      for (const url of unsafeRefs.slice(0, unsafeRefs.length - 2)) {
        expect(plainFileRefName(url)).toBeUndefined();
      }
      expect(plainFileRefName('')).toBeUndefined();
      expect(plainFileRefName('..')).toBeUndefined();
      expect(plainFileRefName('x\u0000.pdf')).toBeUndefined();
    });
  });

  describe('in the watcher', () => {
    let watcher: HotFolderWatcher | undefined;

    afterEach(async () => {
      await watcher?.stop();
      watcher = undefined;
    });

    async function runWatcher(acceptJdf: boolean, inspected: string[]) {
      const { jobs, deps } = makeDeps(recordingInspector(inspected));
      const outcomes: Array<{ outcome: IntakeOutcome; path: string }> = [];
      watcher = new HotFolderWatcher({
        folder: makeFolder(dir, acceptJdf ? { acceptJdf } : {}),
        deps,
        ...FAST,
        onOutcome: (outcome, path) => outcomes.push({ outcome, path }),
      });
      await watcher.start();
      await waitFor(() => outcomes.length > 0);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, SETTLE_MS));
      return { jobs, outcomes };
    }

    it('ignores .jdf files when acceptJdf is off', async () => {
      const inspected: string[] = [];
      await writeFile(join(dir, 'art.pdf'), '%PDF-1.7 art');
      await writeFile(join(dir, 'order.jdf'), ticketXml(['art.pdf']));

      const { jobs, outcomes } = await runWatcher(false, inspected);

      expect(outcomes.map((entry) => entry.path)).toEqual([join(dir, 'art.pdf')]);
      expect(inspected).toEqual(['art.pdf']);
      expect([...jobs.byId.values()].map((job) => job.metadata)).toEqual([{}]);
      expect((await readdir(dir)).sort()).toEqual([PROCESSED, 'order.jdf'].sort());
    });

    it('makes one job from a paired file and does not pick the file up on its own', async () => {
      const inspected: string[] = [];
      await writeFile(join(dir, 'art.pdf'), '%PDF-1.7 art');
      await writeFile(join(dir, 'order.jdf'), ticketXml(['art.pdf']));

      const { jobs, outcomes } = await runWatcher(true, inspected);

      expect(outcomes.map((entry) => entry.path)).toEqual([join(dir, 'order.jdf')]);
      expect(outcomes[0]?.outcome.kind).toBe('ready');
      expect(inspected).toEqual(['art.pdf']);
      expect([...jobs.byId.values()].map((job) => job.metadata['jdf.jobId'])).toEqual(['J-100']);
      expect(await readdir(dir)).toEqual([PROCESSED]);
      expect((await readdir(join(dir, PROCESSED))).sort()).toEqual(['art.pdf', 'order.jdf']);
    });

    it('still ingests a file no ticket names when acceptJdf is on', async () => {
      const inspected: string[] = [];
      await writeFile(join(dir, 'plain.pdf'), '%PDF-1.7 plain');

      const { jobs, outcomes } = await runWatcher(true, inspected);

      expect(outcomes.map((entry) => entry.outcome.kind)).toEqual(['ready']);
      expect(inspected).toEqual(['plain.pdf']);
      expect([...jobs.byId.values()].map((job) => job.metadata)).toEqual([{}]);
    });
  });
});
