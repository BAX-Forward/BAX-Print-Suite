/**
 * Build-time feature flags, read by vite.config.ts from process.env and compiled in with `define`.
 * Unset means off, exactly "1" means on, and anything else is a configuration error that stops the
 * build or dev server (the same rule as the server's BPS_* flags).
 */

export const TILE_PREVIEW_ENV = 'BPS_DASHBOARD_TILE_PREVIEW';
export const JOB_UPLOAD_ENV = 'BPS_DASHBOARD_JOB_UPLOAD';

export function parseBuildFlag(name: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new Error(`${name} must be unset or exactly "1" (got ${JSON.stringify(value)})`);
}

/** Spec 049a: read-only tile panel preview on the dashboard (Spec 009 FR10, first slice). */
export function tilePreviewFlag(env: Record<string, string | undefined>): boolean {
  return parseBuildFlag(TILE_PREVIEW_ENV, env[TILE_PREVIEW_ENV]);
}

/** Spec 052b: Upload PDF button on the job list (POST /jobs, Spec 052a). */
export function jobUploadFlag(env: Record<string, string | undefined>): boolean {
  return parseBuildFlag(JOB_UPLOAD_ENV, env[JOB_UPLOAD_ENV]);
}
