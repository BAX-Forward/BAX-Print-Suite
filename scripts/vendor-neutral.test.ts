import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMatcher, findTerms, loadVendorNames, scanRepository, type VendorNames } from './vendor-neutral.js';

const NAMES: VendorNames = { names: ['acme', 'acme-gl'] };

describe('vendor-neutral matcher', () => {
  it('matches whole words case-insensitively, longest name first', () => {
    const matcher = buildMatcher(NAMES.names);
    expect(findTerms('ACME driver\nuses acme-gl output', matcher, 'f.ts')).toEqual([
      { file: 'f.ts', line: 1, term: 'ACME' },
      { file: 'f.ts', line: 2, term: 'acme-gl' },
    ]);
    expect(findTerms('acmes and subacme are other words', matcher, 'f.ts')).toEqual([]);
  });

  it('refuses an empty name list', () => {
    expect(() => buildMatcher([' '])).toThrow();
  });

  it('loads the shared name list', async () => {
    expect((await loadVendorNames()).names.length).toBeGreaterThan(10);
  });
});

describe('scanRepository', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bps-vendor-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('flags names in the scanned roots but never in other dirs or node_modules', async () => {
    await mkdir(join(root, 'packages', 'core', 'src'), { recursive: true });
    await mkdir(join(root, 'packages', 'core', 'node_modules'), { recursive: true });
    await mkdir(join(root, 'plugins', 'acme'), { recursive: true });
    await writeFile(join(root, 'packages', 'core', 'src', 'device.ts'), 'export const neutral = 1;\n// Acme only\n');
    await writeFile(join(root, 'packages', 'core', 'node_modules', 'dep.js'), 'acme');
    await writeFile(join(root, 'plugins', 'acme', 'index.ts'), 'acme');

    expect(await scanRepository(root, ['packages', 'missing'], NAMES)).toEqual([
      { file: 'packages/core/src/device.ts', line: 2, term: 'Acme' },
    ]);
  });
});
