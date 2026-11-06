/**
 * Spec 049b: `@bax-print/tile/layout` is the pure layout entry. Walk the static
 * import graph from src/layout.ts and check that it never reaches pdf.ts or a
 * bare package (pdf-lib in particular), and that every export is the same
 * binding the package root exports.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as index from "../src/index.js";
import * as layout from "../src/layout.js";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

/** Bare specifiers the layout graph may import. Empty: layout is self-contained. */
const ALLOWED_BARE: readonly string[] = [];

/** Root exports that layout leaves out on purpose. */
const EXCLUDED_FROM_LAYOUT = new Set(["panelPdf"]);

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  // import x from "..."; import type { a } from "..."; export { a } from "..."; spans lines.
  /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
  // import "...";
  /^\s*import\s*["']([^"']+)["']/gm,
  // import("...")
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

interface BareImport {
  file: string;
  specifier: string;
}

interface ImportGraph {
  /** Visited files, relative to src/, sorted. */
  files: string[];
  bare: BareImport[];
}

const rel = (file: string): string => relative(SRC_DIR, file);

function specifiers(source: string): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...source.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])),
  );
}

function walk(entry: string): ImportGraph {
  const seen = new Set<string>();
  const bare: BareImport[] = [];
  const queue = [resolve(SRC_DIR, entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    if (existsSync(file) === false) throw new Error(`unresolved import: ${rel(file)}`);
    seen.add(file);
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
      else bare.push({ file: rel(file), specifier });
    }
  }
  return { files: [...seen].map(rel).sort(), bare };
}

const isPdfLib = (specifier: string): boolean => specifier === "pdf-lib" || specifier.startsWith("pdf-lib/");

describe("layout import graph", () => {
  const graph = walk("layout.ts");

  it("follows single-line and multi-line re-exports", () => {
    // marks, nest-item and template are only reachable through multi-line `export { ... } from`.
    expect(graph.files).toEqual(
      expect.arrayContaining(["layout.ts", "types.ts", "tile.ts", "suggest.ts", "select.ts", "marks.ts", "nest-item.ts", "template.ts"]),
    );
  });

  it("never reaches pdf.ts or the package root", () => {
    expect(graph.files).not.toContain("pdf.ts");
    expect(graph.files).not.toContain("index.ts");
  });

  it("imports no pdf-lib and no bare specifier outside the allowlist", () => {
    expect(graph.bare.filter((imp) => isPdfLib(imp.specifier))).toEqual([]);
    expect(graph.bare.filter((imp) => ALLOWED_BARE.includes(imp.specifier) === false)).toEqual([]);
  });

  it("detects pdf-lib when walking from the package root (positive control)", () => {
    const root = walk("index.ts");
    expect(root.files).toContain("pdf.ts");
    expect(root.bare.filter((imp) => isPdfLib(imp.specifier)).map((imp) => imp.file)).toEqual(["pdf.ts"]);
  });
});

describe("layout exports", () => {
  const rootExports = new Map(Object.entries(index));
  const layoutExports = Object.entries(layout);

  it("exports the same bindings as the package root", () => {
    expect(layoutExports.length).toBeGreaterThan(0);
    for (const [name, value] of layoutExports) {
      expect(rootExports.has(name), name).toBe(true);
      expect(rootExports.get(name), name).toBe(value);
    }
  });

  it("exports every runtime root binding except panelPdf", () => {
    const expected = [...rootExports.keys()].filter((name) => EXCLUDED_FROM_LAYOUT.has(name) === false).sort();
    expect(layoutExports.map(([name]) => name).sort()).toEqual(expected);
    expect("panelPdf" in layout).toBe(false);
    expect(typeof index.panelPdf).toBe("function");
  });
});
