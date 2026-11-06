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
