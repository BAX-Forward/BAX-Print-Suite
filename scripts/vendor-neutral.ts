import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shape of the shared name list in scripts/vendor-names.json (Spec 009). */
export interface VendorNames {
  readonly names: readonly string[];
  /** Exact, case-sensitive tokens that are allowed even though they match `names` (standard command languages). */
  readonly allowedTokens?: readonly string[];
}

export interface VendorFinding {
  readonly file: string;
  readonly line: number;
  readonly term: string;
}

/** Every directory under these groups is core code and is scanned by default. */
export const CORE_GROUPS: readonly string[] = ['packages', 'apps'];
/** Never scanned by default: vendor names belong here. */
export const EXEMPT_ROOTS: readonly string[] = ['plugins', 'docs/research'];

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo']);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml', '.html', '.css']);

export const VENDOR_NAMES_FILE = fileURLToPath(new URL('./vendor-names.json', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export async function loadVendorNames(path: string = VENDOR_NAMES_FILE): Promise<VendorNames> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<VendorNames>;
  if (!Array.isArray(parsed.names) || !parsed.names.every((name) => typeof name === 'string')) {
    throw new Error(`${path} must contain a "names" string array`);
  }
  const raw = (parsed as { allowedCommandLanguages?: { tokens?: unknown } }).allowedCommandLanguages?.tokens ?? [];
  if (!Array.isArray(raw) || !raw.every((token) => typeof token === 'string')) {
    throw new Error(`${path} allowedCommandLanguages.tokens must be a string array`);
  }
  return { names: parsed.names, allowedTokens: raw };
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

async function readDirIfExists(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
}

/** The default scan set of `pnpm check:vendor-neutral`: every `packages/*` and `apps/*` directory, sorted. */
export async function defaultRoots(repoRoot: string): Promise<string[]> {
  const roots: string[] = [];
  for (const group of CORE_GROUPS) {
    for (const entry of await readDirIfExists(join(repoRoot, group))) {
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) roots.push(`${group}/${entry.name}`);
    }
  }
  return roots.sort();
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readDirIfExists(dir);
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
  const allowed = new Set(vendorNames.allowedTokens ?? []);
  const findings: VendorFinding[] = [];
  for (const root of roots) {
    for (const file of await listFiles(join(repoRoot, root))) {
      const text = await readFile(file, 'utf8');
      const found = findTerms(text, matcher, relative(repoRoot, file).split(sep).join('/'));
      findings.push(...found.filter((finding) => !allowed.has(finding.term)));
    }
  }
  return findings;
}
