import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Allowlist, checkLicenses, declaredLicense, isAllowedExpression } from './check-licenses.js';

const ALLOWLIST: Allowlist = { allowed: ['MIT', 'ISC', 'Apache-2.0', 'MPL-2.0'], exceptions: {} };

async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
}

describe('license expressions', () => {
  const allowed = new Set(ALLOWLIST.allowed);

  it('accepts an allowed OR alternative and rejects copyleft-only expressions', () => {
    expect(isAllowedExpression('MIT', allowed)).toBe(true);
    expect(isAllowedExpression('(GPL-3.0-only OR MIT)', allowed)).toBe(true);
    expect(isAllowedExpression('MIT AND ISC', allowed)).toBe(true);
    expect(isAllowedExpression('MIT AND GPL-3.0', allowed)).toBe(false);
    expect(isAllowedExpression('GPL-3.0', allowed)).toBe(false);
    expect(isAllowedExpression('', allowed)).toBe(false);
  });

  it('reads the license field in its current and legacy shapes', () => {
    expect(declaredLicense({ license: ' MIT ' })).toBe('MIT');
    expect(declaredLicense({ license: { type: 'ISC' } })).toBe('ISC');
    expect(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('(MIT OR Apache-2.0)');
    expect(declaredLicense({})).toBeUndefined();
  });

  it('keeps GPL-family licenses off the shipped allowlist', async () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'license-allowlist.json');
    const shipped = JSON.parse(await readFile(file, 'utf8')) as Allowlist;
    expect(shipped.allowed).toContain('Apache-2.0');
    expect(shipped.allowed.filter((l) => /GPL|SSPL|BUSL/i.test(l))).toEqual([]);
  });
});

describe('checkLicenses on a fixture workspace', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bps-licenses-'));
    // packages/app: allowed prod dep (with a hoisted transitive dep) and a GPL dev-only dep.
    const app = join(root, 'packages', 'app');
    await writeManifest(app, {
      name: '@fixture/app',
      version: '0.0.0',
      license: 'Apache-2.0',
      dependencies: { 'ok-dep': '1.0.0', '@fixture/lib': 'workspace:*' },
      devDependencies: { 'gpl-dev': '1.0.0' },
    });
    await writeManifest(join(app, 'node_modules', 'ok-dep'), {
      name: 'ok-dep',
      version: '1.0.0',
      license: 'MIT',
      dependencies: { 'deep-dep': '1.0.0' },
    });
    await writeManifest(join(root, 'node_modules', 'deep-dep'), { name: 'deep-dep', version: '1.0.0', license: 'ISC' });
    await writeManifest(join(app, 'node_modules', 'gpl-dev'), { name: 'gpl-dev', version: '1.0.0', license: 'GPL-3.0' });
    await writeManifest(join(root, 'apps', 'lib'), { name: '@fixture/lib', version: '0.0.0', license: 'Apache-2.0' });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes allowed prod deps (transitively) and ignores dev-only GPL deps', async () => {
    const result = await checkLicenses(root, ALLOWLIST);
    expect(result.problems).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.checked).toBe(2);
  });

  it('fails on a GPL-3.0 production dep in any workspace package', async () => {
    const server = join(root, 'apps', 'server');
    await writeManifest(server, {
      name: '@fixture/server',
      version: '0.0.0',
      license: 'Apache-2.0',
      dependencies: { 'gpl-prod': '2.0.0' },
    });
    await writeManifest(join(server, 'node_modules', 'gpl-prod'), { name: 'gpl-prod', version: '2.0.0', license: 'GPL-3.0' });

    const result = await checkLicenses(root, ALLOWLIST);
    expect(result.problems).toEqual([
      { name: 'gpl-prod', version: '2.0.0', license: 'GPL-3.0', requiredBy: '@fixture/server' },
    ]);
  });

  it('fails on a GPL-3.0 dep reached transitively through an allowed one', async () => {
    await writeManifest(join(root, 'packages', 'app', 'node_modules', 'ok-dep'), {
      name: 'ok-dep',
      version: '1.0.0',
      license: 'MIT',
      dependencies: { 'deep-dep': '1.0.0', 'gpl-deep': '1.0.0' },
    });
    await writeManifest(join(root, 'node_modules', 'gpl-deep'), { name: 'gpl-deep', version: '1.0.0', license: 'GPL-3.0-only' });

    const result = await checkLicenses(root, ALLOWLIST);
    expect(result.problems.map((p) => [p.name, p.requiredBy])).toEqual([['gpl-deep', 'ok-dep']]);
  });

  it('reports a production dep that is not installed', async () => {
    await writeManifest(join(root, 'packages', 'bare'), {
      name: '@fixture/bare',
      license: 'Apache-2.0',
      dependencies: { absent: '1.0.0' },
    });
    const result = await checkLicenses(root, ALLOWLIST);
    expect(result.missing).toEqual(['absent (required by @fixture/bare)']);
  });

  it('honors a maintainer-approved exception', async () => {
    await writeManifest(join(root, 'packages', 'app', 'node_modules', 'ok-dep'), {
      name: 'ok-dep',
      version: '1.0.0',
      license: 'GPL-3.0',
    });
    const result = await checkLicenses(root, { ...ALLOWLIST, exceptions: { 'ok-dep': 'test exception' } });
    expect(result.problems).toEqual([]);
  });
});
