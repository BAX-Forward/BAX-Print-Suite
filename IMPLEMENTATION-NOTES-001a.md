# Implementation notes: Sub-spec 001a (root tooling)

## Built
- **check:licenses**: `package.json` runs `tsx scripts/check-licenses.ts`. The script walks every workspace package under `packages/`, `plugins/` and `apps/`, follows `dependencies` and `optionalDependencies` transitively through `node_modules` (resolving pnpm symlinks with realpath), and exits 1 if a license is not in `scripts/license-allowlist.json` or a required production dependency is not installed. It does not check dev dependencies. `exceptions` holds per-package approvals that a maintainer has signed off. The `license-checker-rseidelsohn` devDependency is removed.
- **docs/LICENSING.md §1**: there is now one MPL-2.0 rule. It is allowed only as an unmodified third-party dependency, and today that means only the dev-only `@axe-core/playwright` and `axe-core`. The duplicate line is gone.
- **check:vendor-neutral**: `defaultRoots(repoRoot)` in `scripts/vendor-neutral.ts` returns every directory under `packages/` and `apps/`, sorted. `EXEMPT_ROOTS` (`plugins`, `docs/research`) are never part of the default set. `SPEC_008_ROOTS` is removed, and `scripts/check-vendor-neutral.ts` uses the computed list when it gets no arguments.

## Tests
- `scripts/check-licenses.test.ts`: in a fixture workspace, a GPL-3.0 prod dependency fails, a GPL-3.0 dependency reached transitively fails, a dev-only GPL dependency passes, and allowed dependencies pass (including a hoisted transitive one). Also covers a missing dependency, exceptions, SPDX expressions, and the shipped allowlist containing no GPL.
- `scripts/vendor-neutral.test.ts`: the default roots include every `packages/*` and `apps/*` dir and exclude `plugins/` and `docs/research/`. A vendor name planted in `apps/x` is reported, and the existing tests are unchanged.

## Commands
```
pnpm install
pnpm test:scripts
pnpm check:licenses
pnpm check:vendor-neutral
```

## Deferred / caveats
- None of this has been run yet; the authoring session had no shell.
- Assumes `scripts/vitest.config.ts` picks up `scripts/*.test.ts`. This file was not inspected.
- The wider default scan (for example `apps/dashboard`) may turn up existing names that need to move to plugins/.
- The `lint` script still lists directories explicitly. That is out of scope for 001a.
- SPDX `WITH` exceptions are not parsed and are treated as not allowed (conservative).

## Command-language allowlist

`scripts/vendor-names.json` lists `allowedCommandLanguages.tokens` (HPGL, hpgl, HP-GL/2). HP-GL/2 is the de facto standard cutter command language, so a generic encoder lives in packages/cut-export. Only exact, case-sensitive matches are skipped; a bare vendor name, a model name or a variant like HP-GL is still flagged outside plugins/.
