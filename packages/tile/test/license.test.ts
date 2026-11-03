/**
 * Acceptance (licence check): every direct dependency of this package carries
 * a licence on the allowlist in docs/LICENSING.md §1. Transitive dependencies
 * are covered by the repository SBOM check in CI.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ALLOWLIST = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "Zlib",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "MPL-2.0",
]);

const readJson = (url: URL): Record<string, unknown> => JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;

const manifest = readJson(new URL("../package.json", import.meta.url));
const names = [
  ...Object.keys((manifest.dependencies as Record<string, string> | undefined) ?? {}),
  ...Object.keys((manifest.devDependencies as Record<string, string> | undefined) ?? {}),
];

describe("licence allowlist", () => {
  it("this package is Apache-2.0", () => {
    expect(manifest.license).toBe("Apache-2.0");
  });

  it("pins every dependency to an exact version", () => {
    const versions = {
      ...(manifest.dependencies as Record<string, string> | undefined),
      ...(manifest.devDependencies as Record<string, string> | undefined),
    };
    for (const [name, version] of Object.entries(versions)) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(names)("%s is on the allowlist", (name) => {
    const installed = readJson(new URL(`../node_modules/${name}/package.json`, import.meta.url));
    expect(ALLOWLIST.has(String(installed.license)), `${name}: ${String(installed.license)}`).toBe(true);
  });
});
