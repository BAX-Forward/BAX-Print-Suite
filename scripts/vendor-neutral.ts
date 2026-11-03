import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shape of the shared name list in scripts/vendor-names.json (Spec 009). */
export interface VendorNames {
  readonly names: readonly string[];
}

export interface VendorFinding {
  readonly file: string;
  readonly line: number;
  readonly term: string;
}

/** Core directories added by Spec 008; the default scan set of `pnpm check:vendor-neutral`. */
export const SPEC_008_ROOTS: readonly string[] = [
  'packages/core',
  'packages/events',
  'packages/store',
  'packages/archive',
  'apps/server',
];

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo']);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml', '.html', '.css']);

export const VENDOR_NAMES_FILE = fileURLToPath(new URL('./vendor-names.json', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export async function loadVendorNames(path: string = VENDOR_NAMES_FILE): Promise<VendorNames> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<VendorNames>;
  if (!Array.isArray(parsed.names) || !parsed.names.every((name) => typeof name === 'string')) {
    throw new Error(`${path} must contain a "names" string array`);
  }
  return { names: parsed.names };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** One case-insensitive matcher; a name only matches as a whole word (not inside `summary` or `canonical`). */
export function buildMatcher(names: readonly string[]): RegExp {
  const terms = names
    .map((term) => term.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (terms.length === 0) throw new Error('vendor-neutral check needs at least one name');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

export function findTerms(text: string, matcher: RegExp, file: string): VendorFinding[] {
  const findings: VendorFinding[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(matcher)) {
      findings.push({ file, line: index + 1, term: match[0] });
    }
  }
  return findings;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

/** Scans `roots` (relative to `repoRoot`). Symlinks are not followed, so linked dependencies are skipped. */
export async function scanRepository(
  repoRoot: string,
  roots: readonly string[],
  vendorNames: VendorNames,
): Promise<VendorFinding[]> {
  const matcher = buildMatcher(vendorNames.names);
  const findings: VendorFinding[] = [];
  for (const root of roots) {
    for (const file of await listFiles(join(repoRoot, root))) {
      const text = await readFile(file, 'utf8');
      findings.push(...findTerms(text, matcher, relative(repoRoot, file).split(sep).join('/')));
    }
  }
  return findings;
}
