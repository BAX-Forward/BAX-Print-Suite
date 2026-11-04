import { newId as defaultNewId } from '@bax-print/core';
import type { MediaRepository } from '@bax-print/store';
import type { MediaEventSink } from './events.js';

export interface MediaContext {
  repo: MediaRepository;
  now?: () => string;
  newId?: () => string;
  emit?: MediaEventSink;
  /**
   * Counts references from the job store (Spec 001). Job color bindings recorded by this
   * package are always counted in addition.
   */
  countJobReferences?: (mediumId: string) => number;
}

export interface ResolvedMediaContext {
  repo: MediaRepository;
  now: () => string;
  newId: () => string;
  emit: MediaEventSink;
  countJobReferences: (mediumId: string) => number;
}

export function resolveContext(ctx: MediaContext): ResolvedMediaContext {
  return {
    repo: ctx.repo,
    now: ctx.now ?? (() => new Date().toISOString()),
    newId: ctx.newId ?? (() => defaultNewId()),
    emit: ctx.emit ?? (() => undefined),
    countJobReferences: ctx.countJobReferences ?? (() => 0),
  };
}
