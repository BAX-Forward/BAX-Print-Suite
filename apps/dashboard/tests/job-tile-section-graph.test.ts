// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JOB_DETAIL_IMPORT, tilePreviewPageTarget } from '../src/lib/tilePreviewPage';

/**
 * Spec 049c: JobTileSection reaches the tile package through the pure `@bax-print/tile/layout`
 * entry only (Spec 049b), never through the package root or pdf-lib, and the flag-on job page
 * loads it with import() only, so it lands in its own chunk.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC_DIR = resolve(ROOT, 'src');
const TILE_PACKAGE = resolve(ROOT, '../../packages/tile');
const LAYOUT_ENTRY = '@bax-print/tile/layout';

/** Bare specifiers the section's own (dashboard) files may import; react for the seam editor's hooks (049d). */
const ALLOWED_BARE = [LAYOUT_ENTRY, 'react'];

const STATIC_PATTERNS: readonly RegExp[] = [
  // import x from "..."; import type { a } from "..."; export { a } from "..."; spans lines.
  /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
  // import "...";
  /^\s*import\s*["']([^"']+)["']/gm,
];
const DYNAMIC_PATTERN = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

interface BareImport {
  file: string;
  specifier: string;
}

function matches(source: string, patterns: readonly RegExp[]): string[] {
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])),
  );
}

/** Resolves a relative specifier the way the bundler does for these sources. */
function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`];
  const found = candidates.find((file) => existsSync(file));
  if (found === undefined) throw new Error(`unresolved import ${specifier} in ${from}`);
  return found;
}

/** Walks static imports from `entry`, following relative specifiers; also lists dynamic import() specifiers. */
function walk(entry: string) {
  const seen = new Set<string>();
  const bare: BareImport[] = [];
  const dynamic: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.css')) continue;
    const source = readFileSync(file, 'utf8');
    for (const specifier of matches(source, STATIC_PATTERNS)) {
      if (specifier.startsWith('.')) queue.push(resolveRelative(file, specifier));
      else bare.push({ file: relative(ROOT, file), specifier });
    }
    dynamic.push(...matches(source, [DYNAMIC_PATTERN]));
  }
  return { files: [...seen].map((file) => relative(ROOT, file)).sort(), bare, dynamic };
}

const isTileRoot = (specifier: string): boolean => specifier === '@bax-print/tile';
const isPdfLib = (specifier: string): boolean => specifier === 'pdf-lib' || specifier.startsWith('pdf-lib/');

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value ? new Map(Object.entries(value)).get(key) : undefined;
}

function layoutSourceEntry(): string {
  const manifest: unknown = JSON.parse(readFileSync(resolve(TILE_PACKAGE, 'package.json'), 'utf8'));
  const entry = field(field(field(manifest, 'exports'), './layout'), '@bax-print/source');
  if (typeof entry === 'string') return resolve(TILE_PACKAGE, entry);
  throw new Error('packages/tile has no ./layout source export');
}

describe('JobTileSection import graph', () => {
  const graph = walk(resolve(SRC_DIR, 'components/JobTileSection.tsx'));

  it('imports the tile package through @bax-print/tile/layout only', () => {
    expect(graph.bare.map((imp) => imp.specifier)).toContain(LAYOUT_ENTRY);
    expect(graph.bare.filter((imp) => isTileRoot(imp.specifier))).toEqual([]);
    expect(graph.bare.filter((imp) => isPdfLib(imp.specifier))).toEqual([]);
    expect(graph.bare.filter((imp) => ALLOWED_BARE.includes(imp.specifier) === false)).toEqual([]);
    expect(graph.dynamic).toEqual([]);
  });

  it('stays inside the dashboard sources plus the layout entry', () => {
    expect(graph.files).toEqual(
      expect.arrayContaining(['src/components/JobTileSection.tsx', 'src/components/TilePreview.tsx']),
    );
    expect(graph.files.filter((file) => file.startsWith('src/') === false)).toEqual([]);
  });

  it('includes the seam editor modules (049d) and no flag-off module', () => {
    expect(graph.files).toEqual([
      // Type-only leaf reached through types.ts (generated OpenAPI types, no runtime imports).
      'src/api/schema.ts',
      'src/api/tiling.ts',
      'src/api/types.ts',
      'src/components/JobTileSection.tsx',
      'src/components/TilePreview.tsx',
      'src/components/TileSeamHandles.tsx',
      'src/components/tilePreviewStrings.ts',
      'src/components/tileSeams.module.css',
      'src/components/ui.module.css',
    ]);
    expect(graph.files).not.toContain('src/strings.ts');
    expect(graph.files.some((file) => file.startsWith('src/api/') && /queries|client/.test(file))).toBe(false);
  });

  it('reaches no pdf-lib through the layout entry either', () => {
    const layout = walk(layoutSourceEntry());
    expect(layout.files.some((file) => file.endsWith('pdf.ts'))).toBe(false);
    expect(layout.files.some((file) => file.endsWith('index.ts'))).toBe(false);
    expect(layout.bare).toEqual([]);
  });

  it('detects pdf-lib from the tile package root (positive control)', () => {
    const root = walk(resolve(TILE_PACKAGE, 'src/index.ts'));
    expect(root.bare.filter((imp) => isPdfLib(imp.specifier)).length).toBeGreaterThan(0);
  });
});

describe('flag-on job page wiring', () => {
  const page = resolve(SRC_DIR, 'pages/JobDetailTilePage.tsx');

  it('loads JobTileSection with import() only', () => {
    const graph = walk(page);
    expect(graph.files).not.toContain('src/components/JobTileSection.tsx');
    expect(graph.bare.filter((imp) => imp.specifier.startsWith('@bax-print/'))).toEqual([]);
    expect(matches(readFileSync(page, 'utf8'), [DYNAMIC_PATTERN])).toEqual(['../components/JobTileSection']);
  });

  it('guards the lazy import with __BPS_TILE_PREVIEW__', () => {
    expect(readFileSync(page, 'utf8')).toMatch(
      /if \(__BPS_TILE_PREVIEW__\) return lazy\(\(\) => import\('\.\.\/components\/JobTileSection'\)\);/,
    );
  });

  it('is swapped in for App.tsx’s job detail import and nothing else', () => {
    const app = resolve(SRC_DIR, 'App.tsx');
    expect(readFileSync(app, 'utf8')).toContain(`from '${JOB_DETAIL_IMPORT}'`);
    expect(tilePreviewPageTarget(ROOT, JOB_DETAIL_IMPORT, app.replace(/\\/g, '/'))).toBe(page.replace(/\\/g, '/'));
    expect(tilePreviewPageTarget(ROOT, './JobDetailPage', page)).toBeNull();
    expect(tilePreviewPageTarget(ROOT, JOB_DETAIL_IMPORT, resolve(SRC_DIR, 'main.tsx'))).toBeNull();
    expect(tilePreviewPageTarget(ROOT, JOB_DETAIL_IMPORT, undefined)).toBeNull();
  });
});
