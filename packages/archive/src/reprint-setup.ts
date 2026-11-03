import type { ColorSetupResolver } from './color-setups.js';
import { ColorSetupMismatchError, ColorSetupNotFoundError, ColorSetupRequiredError } from './errors.js';

export interface OriginalSetup {
  readonly deviceId?: string;
  readonly mediumId?: string;
  readonly colorSetupRevisionId?: string;
}

export interface ReprintSetupRequest {
  readonly deviceId?: string;
  readonly mediumId?: string;
  /** Explicit color setup revision for the target device and medium. */
  readonly colorSetupRevisionId?: string;
  /** Use the target pair's current head revision instead of the original one. */
  readonly useCurrentHead?: boolean;
}

export type SetupSource = 'original' | 'explicit' | 'head' | 'none';

export interface ReprintSetupDecision {
  readonly deviceId?: string;
  readonly mediumId?: string;
  readonly colorSetupRevisionId?: string;
  /** True when device or medium differ from the original job. */
  readonly changed: boolean;
  readonly source: SetupSource;
}

/**
 * Same device and medium reuse the original revision unless the user opts into the current head.
 * A different device or medium invalidates the stored revision, so the user must pick one.
 */
export async function resolveReprintSetup(
  original: OriginalSetup,
  request: ReprintSetupRequest,
  resolver: ColorSetupResolver,
): Promise<ReprintSetupDecision> {
  const deviceId = request.deviceId ?? original.deviceId;
  const mediumId = request.mediumId ?? original.mediumId;
  const changed = deviceId !== original.deviceId || mediumId !== original.mediumId;

  if (request.colorSetupRevisionId !== undefined) {
    const revision = await resolver.getRevision(request.colorSetupRevisionId);
    if (!revision) throw new ColorSetupNotFoundError(request.colorSetupRevisionId);
    if (revision.deviceId !== deviceId || revision.mediumId !== mediumId) {
      throw new ColorSetupMismatchError(revision.id, deviceId, mediumId);
    }
    return { deviceId, mediumId, colorSetupRevisionId: revision.id, changed, source: 'explicit' };
  }

  if (request.useCurrentHead) {
    if (deviceId === undefined || mediumId === undefined) {
      throw new ColorSetupRequiredError('a device and a medium are needed to use the current color setup');
    }
    const head = await resolver.getHead(deviceId, mediumId);
    if (!head) throw new ColorSetupNotFoundError(`current setup for ${deviceId} / ${mediumId}`);
    return { deviceId, mediumId, colorSetupRevisionId: head.id, changed, source: 'head' };
  }

  if (changed) {
    throw new ColorSetupRequiredError(
      `the reprint targets ${deviceId ?? '-'} / ${mediumId ?? '-'} instead of ${original.deviceId ?? '-'} / ${original.mediumId ?? '-'}; ` +
        'the original color setup no longer applies, so pick a setup',
    );
  }

  return {
    deviceId,
    mediumId,
    colorSetupRevisionId: original.colorSetupRevisionId,
    changed: false,
    source: original.colorSetupRevisionId === undefined ? 'none' : 'original',
  };
}
