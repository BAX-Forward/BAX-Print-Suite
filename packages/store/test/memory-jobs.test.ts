import { describe, expect, it } from 'vitest';
import type { Job } from '@bax-print/core';
import { MemoryJobRepository } from '../src/index.js';

const T0 = '2026-03-01T09:00:00.000Z';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Banner.pdf',
    status: 'received',
    priority: 50,
    sourceFiles: [],
    artifacts: [],
    ticket: { intent: { quantity: 1, finishedSize: { widthMm: 1000, heightMm: 500 } }, process: {} },
    tags: [],
    metadata: {},
    createdAt: T0,
    updatedAt: T0,
    lifecycle: 'active',
    legalHold: false,
    ...overrides,
  };
}

/** A job document whose `whiteInk` is not a setting, as an older or foreign writer may have stored it. */
function storedWith(whiteInk: unknown): Job {
  const doc: unknown = JSON.parse(JSON.stringify({ ...job(), whiteInk }));
  if (typeof doc !== 'object' || doc === null || !('id' in doc)) throw new TypeError('not a job document');
  return Object.assign(job(), doc);
}

/** A job document whose `screening` is not a setting (spec 039b). */
function storedWithScreening(screening: unknown): Job {
  const doc: unknown = JSON.parse(JSON.stringify({ ...job(), screening }));
  if (typeof doc === 'object' && doc !== null && 'id' in doc) return Object.assign(job(), doc);
  throw new TypeError('not a job document');
}

/** A job document whose `inkLimit` is not a setting (spec 040b). */
function storedWithInkLimit(inkLimit: unknown): Job {
  const doc: unknown = JSON.parse(JSON.stringify({ ...job(), inkLimit }));
  if (typeof doc === 'object' && doc !== null && 'id' in doc) return Object.assign(job(), doc);
  throw new TypeError('not a job document');
}

/** A job document whose `planeCurves` is not a setting (spec 044b). */
function storedWithPlaneCurves(planeCurves: unknown): Job {
  const doc: unknown = JSON.parse(JSON.stringify({ ...job(), planeCurves }));
  if (typeof doc === 'object' && doc && 'id' in doc) return Object.assign(job(), doc);
  throw new TypeError('not a job document');
}

describe('MemoryJobRepository whiteInk (spec 038c)', () => {
  it('round-trips a valid setting and leaves an absent one absent', async () => {
    const repo = new MemoryJobRepository();
    const withWhite = job({ id: 'white', whiteInk: { mode: 'flood', density: 100 } });
    await repo.save(withWhite);
    await repo.save(job({ id: 'plain' }));

    expect(await repo.get('white')).toStrictEqual(withWhite);
    const plain = await repo.get('plain');
    expect(plain).toStrictEqual(job({ id: 'plain' }));
    expect(plain !== undefined && 'whiteInk' in plain).toBe(false);
  });

  it.each([['yes'], [{ mode: 'x' }], [{ mode: 'choke', chokePx: 65 }]])(
    'reads a stored invalid whiteInk %j back with no whiteInk',
    async (whiteInk) => {
      const repo = new MemoryJobRepository();
      await repo.save(storedWith(whiteInk));

      expect(await repo.get('job-1')).toStrictEqual(job());
      expect(await repo.list()).toStrictEqual([job()]);
    },
  );
});

describe('MemoryJobRepository screening (spec 039b)', () => {
  it('round-trips valid settings, keeps whiteInk, and leaves an absent one absent', async () => {
    const repo = new MemoryJobRepository();
    const bayer = job({ id: 'bayer', screening: { kind: 'bayer', size: 16 } });
    const blue = job({
      id: 'blue',
      whiteInk: { mode: 'flood', density: 100 },
      screening: { kind: 'blue-noise', size: 128, seed: 7 },
    });
    await repo.save(bayer);
    await repo.save(blue);
    await repo.save(job({ id: 'plain' }));

    expect(await repo.get('bayer')).toStrictEqual(bayer);
    expect(await repo.get('blue')).toStrictEqual(blue);
    const plain = await repo.get('plain');
    expect(plain).toStrictEqual(job({ id: 'plain' }));
    expect(plain !== undefined && 'screening' in plain).toBe(false);
  });

  it.each<unknown>([
    'yes',
    { kind: 'x' },
    { kind: 'bayer', size: 3 },
    { kind: 'blue-noise', size: 300, seed: 1 },
    { kind: 'bayer', size: 4, extra: 1 },
  ])('reads a stored invalid screening %j back with no screening', async (screening) => {
    const repo = new MemoryJobRepository();
    await repo.save(storedWithScreening(screening));

    expect(await repo.get('job-1')).toStrictEqual(job());
    expect(await repo.list()).toStrictEqual([job()]);
  });
});

