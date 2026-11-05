import { beforeEach, describe, expect, it } from 'vitest';
import type { Job, JobTicket } from '@bax-print/core';
import { packageKey } from '@bax-print/store';
import { unpack } from '../src/index.js';
import {
  cutContours,
  cutSvg,
  imposePdf,
  maxDeviationMm,
  pageBoxes,
  pixelDiff,
  renderPdf,
  type Point,
} from './fixtures/mock-pipeline.js';
import { createHarness, DEFAULT_TICKET, DEVICE_A, MEDIUM_GLOSS, revision, seedJob, type Harness } from './helpers.js';

const CUT_TOLERANCE_MM = 0.01;
const ORIGINAL = 'fixture-001';
const REV = 'rev-fixture-1';

interface Outputs {
  readonly pdf: Uint8Array;
  readonly cut: Uint8Array;
}

async function archivedFixture(h: Harness): Promise<void> {
  h.colorSetups.addRevision(revision(REV, DEVICE_A, MEDIUM_GLOSS));
  await seedJob(h, {
    id: ORIGINAL,
    deviceId: DEVICE_A,
    mediumId: MEDIUM_GLOSS,
    colorSetupRevisionId: REV,
    ticket: DEFAULT_TICKET,
    artifacts: [
      { role: 'layout', name: 'imposed.pdf', bytes: imposePdf(DEFAULT_TICKET) },
      { role: 'cut', name: 'cut.svg', bytes: cutSvg(DEFAULT_TICKET) },
    ],
  });
  await h.service.archive(ORIGINAL);
}

async function originalOutputs(h: Harness): Promise<Outputs> {
  const pkg = unpack(await h.archive.get(packageKey(ORIGINAL)));
  const at = (role: string): Uint8Array => {
    const bytes = pkg.artifacts[pkg.job.artifacts.findIndex((a) => a.role === role)];
    if (!bytes) throw new Error(`package has no ${role} artifact`);
    return bytes;
  };
  return { pdf: at('layout'), cut: at('cut') };
}

async function storedOutputs(h: Harness, job: Job): Promise<Outputs> {
  const key = (role: string): string => {
    const artifact = job.artifacts.find((a) => a.role === role);
    if (!artifact) throw new Error(`reprint has no ${role} artifact`);
    return artifact.storageKey;
  };
  return { pdf: await h.blobs.get(key('layout')), cut: await h.blobs.get(key('cut')) };
}

function expectEquivalent(original: Outputs, reprint: Outputs): void {
  expect(pageBoxes(reprint.pdf)).toEqual(pageBoxes(original.pdf));
  expect(maxDeviationMm(cutContours(reprint.cut), cutContours(original.cut))).toBeLessThanOrEqual(CUT_TOLERANCE_MM);
  expect(pixelDiff(renderPdf(reprint.pdf), renderPdf(original.pdf))).toBe(0);
}

describe('differential: original vs reprint (own fixtures, mock pipeline)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await archivedFixture(h);
  });

  it('restored layout and cut files of the reprint match the original', async () => {
    const { job } = await h.service.reprint(ORIGINAL);
    expectEquivalent(await originalOutputs(h), await storedOutputs(h, job));
  });

  it('re-running the mock pipeline on the reprint ticket matches the original', async () => {
    const { job } = await h.service.reprint(ORIGINAL);
    expect(job.ticket).toEqual(DEFAULT_TICKET);
    expectEquivalent(await originalOutputs(h), { pdf: imposePdf(job.ticket), cut: cutSvg(job.ticket) });
  });

  it('the comparison is sensitive: a changed layout fails every check', async () => {
    const changed: JobTicket = { ...DEFAULT_TICKET, process: { layout: { marginMm: 10, gapMm: 6 } } };
    const original = await originalOutputs(h);
    const other = { pdf: imposePdf(changed), cut: cutSvg(changed) };
    expect(pageBoxes(other.pdf)).not.toEqual(pageBoxes(original.pdf));
    expect(maxDeviationMm(cutContours(other.cut), cutContours(original.cut))).toBeGreaterThan(CUT_TOLERANCE_MM);
    expect(pixelDiff(renderPdf(other.pdf), renderPdf(original.pdf))).toBeGreaterThan(0);
  });
});

describe('mock pipeline fixtures', () => {
  it('produce the expected sheet and contours for the default ticket', () => {
    // Two 200 × 100 mm items, 10 mm margin, 5 mm gap → 425 × 120 mm sheet.
    const boxes = pageBoxes(imposePdf(DEFAULT_TICKET));
    expect(boxes.MediaBox[2]).toBeCloseTo((425 * 72) / 25.4, 2);
    expect(boxes.MediaBox[3]).toBeCloseTo((120 * 72) / 25.4, 2);
    expect(boxes.TrimBox).toEqual(boxes.MediaBox);

    const contours = cutContours(cutSvg(DEFAULT_TICKET));
    expect(contours).toEqual([
      [[10, 10], [210, 10], [210, 110], [10, 110]],
      [[215, 10], [415, 10], [415, 110], [215, 110]],
    ]);
  });

  it('accepts cut deviation within tolerance and rejects it beyond', () => {
    const base: Point[][] = [[[10, 10], [20, 10]]];
    expect(maxDeviationMm(base, [[[10.004, 10], [20, 10.006]]])).toBeLessThanOrEqual(CUT_TOLERANCE_MM);
    expect(maxDeviationMm(base, [[[10.02, 10], [20, 10]]])).toBeGreaterThan(CUT_TOLERANCE_MM);
    expect(maxDeviationMm(base, [])).toBe(Number.POSITIVE_INFINITY);
  });

  it('writes a PDF whose xref offsets point at its objects', () => {
    const text = Buffer.from(imposePdf(DEFAULT_TICKET)).toString('latin1');
    const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.startsWith('xref', startxref)).toBe(true);
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(4);
    offsets.forEach((offset, i) => expect(text.startsWith(`${i + 1} 0 obj`, offset)).toBe(true));
  });
});
