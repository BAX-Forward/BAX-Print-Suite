import { BpsError } from '@bax-print/core';

/** A job package is malformed, incomplete, or a member does not match its recorded SHA-256. */
export class PackageIntegrityError extends BpsError {
  constructor(message: string, options?: ErrorOptions) {
    super('PACKAGE_INTEGRITY', message, options);
  }
}

export class JobNotFoundError extends BpsError {
  readonly jobId: string;

  constructor(jobId: string) {
    super('JOB_NOT_FOUND', `job ${jobId} does not exist`);
    this.jobId = jobId;
  }
}

/** The reprint target differs from the original device or medium and no color setup was picked. */
export class ColorSetupRequiredError extends BpsError {
  constructor(message: string) {
    super('COLOR_SETUP_REQUIRED', message);
  }
}

export class ColorSetupNotFoundError extends BpsError {
  constructor(what: string) {
    super('COLOR_SETUP_NOT_FOUND', `color setup revision not found: ${what}`);
  }
}

export class ColorSetupMismatchError extends BpsError {
  constructor(revisionId: string, deviceId: string | undefined, mediumId: string | undefined) {
    super(
      'COLOR_SETUP_MISMATCH',
      `color setup revision ${revisionId} does not belong to device ${deviceId ?? '-'} and medium ${mediumId ?? '-'}`,
    );
  }
}

/** An imported package references devices or media that are unknown here and were not remapped. */
export class RemapRequiredError extends BpsError {
  readonly unknownDevices: readonly string[];
  readonly unknownMedia: readonly string[];

  constructor(unknownDevices: readonly string[], unknownMedia: readonly string[]) {
    const parts = [
      unknownDevices.length > 0 ? `devices ${unknownDevices.join(', ')}` : '',
      unknownMedia.length > 0 ? `media ${unknownMedia.join(', ')}` : '',
    ].filter(Boolean);
    super('REMAP_REQUIRED', `the package uses unknown ${parts.join(' and ')}; choose replacements to import it`);
    this.unknownDevices = unknownDevices;
    this.unknownMedia = unknownMedia;
  }
}
