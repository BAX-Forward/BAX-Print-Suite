/** Stable, uppercase error codes. Hosts and tests match on `code`, never on the message. */
export type FolderErrorCode =
  | 'CONFIG_INVALID'
  | 'NOT_CONFIGURED'
  | 'INVALID_JOB_ID'
  | 'INVALID_SUBMISSION'
  | 'FORMAT_NOT_ACCEPTED'
  | 'OUTPUT_EXISTS'
  | 'UNKNOWN_JOB'
  | 'WRITE_FAILED';

export class FolderOutputError extends Error {
  constructor(
    readonly code: FolderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FolderOutputError';
  }
}

/** True when `error` is a Node.js system error carrying `errnoCode` (e.g. `ENOENT`). */
export function hasErrno(error: unknown, errnoCode: string): boolean {
  return error instanceof Error && 'code' in error && error.code === errnoCode;
}
