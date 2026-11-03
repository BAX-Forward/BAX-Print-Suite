/**
 * Acceptance (vendor-neutral check): no vendor, model or device command
 * language names anywhere in this core package (ARCHITECTURE §3.8). The name
 * list lives outside packages/ in scripts/vendor-names.json, shared with the
 * repository-wide check from Spec 001, so this file names no vendor itself.
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const NAMES_FILE = new URL("../../../scripts/vendor-names.json", import.meta.url);

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage"]);
const TEXT_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".yaml", ".yml"]);

const names = (JSON.parse(readFileSync(NAMES_FILE, "utf8")) as { names: string[] }).names;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Whole-word, case-insensitive: `widthPt` must not match a two-letter name. */
function matcher(list: readonly string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

/** Text files under `dir`; symlinks are not followed, so linked dependencies are skipped. */
function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : textFiles(path);
    return entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

describe("vendor-neutral check", () => {
  const pattern = matcher(names);

  it("has a non-trivial name list and a matcher that ignores substrings", () => {
    expect(names.length).toBeGreaterThan(10);
    const sample = names[0];
    expect(pattern.test(`driver for ${sample} devices`)).toBe(true);
    expect(pattern.test(`x${sample.toLowerCase()}y`)).toBe(false);
  });

  it("finds no vendor names in packages/tile", () => {
    const files = textFiles(PACKAGE_DIR);
    expect(files.length).toBeGreaterThan(10);

    const hits: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const match = pattern.exec(line);
          if (match) hits.push(`${relative(PACKAGE_DIR, file)}:${i + 1}: ${match[0]}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
