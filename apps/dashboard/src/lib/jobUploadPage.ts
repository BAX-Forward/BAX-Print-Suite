import { resolve } from 'node:path';
import { normalizePath, type Plugin } from 'vite';

/**
 * Spec 052b: build-time wiring of the Upload PDF button into the job list, used by vite.config.ts only.
 *
 * With BPS_DASHBOARD_JOB_UPLOAD=1 this plugin points App.tsx's import of the job list page at
 * JobsUploadPage.tsx, which renders the unchanged JobsPage plus the lazily loaded upload button.
 * With the flag off the plugin is not installed, so no file of the flag-off module graph changes and
 * the dist output (source maps included) stays what it is without the feature. Same technique as
 * tilePreviewPage.ts (049c).
 */

/** The specifier App.tsx uses for the job list route. */
export const JOBS_PAGE_IMPORT = './pages/JobsPage';

const APP_FILE = 'src/App.tsx';
const UPLOAD_PAGE_FILE = 'src/pages/JobsUploadPage.tsx';

/** The file to load instead of `source`, or null to resolve it as usual. */
export function jobUploadPageTarget(root: string, source: string, importer: string | undefined): string | null {
  if (source === JOBS_PAGE_IMPORT && importer === normalizePath(resolve(root, APP_FILE))) {
    return normalizePath(resolve(root, UPLOAD_PAGE_FILE));
  }
  return null;
}

export function jobUploadPagePlugin(): Plugin {
  let root = process.cwd();
  return {
    name: 'bps-job-upload-page',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    resolveId(source, importer) {
      return jobUploadPageTarget(root, source, importer);
    },
  };
}
