import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * License check (docs/LICENSING.md §1): every production dependency of every workspace
 * package, transitively, must carry a license on the allowlist in `license-allowlist.json`.
 * Dev dependencies are not shipped and are not checked.
 *
 * Run after `pnpm install`: `pnpm check:licenses` (`tsx scripts/check-licenses.ts`)
 */

export interface Allowlist {
  allowed: string[];
  /** Package name → reason, for maintainer-approved exceptions. */
  exceptions: Record<string, string>;
}

interface Manifest {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface LicenseProblem {
  name: string;
  version: string;
  license: string;
  requiredBy: string;
}

const WORKSPACE_DIRS = ["packages", "plugins", "apps"];

/** The declared license as an SPDX expression, from `license` or the legacy `licenses` array. */
export function declaredLicense(manifest: Manifest): string | undefined {
  const { license, licenses } = manifest;
  if (typeof license === "string") return license.trim();
  if (license && typeof license === "object" && typeof (license as { type?: unknown }).type === "string") {
    return (license as { type: string }).type.trim();
  }
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((l) => (typeof l === "string" ? l : (l as { type?: unknown })?.type))
      .filter((t): t is string => typeof t === "string");
    if (types.length > 0) return types.length === 1 ? types[0] : `(${types.join(" OR ")})`;
  }
  return undefined;
}

/**
 * True when the SPDX expression is satisfiable with allowed licenses: some `OR` alternative
 * whose `AND` terms are all allowed. Parentheses are flattened, which is exact for the
 * expressions that occur in practice (`A OR B`, `(A AND B)`, `(A OR B) AND C` is treated
 * conservatively as needing every term).
 */
export function isAllowedExpression(expression: string, allowed: ReadonlySet<string>): boolean {
  const normalized = expression.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return false;
  const nestedOr = /\)\s*AND|AND\s*\(/.test(normalized);
  const flat = normalized.replace(/[()]/g, "").trim();
  if (nestedOr) return flat.split(/ (?:AND|OR) /).every((term) => allowed.has(term.replace(/\+$/, "").trim()));
  return flat.split(" OR ").some((alternative) => alternative.split(" AND ").every((term) => allowed.has(term.replace(/\+$/, "").trim())));
}

async function readManifest(dir: string): Promise<Manifest> {
  return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as Manifest;
}

/** Node's lookup: `node_modules/<name>` in this directory or an ancestor. */
async function findPackageDir(fromDir: string, name: string): Promise<string | undefined> {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return realpath(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function workspacePackages(root: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const group of WORKSPACE_DIRS) {
    const base = path.join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const dir = path.join(base, entry.name);
      if (entry.isDirectory() && existsSync(path.join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs;
}

function productionDeps(manifest: Manifest): [string, string][] {
  return Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies });
}

export async function checkLicenses(root: string, allowlist: Allowlist): Promise<{ checked: number; problems: LicenseProblem[]; missing: string[] }> {
  const allowed = new Set(allowlist.allowed);
  const problems: LicenseProblem[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const queue: { dir: string; requiredBy: string }[] = [];

  for (const dir of await workspacePackages(root)) {
    const manifest = await readManifest(dir);
    const name = manifest.name ?? path.relative(root, dir);
    const license = declaredLicense(manifest);
    if (!license || !isAllowedExpression(license, allowed)) {
      problems.push({ name, version: manifest.version ?? "", license: license ?? "(none)", requiredBy: "workspace" });
    }
    for (const [dep, range] of productionDeps(manifest)) {
      if (range.startsWith("workspace:")) continue;
      const depDir = await findPackageDir(dir, dep);
      if (depDir) queue.push({ dir: depDir, requiredBy: name });
      else if (!manifest.optionalDependencies?.[dep]) missing.push(`${dep} (required by ${name})`);
    }
  }

  while (queue.length > 0) {
    const { dir, requiredBy } = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = await readManifest(dir);
    const name = manifest.name ?? dir;
    const license = declaredLicense(manifest);
    if (!Object.hasOwn(allowlist.exceptions, name) && (!license || !isAllowedExpression(license, allowed))) {
      problems.push({ name, version: manifest.version ?? "", license: license ?? "(none)", requiredBy });
    }
    for (const [dep] of productionDeps(manifest)) {
      const depDir = await findPackageDir(dir, dep);
      // Optional dependencies for other platforms are legitimately absent.
      if (depDir) queue.push({ dir: depDir, requiredBy: name });
      else if (!manifest.optionalDependencies?.[dep]) missing.push(`${dep} (required by ${name})`);
    }
  }
  return { checked: seen.size, problems, missing };
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const allowlist = JSON.parse(await readFile(path.join(here, "license-allowlist.json"), "utf8")) as Allowlist;
  const { checked, problems, missing } = await checkLicenses(root, allowlist);
  for (const m of missing) console.error(`not installed: ${m} (run pnpm install first)`);
  for (const p of problems) console.error(`${p.name}@${p.version}: license ${p.license} is not on the allowlist (required by ${p.requiredBy})`);
  if (problems.length > 0 || missing.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(`licenses: ok (${checked} production dependencies)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