describe('MemoryJobRepository inkLimit (spec 040b)', () => {
  it('round-trips valid settings, keeps other settings, and leaves an absent one absent', async () => {
    const repo = new MemoryJobRepository();
    const gcr = job({ id: 'gcr', inkLimit: { limitPercent: 260, method: 'gcr' } });
    const proportional = job({
      id: 'proportional',
      whiteInk: { mode: 'flood', density: 100 },
      screening: { kind: 'bayer', size: 4 },
      inkLimit: { limitPercent: 100, method: 'proportional' },
    });
    const existing = job({ id: 'existing', screening: { kind: 'blue-noise', size: 128, seed: 7 } });
    await repo.save(gcr);
    await repo.save(proportional);
    await repo.save(existing);
    await repo.save(job({ id: 'plain' }));

    expect(await repo.get('gcr')).toStrictEqual(gcr);
    expect(await repo.get('proportional')).toStrictEqual(proportional);
    expect(await repo.get('existing')).toStrictEqual(existing);
    const plain = await repo.get('plain');
    expect(plain).toStrictEqual(job({ id: 'plain' }));
    expect(plain !== undefined && 'inkLimit' in plain).toBe(false);
  });

  it.each<unknown>([
    'yes',
    null,
    { limitPercent: 99, method: 'gcr' },
    { limitPercent: 401, method: 'gcr' },
    { limitPercent: 250.5, method: 'gcr' },
    { limitPercent: 300, method: 'gcr2' },
    { limitPercent: 300, method: 'gcr', extra: 1 },
  ])('reads a stored invalid inkLimit %j back with no inkLimit', async (inkLimit) => {
    const repo = new MemoryJobRepository();
    await repo.save(storedWithInkLimit(inkLimit));

    expect(await repo.get('job-1')).toStrictEqual(job());
    expect(await repo.list()).toStrictEqual([job()]);
  });
});

describe('MemoryJobRepository planeCurves (spec 044b)', () => {
  it('round-trips valid settings, keeps other settings, and leaves an absent one absent', async () => {
    const repo = new MemoryJobRepository();
    const magenta = job({
      id: 'magenta',
      planeCurves: { m: { points: [{ in: 0, out: 0 }, { in: 100, out: 90 }, { in: 255, out: 255 }], method: 'monotone' } },
    });
    const all = job({
      id: 'all',
      whiteInk: { mode: 'flood', density: 100 },
      screening: { kind: 'bayer', size: 4 },
      inkLimit: { limitPercent: 260, method: 'gcr' },
      planeCurves: {
        c: { points: [{ in: 0, out: 0 }, { in: 255, out: 255 }], method: 'linear' },
        k: { points: [{ in: 0, out: 3 }, { in: 255, out: 250 }], method: 'monotone' },
      },
    });
    const existing = job({ id: 'existing', inkLimit: { limitPercent: 100, method: 'proportional' } });
    await repo.save(magenta);
    await repo.save(all);
    await repo.save(existing);
    await repo.save(job({ id: 'plain' }));

    expect(await repo.get('magenta')).toStrictEqual(magenta);
    expect(await repo.get('all')).toStrictEqual(all);
    expect(await repo.get('existing')).toStrictEqual(existing);
    const plain = await repo.get('plain');
    expect(plain).toStrictEqual(job({ id: 'plain' }));
    expect(plain).not.toHaveProperty('planeCurves');
  });

  it.each<unknown>([
    'yes',
    null,
    {},
    { c: { points: [{ in: 0, out: 0 }, { in: 0, out: 0 }, { in: 255, out: 255 }], method: 'linear' } },
    { c: { points: [{ in: 0, out: 0 }, { in: 255.5, out: 255 }], method: 'linear' } },
    { m: { points: [{ in: 0, out: 0 }, { in: 255, out: 255 }], method: 'Linear' } },
    { c: { points: [{ in: 0, out: 0, x: 1 }, { in: 255, out: 255 }], method: 'linear' } },
  ])('reads a stored invalid planeCurves %j back with no planeCurves', async (planeCurves) => {
    const repo = new MemoryJobRepository();
    await repo.save(storedWithPlaneCurves(planeCurves));

    expect(await repo.get('job-1')).toStrictEqual(job());
    expect(await repo.list()).toStrictEqual([job()]);
  });
});
