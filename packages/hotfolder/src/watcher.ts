import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { FAILED_SUBFOLDER, noopLogger, type HotFolder, type Logger } from '@bax-print/core';
import { hotFolderFileDetectedEvent } from '@bax-print/events';
import type { HotFolderRepository } from '@bax-print/store';
import { HOTFOLDER_EVENT_SOURCE, ingestFile, type IntakeDeps, type IntakeOutcome } from './intake.js';
import { isCandidateFileName } from './patterns.js';
import { StableWriteTracker } from './stable.js';

export interface WatchOptions {
  /** A file is ingested once its size and mtime stayed unchanged for this long. */
  stabilityMs?: number;
  /** How often files waiting for stability are re-checked. */
  pollIntervalMs?: number;
  /** Periodic directory rescan that catches events the OS watcher missed. 0 disables it. */
  rescanIntervalMs?: number;
  /** Poll instead of native events (e.g. for network shares). */
  usePolling?: boolean;
}

export const DEFAULT_WATCH_OPTIONS: Readonly<Required<WatchOptions>> = Object.freeze({
  stabilityMs: 1_000,
  pollIntervalMs: 200,
  rescanIntervalMs: 2_000,
  usePolling: false,
});

export type IntakeOutcomeListener = (outcome: IntakeOutcome, path: string, folder: HotFolder) => void;

export interface HotFolderWatcherOptions extends WatchOptions {
  folder: HotFolder;
  deps: IntakeDeps;
  onOutcome?: IntakeOutcomeListener;
}

