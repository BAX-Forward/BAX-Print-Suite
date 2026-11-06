// @vitest-environment node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { normalizePath, type UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_UPLOAD_ENV, jobUploadFlag, TILE_PREVIEW_ENV } from '../src/lib/buildFlags';
import { JOBS_PAGE_IMPORT, jobUploadPageTarget } from '../src/lib/jobUploadPage';
import viteConfig from '../vite.config';

/**
 * Spec 052b: BPS_DASHBOARD_JOB_UPLOAD is read at build time (unset is off, exactly "1" is on, the
 * rest stop the build). With it off vite.config.ts installs no extra plugin, so the module graph of
 * src/main.tsx — and with it the flag-off dist — never reaches the upload modules.
 */

const DASHBOARD_DIR = normalizePath(fileURLToPath(new URL('..', import.meta.url)));
const PAGE_PLUGIN = 'bps-job-upload-page';
const UPLOAD_MODULES = [
  'src/pages/JobsUploadPage.tsx',
  'src/components/JobUploadButton.tsx',
  'src/components/jobUploadStrings.ts',
  'src/api/uploadClient.ts',
].map((file) => normalizePath(resolve(DASHBOARD_DIR, file)));

afterEach(() => {
  vi.unstubAllEnvs();
});

function withoutEnv<T>(name: string, run: () => T): T {
  const saved = process.env[name];
  delete process.env[name];
  try {
    return run();
  } finally {
    if (saved !== undefined) process.env[name] = saved;
  }
}

function build(): UserConfig {
  return viteConfig({ command: 'build', mode: 'production' });
}

function pluginNames(config: UserConfig): string[] {
  return (config.plugins ?? [])
    .flat()
    .flatMap((plugin) =>
      typeof plugin === 'object' && plugin !== null && 'name' in plugin && typeof plugin.name === 'string'
        ? [plugin.name]
        : [],
    );
}

const SPECIFIERS = [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /^\s*import\s*['"]([^'"]+)['"]/gm];
const SOURCE_FILE = /\.tsx?$/;
const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveRelative(importer: string, specifier: string): string | null {
  const base = resolve(dirname(importer), specifier.replace(/\?.*$/, ''));
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return normalizePath(candidate);
  }
  return null;
}

/**
 * Every project file reachable from `entry` through relative static or dynamic imports, as plain
 * Vite resolves them without the 052b plugin. Comment text may add files, never hide one.
 */
function moduleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [normalizePath(entry)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!SOURCE_FILE.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const pattern of SPECIFIERS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier === undefined || !specifier.startsWith('.')) continue;
        const target = resolveRelative(file, specifier);
        if (target !== null) pending.push(target);
      }
    }
  }
  return seen;
}

/**
 * The JavaScript a module contributes to the bundle: types and comments erased, string literals
 * kept. Generated docs (e.g. schema.ts descriptions copied from the server) never reach dist.
 */
function emittedCode(file: string): string {
  return ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      removeComments: true,
    },
  }).outputText;
}

describe('jobUploadFlag', () => {
  it('is off when unset and on for exactly "1"', () => {
    expect(jobUploadFlag({})).toBe(false);
    expect(jobUploadFlag({ [JOB_UPLOAD_ENV]: '1' })).toBe(true);
    // Independent of the tile preview flag.
    expect(jobUploadFlag({ [TILE_PREVIEW_ENV]: '1' })).toBe(false);
  });

  it.each(['0', 'true', ' 1', '1 ', '', 'yes', 'on'])('rejects %j', (value) => {
    expect(() => jobUploadFlag({ [JOB_UPLOAD_ENV]: value })).toThrow(
      `${JOB_UPLOAD_ENV} must be unset or exactly "1" (got ${JSON.stringify(value)})`,
    );
  });
});

describe('job upload build wiring', () => {
  it('adds no plugin, define or resolve setting with the flag off', () => {
    const config = withoutEnv(JOB_UPLOAD_ENV, () => withoutEnv(TILE_PREVIEW_ENV, build));
    expect(pluginNames(config)).not.toContain(PAGE_PLUGIN);
    expect(config.define).toEqual({ __BPS_TILE_PREVIEW__: 'false' });
    expect(config.resolve).toBeUndefined();
  });

  it('swaps in the upload job list with the flag on', () => {
    vi.stubEnv(JOB_UPLOAD_ENV, '1');
    expect(pluginNames(build())).toContain(PAGE_PLUGIN);
  });

  it.each(['0', 'true', ' 1'])('stops the build for %j', (value) => {
    vi.stubEnv(JOB_UPLOAD_ENV, value);
    expect(build).toThrow(JOB_UPLOAD_ENV);
  });

  it('redirects only App.tsx’s job list import', () => {
    const app = normalizePath(join(DASHBOARD_DIR, 'src/App.tsx'));
    const uploadPage = UPLOAD_MODULES[0];
    expect(jobUploadPageTarget(DASHBOARD_DIR, JOBS_PAGE_IMPORT, app)).toBe(uploadPage);
    // JobsUploadPage itself imports './JobsPage', and any other importer resolves as usual.
    expect(jobUploadPageTarget(DASHBOARD_DIR, JOBS_PAGE_IMPORT, uploadPage)).toBeNull();
    expect(jobUploadPageTarget(DASHBOARD_DIR, './pages/JobDetailPage', app)).toBeNull();
    expect(jobUploadPageTarget(DASHBOARD_DIR, JOBS_PAGE_IMPORT, undefined)).toBeNull();
  });
});

describe('flag-off module graph', () => {
  const graph = moduleGraph(join(DASHBOARD_DIR, 'src/main.tsx'));

  it('reaches the job list through App.tsx', () => {
    expect(graph).toContain(normalizePath(join(DASHBOARD_DIR, 'src/App.tsx')));
    expect(graph).toContain(normalizePath(join(DASHBOARD_DIR, 'src/pages/JobsPage.tsx')));
  });

  it('never imports an upload module, statically or lazily', () => {
    for (const file of UPLOAD_MODULES) expect(graph).not.toContain(file);
  });

  it('carries none of the upload strings or the header name in src/', () => {
    // mock/ is reached only through main.tsx's mock-mode import, which production builds drop.
    const srcDir = `${normalizePath(join(DASHBOARD_DIR, 'src'))}/`;
    const offenders = [...graph]
      .filter((file) => file.startsWith(srcDir) && SOURCE_FILE.test(file))
      .filter((file) => /x-bps-job-name|jobUploadStrings|uploadClient/.test(emittedCode(file)));
    expect(offenders).toEqual([]);
  });
});
