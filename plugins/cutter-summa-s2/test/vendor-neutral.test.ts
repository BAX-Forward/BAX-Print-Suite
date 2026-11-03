// Vendor-neutral check (spec 004 acceptance 12, AGENTS.md "Package layout"):
// no manufacturer, model or device command language names in core packages.
// It lives in a plugin so the deny-list itself never appears in packages/.
// HP-GL/2 and DXF are public standards and are allowed in core.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES_DIR = fileURLToPath(new URL("../../../packages/", import.meta.url));
const SCANNED = /\.(ts|tsx|js|mjs|cjs|json)$/;
const SKIPPED_DIRS = /(^|[\\/])(node_modules|dist|coverage)([\\/]|$)/;
const DENY = /\b(summa|goproduce|opos|dm\/?pl|graphtec|roland|mimaki|z[uü]nd|kongsberg|esko|latex)\b/i;

async function coreFiles(): Promise<string[]> {
  const packages = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const files: string[] = [];
  for (const pkg of packages.filter((d) => d.isDirectory())) {
    const root = join(PACKAGES_DIR, pkg.name);
    const entries = await readdir(root, { recursive: true });
    for (const entry of entries) {
      if (SCANNED.test(entry) && !SKIPPED_DIRS.test(entry)) files.push(join(root, entry));
    }
  }
  return files;
}

describe("vendor-neutral core", () => {
  it("finds no vendor, model or vendor-language names in packages/", async () => {
    const files = await coreFiles();
    expect(files.some((f) => f.includes(join("cut-export", "src")))).toBe(true);
    expect(files.some((f) => f.includes(join("plugin-sdk", "src")))).toBe(true);
    const hits: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        const match = DENY.exec(line);
        if (match) hits.push(`${file}:${i + 1}: ${match[0]}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
