import { lstat, open } from 'node:fs/promises';

export interface StableWriteOptions {
  /** A file is stable once its size and mtime stay unchanged for this long. */
  stabilityMs: number;
  /** How often tracked files are re-checked. */
  pollIntervalMs: number;
  /**
   * Zero-byte files wait this long instead, because many writers create the file first and fill
   * it later. Defaults to 5 × `stabilityMs`.
   */
  emptyFileStabilityMs?: number;
  /** Probe for an exclusive lock held by the writer (useful on Windows). Defaults to win32 only. */
  lockProbe?: boolean;
  now?: () => number;
}

export interface StableFileInfo {
  sizeBytes: number;
  mtimeMs: number;
}

interface Observation {
  sizeBytes: number;
  mtimeMs: number;
  /** When the current size/mtime were first seen; undefined until the first poll. */
  since: number | undefined;
}

const LOCKED_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** True when another process holds the file open in a way that blocks a read-write open. */
async function isLocked(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r+');
    await handle.close();
    return false;
  } catch (error) {
    return LOCKED_ERROR_CODES.has(String((error as NodeJS.ErrnoException).code));
  }
}

/**
 * Stable-write detection. Tracked files are polled; a file is reported once (via `onStable`) after
 * its size and mtime stayed unchanged for the stability window, so a file written in chunks is
 * only handed on after the writer finished. Files that disappear or stop being regular files
 * (e.g. replaced by a symlink) are dropped silently.
 */
export class StableWriteTracker {
  private readonly observations = new Map<string, Observation>();
  private readonly now: () => number;
  private readonly lockProbe: boolean;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private stopped = false;

  constructor(
    private readonly options: StableWriteOptions,
    private readonly onStable: (path: string, info: StableFileInfo) => void,
  ) {
    this.now = options.now ?? Date.now;
    this.lockProbe = options.lockProbe ?? process.platform === 'win32';
  }

  /** Starts watching `path`. Tracking a path that is already tracked has no effect. */
  track(path: string): void {
    if (this.stopped || this.observations.has(path)) {
      return;
    }
    this.observations.set(path, { sizeBytes: -1, mtimeMs: -1, since: undefined });
    this.timer ??= setInterval(() => void this.poll(), this.options.pollIntervalMs);
  }

  isTracking(path: string): boolean {
    return this.observations.has(path);
  }

  get size(): number {
    return this.observations.size;
  }

  stop(): void {
    this.stopped = true;
    this.observations.clear();
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      for (const [path, observation] of [...this.observations]) {
        await this.check(path, observation);
      }
    } finally {
      this.polling = false;
      if (this.observations.size === 0) {
        this.clearTimer();
      }
    }
  }

  private async check(path: string, observation: Observation): Promise<void> {
    let sizeBytes: number;
    let mtimeMs: number;
    try {
      const stats = await lstat(path);
      if (!stats.isFile()) {
        this.observations.delete(path);
        return;
      }
      sizeBytes = stats.size;
      mtimeMs = stats.mtimeMs;
    } catch {
      this.observations.delete(path);
      return;
    }
    const now = this.now();
    if (
      observation.since === undefined ||
      sizeBytes !== observation.sizeBytes ||
      mtimeMs !== observation.mtimeMs
    ) {
      observation.sizeBytes = sizeBytes;
      observation.mtimeMs = mtimeMs;
      observation.since = now;
      return;
    }
    const window =
      sizeBytes === 0
        ? (this.options.emptyFileStabilityMs ?? this.options.stabilityMs * 5)
        : this.options.stabilityMs;
    if (now - observation.since < window) {
      return;
    }
    if (this.lockProbe && (await isLocked(path))) {
      return;
    }
    if (this.observations.get(path) !== observation || this.stopped) {
      return;
    }
    this.observations.delete(path);
    this.onStable(path, { sizeBytes, mtimeMs });
  }
}
