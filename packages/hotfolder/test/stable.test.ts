import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StableWriteTracker, type StableFileInfo } from '../src/index.js';

const POLL_MS = 10;
/** Long enough for several polls to run. */
const SETTLE_MS = 80;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await sleep(POLL_MS);
  }
}

describe('StableWriteTracker', () => {
  let dir: string;
  let fakeNow: number;
  let seen: Array<{ path: string; info: StableFileInfo }>;
  let tracker: StableWriteTracker;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bps-stable-'));
    fakeNow = 0;
    seen = [];
    tracker = new StableWriteTracker(
      { stabilityMs: 1_000, pollIntervalMs: POLL_MS, lockProbe: false, now: () => fakeNow },
      (path, info) => seen.push({ path, info }),
    );
  });

  afterEach(async () => {
    tracker.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a file once, after size and mtime stay unchanged for the window', async () => {
    const file = join(dir, 'a.pdf');
    await writeFile(file, 'part1');
    tracker.track(file);
    tracker.track(file);
    expect(tracker.size).toBe(1);
    await sleep(SETTLE_MS);

    fakeNow = 999;
    await sleep(SETTLE_MS);
    expect(seen).toEqual([]);

    fakeNow = 1_000;
    await waitFor(() => seen.length > 0);
    await sleep(SETTLE_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ path: file, info: { sizeBytes: 5 } });
    expect(tracker.isTracking(file)).toBe(false);
  });

  it('restarts the window when the writer appends more data', async () => {
    const file = join(dir, 'chunked.pdf');
    await writeFile(file, 'part1');
    tracker.track(file);
    await sleep(SETTLE_MS);

    fakeNow = 900;
    await appendFile(file, '-part2');
    await sleep(SETTLE_MS);

    fakeNow = 1_500;
    await sleep(SETTLE_MS);
    expect(seen).toEqual([]);

    fakeNow = 1_900;
    await waitFor(() => seen.length > 0);
    expect(seen[0]?.info.sizeBytes).toBe(11);
  });

  it('waits longer for zero-byte files', async () => {
    const file = join(dir, 'empty.pdf');
    await writeFile(file, '');
    tracker.track(file);
    await sleep(SETTLE_MS);

    fakeNow = 4_999;
    await sleep(SETTLE_MS);
    expect(seen).toEqual([]);

    fakeNow = 5_000;
    await waitFor(() => seen.length > 0);
    expect(seen[0]?.info.sizeBytes).toBe(0);
  });

  it('drops files that disappear before they are stable', async () => {
    const file = join(dir, 'gone.pdf');
    await writeFile(file, 'x');
    tracker.track(file);
    await sleep(SETTLE_MS);
    await rm(file);
    await waitFor(() => !tracker.isTracking(file));

    fakeNow = 10_000;
    await sleep(SETTLE_MS);
    expect(seen).toEqual([]);
  });

  it('ignores track calls after stop', async () => {
    const file = join(dir, 'late.pdf');
    await writeFile(file, 'x');
    tracker.stop();
    tracker.track(file);
    expect(tracker.isTracking(file)).toBe(false);
  });
});
