import { resolve } from 'node:path';
import { normalizePath, type Plugin } from 'vite';

/**
 * Spec 049c: build-time wiring of the tile preview into the job page, used by vite.config.ts only.
 *
 * With BPS_DASHBOARD_TILE_PREVIEW=1 this plugin points App.tsx's import of the job detail page at
 * JobDetailTilePage.tsx, which renders the unchanged JobDetailPage plus the lazily loaded tile
 * section. With the flag off the plugin is not installed, so no file of the flag-off module graph
 * changes and the dist output (source maps included, whose sourcesContent embeds every bundled
 * source file) stays byte-identical.
 */

/** Export condition under which workspace packages point at their TypeScript sources. */
export const WORKSPACE_SOURCE_CONDITION = '@bax-print/source';

/** The specifier App.tsx uses for the job detail route. */
export const JOB_DETAIL_IMPORT = './pages/JobDetailPage';

const APP_FILE = 'src/App.tsx';
const TILE_PAGE_FILE = 'src/pages/JobDetailTilePage.tsx';

/** The file to load instead of `source`, or null to resolve it as usual. */
export function tilePreviewPageTarget(root: string, source: string, importer: string | undefined): string | null {
  if (source === JOB_DETAIL_IMPORT && importer === normalizePath(resolve(root, APP_FILE))) {
    return normalizePath(resolve(root, TILE_PAGE_FILE));
  }
  return null;
}

export function tilePreviewPagePlugin(): Plugin {
  let root = process.cwd();
  return {
    name: 'bps-tile-preview-page',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    resolveId(source, importer) {
      return tilePreviewPageTarget(root, source, importer);
    },
  };
}
