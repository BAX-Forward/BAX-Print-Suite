import type { ArtifactRole } from '@bax-print/core';
import { sanitizeKeySegment } from './storage.js';

/** Prefix under which every active blob of a job lives. */
export function jobKeyPrefix(jobId: string): string {
  return `jobs/${sanitizeKeySegment(jobId)}/`;
}

export function sourceKey(jobId: string, index: number, name: string): string {
  return `${jobKeyPrefix(jobId)}source/${index}-${sanitizeKeySegment(name)}`;
}

export function artifactKey(jobId: string, role: ArtifactRole, index: number, name: string): string {
  return `${jobKeyPrefix(jobId)}${role}/${index}-${sanitizeKeySegment(name)}`;
}

/** Key of an archived job package in the archive storage backend. */
export function packageKey(jobId: string): string {
  return `packages/${sanitizeKeySegment(jobId)}.bpsjob`;
}