export class HotFolderPathError extends Error {
  readonly code = 'HOT_FOLDER_PATH_INVALID';

  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Hot folder path ${path} ${reason}`);
    this.name = 'HotFolderPathError';
  }
}

/** Throws {@link HotFolderPathError} unless `path` is an existing directory (not a link to one). */
export async function assertWatchableDirectory(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new HotFolderPathError(path, 'does not exist');
  }
  if (stats.isSymbolicLink()) {
    throw new HotFolderPathError(path, 'is a symbolic link; register its target instead');
  }
  if (!stats.isDirectory()) {
    throw new HotFolderPathError(path, 'is not a directory');
  }
}

/**
 * Watches one hot folder (top level only): chokidar events plus a periodic rescan feed candidate
 * files into stable-write detection; stable files are ingested one at a time. Temp/partial names,
 * files that do not match the folder's patterns, symlinks and the `_processed` / `_failed`
 * subfolders are ignored (ARCHITECTURE.md §9).
 */
export class HotFolderWatcher {
  readonly folder: HotFolder;
  private readonly root: string;
  private readonly settings: Required<WatchOptions>;
  private readonly logger: Logger;
  private readonly tracker: StableWriteTracker;
  private readonly inFlight = new Set<string>();
  /** Files that were ingested but could not be moved away, keyed by path → size:mtime. */
  private readonly unmoved = new Map<string, string>();
  private readonly rejectedLinks = new Set<string>();
  private watcher: FSWatcher | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: HotFolderWatcherOptions) {
    this.folder = options.folder;
    this.root = resolve(options.folder.path);
    this.settings = {
      stabilityMs: options.stabilityMs ?? DEFAULT_WATCH_OPTIONS.stabilityMs,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_WATCH_OPTIONS.pollIntervalMs,
      rescanIntervalMs: options.rescanIntervalMs ?? DEFAULT_WATCH_OPTIONS.rescanIntervalMs,
      usePolling: options.usePolling ?? DEFAULT_WATCH_OPTIONS.usePolling,
    };
    this.logger = options.deps.logger ?? noopLogger;
    this.tracker = new StableWriteTracker(
      { stabilityMs: this.settings.stabilityMs, pollIntervalMs: this.settings.pollIntervalMs },
      (path) => this.onStable(path),
    );
  }

  async start(): Promise<void> {
    await assertWatchableDirectory(this.root);
    const watcher = watch(this.root, {
      depth: 0,
      ignoreInitial: false,
      followSymlinks: false,
      usePolling: this.settings.usePolling,
      interval: this.settings.pollIntervalMs,
      ignored: (path: string) => this.isIgnoredPath(path),
    });
    this.watcher = watcher;
    watcher.on('add', (path: string) => void this.consider(path));
    watcher.on('change', (path: string) => void this.consider(path));
    watcher.on('error', (error: unknown) =>
      this.logger.warn('hot folder watcher error', {
        hotFolderId: this.folder.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await new Promise<void>((resolveReady) => watcher.once('ready', () => resolveReady()));
    if (this.settings.rescanIntervalMs > 0) {
      this.rescanTimer = setInterval(() => void this.rescan(), this.settings.rescanIntervalMs);
    }
    await this.rescan();
    this.logger.info('watching hot folder', { hotFolderId: this.folder.id, path: this.root });
  }

  /** Stops watching and waits for the ingestion in progress (if any) to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.tracker.stop();
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = undefined;
    }
    await this.watcher?.close();
    this.watcher = undefined;
    await this.queue;
  }

  private isIgnoredPath(path: string): boolean {
    const absolute = resolve(path);
    if (absolute === this.root) {
      return false;
    }
    const name = basename(absolute);
    return name === FAILED_SUBFOLDER || name === basename(this.folder.settings.moveProcessedTo);
  }

  private async rescan(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() || entry.isSymbolicLink()) {
          await this.consider(join(this.root, entry.name));
        }
      }
    } catch (error) {
      this.logger.warn('hot folder rescan failed', {
        hotFolderId: this.folder.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async consider(path: string): Promise<void> {
    const absolute = resolve(path);
    if (
      this.stopped ||
      dirname(absolute) !== this.root ||
      this.inFlight.has(absolute) ||
      this.tracker.isTracking(absolute)
    ) {
      return;
    }
    const name = basename(absolute);
    if (!isCandidateFileName(name, this.folder.settings.filePatterns)) {
      return;
    }
    let stats;
    try {
      stats = await lstat(absolute);
    } catch {
      return;
    }
    if (stats.isSymbolicLink()) {
      if (!this.rejectedLinks.has(absolute)) {
        this.rejectedLinks.add(absolute);
        this.logger.warn('symbolic link in hot folder ignored', { hotFolderId: this.folder.id, path: absolute });
      }
      return;
    }
    if (!stats.isFile() || this.unmoved.get(absolute) === `${stats.size}:${stats.mtimeMs}`) {
      return;
    }
    this.unmoved.delete(absolute);
    if (this.stopped || this.inFlight.has(absolute) || this.tracker.isTracking(absolute)) {
      return;
    }
    this.tracker.track(absolute);
    this.options.deps.bus?.publish(
      hotFolderFileDetectedEvent(HOTFOLDER_EVENT_SOURCE, { hotFolderId: this.folder.id, path: absolute }),
    );
  }

  private onStable(path: string): void {
    if (this.stopped || this.inFlight.has(path)) {
      return;
    }
    this.inFlight.add(path);
    this.queue = this.queue.then(() => this.ingest(path));
  }

  private async ingest(path: string): Promise<void> {
    try {
      const outcome = await ingestFile(path, this.folder, this.options.deps);
      if (outcome.movedTo === undefined) {
        await this.rememberUnmoved(path);
      }
      this.options.onOutcome?.(outcome, path, this.folder);
    } catch (error) {
      // ingestFile reports failures as outcomes; this only guards listener errors.
      this.logger.error('hot folder ingestion error', {
        hotFolderId: this.folder.id,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight.delete(path);
    }
  }

  private async rememberUnmoved(path: string): Promise<void> {
    try {
      const stats = await stat(path);
      this.unmoved.set(path, `${stats.size}:${stats.mtimeMs}`);
    } catch {
      // The file is gone after all; nothing to remember.
    }
  }
}

export interface HotFolderRunnerOptions extends WatchOptions {
  repository: HotFolderRepository;
  deps: IntakeDeps;
  onOutcome?: IntakeOutcomeListener;
}

/** Runs one {@link HotFolderWatcher} per enabled hot folder in the repository. */
export class HotFolderRunner {
  private readonly watchers = new Map<string, HotFolderWatcher>();
  private readonly logger: Logger;

  constructor(private readonly options: HotFolderRunnerOptions) {
    this.logger = options.deps.logger ?? noopLogger;
  }

  /** Starts watchers for every enabled folder. A folder that cannot be watched is logged, not fatal. */
  async start(): Promise<void> {
    for (const folder of await this.options.repository.list()) {
      if (!folder.enabled) {
        continue;
      }
      try {
        await this.watch(folder);
      } catch (error) {
        this.logger.error('cannot watch hot folder', {
          hotFolderId: folder.id,
          path: folder.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async watch(folder: HotFolder): Promise<void> {
    if (this.watchers.has(folder.id)) {
      return;
    }
    const watcher = new HotFolderWatcher({
      folder,
      deps: this.options.deps,
      onOutcome: this.options.onOutcome,
      stabilityMs: this.options.stabilityMs,
      pollIntervalMs: this.options.pollIntervalMs,
      rescanIntervalMs: this.options.rescanIntervalMs,
      usePolling: this.options.usePolling,
    });
    this.watchers.set(folder.id, watcher);
    try {
      await watcher.start();
    } catch (error) {
      this.watchers.delete(folder.id);
      await watcher.stop();
      throw error;
    }
  }

  async unwatch(folderId: string): Promise<void> {
    const watcher = this.watchers.get(folderId);
    this.watchers.delete(folderId);
    await watcher?.stop();
  }

  isWatching(folderId: string): boolean {
    return this.watchers.has(folderId);
  }

  async stop(): Promise<void> {
    const watchers = [...this.watchers.values()];
    this.watchers.clear();
    await Promise.all(watchers.map((watcher) => watcher.stop()));
  }
}
